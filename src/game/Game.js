import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { RenderPipeline } from '../render/Pipeline.js';
import { Sky } from '../render/Sky.js';
import { Lighting } from '../render/Lighting.js';
import { Level } from '../world/Level.js';
import { Physics } from '../world/Physics.js';
import { MechFactory } from '../mech/MechFactory.js';
import { PlayerController } from '../player/PlayerController.js';
import { CameraRig } from '../player/CameraRig.js';
import { TargetingSystem } from '../player/TargetingSystem.js';
import { WeaponSystem } from '../combat/WeaponSystem.js';
import { ProjectileManager } from '../combat/ProjectileManager.js';
import { VFX } from '../combat/VFX.js';
import { DamageSystem } from '../combat/DamageSystem.js';
import { EnemyManager } from '../ai/EnemyManager.js';
import { LootSystem } from '../loot/LootSystem.js';
import { Loadout } from '../loot/Loadout.js';
import { HUD } from '../ui/HUD.js';
import { Garage } from '../ui/Garage.js';
import { AudioDirector } from '../audio/AudioDirector.js';
import { installDebug } from './Debug.js';

// Where the player's build and salvage live between sessions. The version is
// checked on load so a save written against a different part schema is
// ignored outright rather than half-applied — `Loadout.fromJSON` drops parts
// it does not recognise, but a wholesale format change is better restarted
// than salvaged.
const SAVE_KEY = 'acntr.save.v1';
const SAVE_VERSION = 1;

/**
 * Game wires every subsystem together and owns update order.
 *
 * Update order matters and is deliberate:
 *   1. input-derived intent      (PlayerController)
 *   2. AI intent                 (EnemyManager)
 *   3. physics integration       (Physics)
 *   4. weapons / projectiles     (WeaponSystem, ProjectileManager)
 *   5. damage resolution         (DamageSystem)
 *   6. vfx + loot                (VFX, LootSystem)
 *   7. late: camera, HUD, audio
 */
export class Game {
  constructor(engine, input) {
    this.engine = engine;
    this.input = input;
    this.scene = engine.scene;
    this.state = 'boot'; // boot | playing | garage | dead | victory
    this.entities = [];
  }

  async init() {
    const step = (t, label) => bus.emit(EV.BOOT_PROGRESS, { t, label });

    step(0.05, 'render pipeline');
    this.pipeline = new RenderPipeline(this.engine);
    this.engine.setPipeline(this.pipeline);

    step(0.15, 'atmosphere');
    this.sky = new Sky(this.scene, this.engine.renderer);
    this.lighting = new Lighting(this.scene, this.engine.renderer, this.sky);

    step(0.3, 'terrain + structures');
    this.physics = new Physics();
    this.level = new Level(this.scene, this.physics);
    await this.level.build();

    step(0.5, 'fabricating AC');
    this.mechFactory = new MechFactory();
    await this.mechFactory.init();

    this.loadout = new Loadout();
    // Restore the player's build and salvage BEFORE the mech is fabricated,
    // so the parts they are actually wearing are the ones that get built.
    this._restoreLoadout();
    this.player = this.mechFactory.buildPlayer(this.loadout);
    this.scene.add(this.player.root);

    this.controller = new PlayerController(this.player, this.input, this.physics, this.level);
    this.cameraRig = new CameraRig(this.engine.camera, this.player, this.input, this.physics);
    this.targeting = new TargetingSystem(this.engine.camera, this.player);
    // Targeting needs physics for line-of-sight lock breaking and for the aim
    // convergence raycast that makes arm-mounted weapons converge on what the
    // crosshair is actually over, and input for the Tab hard-lock toggle.
    this.targeting.setPhysics(this.physics);
    this.targeting.setInput(this.input);

    step(0.62, 'ordnance');
    this.vfx = new VFX(this.scene, this.engine.renderer);
    this.projectiles = new ProjectileManager(this.scene, this.physics, this.vfx);
    this.damage = new DamageSystem();
    this.weapons = new WeaponSystem(this.player, this.input, this.projectiles, this.targeting, this.vfx);

    step(0.75, 'hostiles');
    this.enemies = new EnemyManager(this.scene, this.mechFactory, this.physics, this.level, this.projectiles, this.vfx);
    this.enemies.setPlayer(this.player);
    this.targeting.setTargets(this.enemies.list);
    this.damage.register(this.player);

    // Projectiles need an explicit collision set and damage sink. Without this
    // the pooled projectiles fly correctly but pass through every entity, so
    // nothing in the game can actually be shot. `enemies.list` is held by
    // reference and stays live as waves spawn and die; the player is added
    // separately so enemy fire can hit us too.
    this.projectiles.setDamageSystem(this.damage);
    this.projectiles.setTargetList(this.enemies.list);
    this.projectiles.addTarget(this.player);

    // Build-derived stats only reach movement and weapons if we push the
    // loadout into them; neither reads it on its own.
    this.weapons.setLoadout(this.loadout);
    this.controller.setLoadout?.(this.loadout);

    this._wirePlayerThrusters();

    step(0.85, 'salvage protocol');
    this.loot = new LootSystem(this.scene, this.player, this.loadout, this.vfx);

    step(0.92, 'interface');
    this.hud = new HUD(document.getElementById('ui-root'), this);
    this.garage = new Garage(document.getElementById('ui-root'), this);

    step(0.97, 'audio');
    // Pass the game explicitly. AudioDirector will fall back to
    // window.__ACNTR__.game if we don't, but that global exists only because
    // the debug hook installs it — the continuous engine, servo and alarm
    // layers should not depend on a debug affordance to find the player.
    this.audio = new AudioDirector(this.engine.camera, { game: this });

    this._wire();
    this._registerLoop();
    this._wireSave();
    this.debug = installDebug(this);

    this.state = 'playing';
    step(1, 'ready');
    return this;
  }

  _wire() {
    // click-to-play pointer lock
    const canvas = this.engine.canvas;
    canvas.addEventListener('click', () => {
      if (this.state === 'playing') this.input.requestLock();
    });

    bus.on('input:unlocked', () => {
      if (this.state === 'playing') this.hud.setPaused(true);
    });
    bus.on('input:locked', () => this.hud.setPaused(false));

    bus.on(EV.ENTITY_KILLED, (e) => {
      if (e.entity === this.player) this._onPlayerDeath();
    });

    // See _wireVfxDepth: the soft-particle fade is deliberately off.
    this._vfxColorTex = null;
    this._wireVfxDepth();
    bus.on('engine:resize', () => this._wireVfxDepth());

    // The rig can conform the feet to terrain, but only if it is given a height
    // sampler. Nothing ever handed it one, so the AC stood on the flat plane its
    // legs assume rather than on the ground it is actually on.
    //
    // The obvious sampler is WRONG, and was: `Physics.groundHeight(x, z)`
    // answers with the HIGHEST static surface in that column, which under any
    // deck, gantry or bridge is a CEILING. The rig then tried to plant its feet
    // on it — measured on a spawn at y 18.6 where the sampler answered 26.5,
    // both legs solved to a full crouch and, before MechRig grew its own guard,
    // folded up over the mech's head. Several review frames were shot under a
    // catwalk, so this was not a corner case.
    //
    // Cast DOWN from just above the mech instead: that finds the surface it is
    // actually standing on. `groundHeight` remains the fallback for a foot
    // placed out past the level's collision geometry.
    if (this.physics?.raycast) {
      const from = new THREE.Vector3();
      const down = new THREE.Vector3(0, -1, 0);
      this.player?.rig?.setGroundSampler?.((x, z) => {
        from.set(x, this.player.root.position.y + 3.0, z);
        const hit = this.physics.raycast(from, down, 60);
        if (hit && hit.hit) return from.y - hit.distance;
        return this.physics.groundHeight?.(x, z) ?? this.player.root.position.y;
      });
    }

    // Persistent damage smoke. VFX has the whole system and it was never
    // attached to anything, so a mech at 20% AP looked exactly like a fresh
    // one — the single clearest read on how a fight is going, missing.
    this.vfx?.attachDamageSmoke?.(this.player);

    // Enemies get the same two treatments as they spawn. Reading how hurt a
    // target is matters more on THEM than on the player, whose AP is on the
    // HUD in numerals — an enemy's condition is only ever legible from how it
    // looks. EnemyManager announces both ends of the lifecycle, so the handle
    // is disposed rather than leaked when the wave is cleared.
    bus.on('ai:spawned', ({ entity }) => {
      if (!entity) return;
      if (this.physics?.raycast && entity.root) {
        const from = new THREE.Vector3();
        const down = new THREE.Vector3(0, -1, 0);
        entity.rig?.setGroundSampler?.((x, z) => {
          from.set(x, entity.root.position.y + 3.0, z);
          const hit = this.physics.raycast(from, down, 60);
          if (hit && hit.hit) return from.y - hit.distance;
          return this.physics.groundHeight?.(x, z) ?? entity.root.position.y;
        });
      }
      entity._damageSmoke = this.vfx?.attachDamageSmoke?.(entity) || null;
    });
    bus.on('ai:removed', ({ entity }) => {
      entity?._damageSmoke?.dispose?.();
      if (entity) entity._damageSmoke = null;
    });
  }

  /**
   * Soft-particle depth fade — DELIBERATELY LEFT OFF, and this is not an
   * oversight to be "fixed" by passing the obvious texture.
   *
   * I previously wired this to `pipeline.rtScene.depthTexture`, which is the
   * depth attachment of the very render target the VFX draws into. Sampling a
   * buffer you are simultaneously writing is a feedback loop, and it was
   * MEASURED: the renderer logs GL_INVALID_OPERATION on every single frame
   * while the pipeline is attached, and none while it is detached.
   *
   * With no texture, `uSoftParams.x` stays 0 and `softDepthFade()` returns 1.0,
   * so particles are fully opaque and simply intersect geometry with a hard
   * edge. That is a small visual cost and strictly better than a per-frame GL
   * error plus an undefined sample.
   *
   * To restore the feature properly, the pipeline has to COPY depth into a
   * texture the scene pass is not writing (or hand over the previous frame's),
   * and then this can pass that. Until it does, leave it alone.
   */
  _wireVfxDepth() {
    this.vfx?.setDepthTexture?.(null);
  }

  /**
   * Feed the VFX system a scene-colour texture so refracting effects can work.
   *
   * `ParticleSystem.setSceneColorTexture(null)` hides the distortion-ring mesh
   * outright, and nothing ever called it — so explosion shockwaves have never
   * been visible in this game. Every blast has been missing the ring of bent
   * air that is most of what sells it.
   *
   * The source is the TAA history, i.e. LAST frame's fully resolved colour.
   * That matters: VFX draws during the scene pass, so sampling the target
   * currently being rendered into would be a feedback loop. One frame of
   * staleness is the standard trade and is invisible at these speeds. The
   * history ping-pongs, so this has to be re-pushed every frame rather than
   * wired once — `_histIdx` has already flipped by the time we run, which puts
   * the frame just resolved at `1 - _histIdx`.
   */
  _wireVfxSceneColor() {
    const p = this.pipeline;
    const hist = p?.rtHist;
    if (!hist || hist.length < 2) return;
    const tex = hist[1 - p._histIdx]?.texture || null;
    if (!tex || tex === this._vfxColorTex) return;
    this._vfxColorTex = tex;
    this.vfx?.setSceneColorTexture?.(tex);
  }

  /**
   * Give the player's AC its thruster plumes.
   *
   * MechFactory builds four exhaust anchors on the backpack — two main nozzles
   * and two verniers — and VFX has a complete persistent-plume system behind
   * `boostFlame()`. Nothing connected them: the only caller of `boostFlame` in
   * the whole codebase was the enemy AI, so the player's AC crossed the map at
   * 95 m/s with cold thrusters while every MT it fought had a burning one.
   *
   * The handles are created once and driven by intensity, because that is what
   * the VFX side is built for — it converges intensity at 45/s so thrusters
   * snap rather than swell, and derives length, brightness, colour temperature
   * and ember rate from it.
   */
  _wirePlayerThrusters() {
    const anchors = this.player?.thrusters;
    if (!this.vfx?.boostFlame || !anchors?.length) return;
    this._plumes = anchors.map((anchor, i) => {
      // MechFactory pushes the two main nozzles first, then the verniers.
      const main = i < 2;
      return {
        main,
        handle: this.vfx.boostFlame(anchor, true, 0, {
          radius: main ? 0.36 : 0.15,
          length: main ? 3.6 : 1.4,
          embers: main ? 32 : 7,
        }),
      };
    });
    this._plumeAxis = new THREE.Vector3();
  }

  /**
   * Drive the plumes from the controller's published movement state.
   *
   * Intensity never reaches zero on the mains: an AC's thrusters idle rather
   * than extinguish, and that faint blue pilot flame is a large part of why a
   * parked AC still reads as powered. The anchors' own orientation points the
   * exhaust straight down, which is right for the verniers and wrong for the
   * mains, so the mains are given an explicit world axis instead — exhaust
   * blows out of the back of the machine, opposite the way it is facing.
   */
  _updatePlayerThrusters() {
    if (!this._plumes) return;
    const m = this.player?.moveState;
    if (!m) return;

    let level = 0.07;                                   // idle pilot flame
    if (!m.grounded) level = 0.40;                      // holding altitude
    if (m.boosting) level = Math.max(level, 0.62);
    if (m.assaultBoost) level = Math.max(level, 1.05 + 0.35 * (m.assaultRamp ?? 0));
    if (m.quickBoost || (m.qbTimer ?? 0) > 0) level = 1.55;
    if (m.staggered) level = 0.03;                      // a staggered AC has lost thrust

    // The axis is deliberately NOT overridden. MechFactory orients each thruster
    // anchor so its local +Z runs down the exhaust, and VFX reads exactly that
    // when no explicit axis is set — which is also what the enemy AI relies on.
    // Forcing a world-space "out the back" direction here fought the authored
    // orientation and pushed the plume through the mech's own body, where the
    // depth test ate it.
    for (const p of this._plumes) p.handle.set(true, p.main ? level : level * 0.5);
  }

  /**
   * Persist the build and the salvage the player is carrying.
   *
   * `Loadout` has had `toJSON` and `fromJSON` — the latter carefully written
   * to drop unknown parts rather than throw — since it was written, and
   * NOTHING CALLED EITHER. Every part collected and every swap made in the
   * garage was discarded on reload. In a LOOTER that is not a missing
   * convenience, it is the progression: the drop tables, the rarity tiers and
   * the whole garage exist to accumulate something, and nothing accumulated
   * past a refresh.
   *
   * Same shape as the audio bindings and the loot pickup's missing `body`
   * node: the hard part was written and the one line that reaches it was not.
   *
   * Everything here is defensive. `localStorage` throws outright in a private
   * context or with site data blocked, a half-written value parses to
   * garbage, and a schema change makes an old payload wrong rather than
   * merely absent — none of which is a reason to refuse to start the game. A
   * failed restore just leaves the starter build in place.
   */
  _restoreLoadout() {
    let raw = null;
    try {
      raw = window.localStorage?.getItem(SAVE_KEY) ?? null;
    } catch {
      return false; // storage unavailable — starter build, no complaint
    }
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      // Version the payload so an old save from a different part schema is
      // ignored rather than half-applied. `fromJSON` drops unknown parts, but
      // a wholesale format change is better restarted than salvaged.
      if (!data || data.v !== SAVE_VERSION || !data.loadout) return false;
      return !!this.loadout.fromJSON(data.loadout);
    } catch {
      return false;
    }
  }

  _saveLoadout() {
    try {
      window.localStorage?.setItem(SAVE_KEY, JSON.stringify({
        v: SAVE_VERSION,
        savedAt: Date.now(),
        loadout: this.loadout.toJSON(),
      }));
      return true;
    } catch {
      return false; // quota, private mode, blocked site data
    }
  }

  /**
   * Save whenever the build changes or salvage is collected.
   *
   * Coalesced onto a timer because both events can fire several times in a
   * frame — a wave's worth of drops collected together, or a garage swap that
   * recomputes — and serialising the whole inventory on each one is wasted
   * work during exactly the moments the frame is busiest.
   */
  _wireSave() {
    let pending = 0;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = 0; this._saveLoadout(); }, 400);
    };
    this._offSave = [
      bus.on(EV.BUILD_CHANGED, schedule),
      bus.on(EV.LOOT_PICKUP, schedule),
    ];
    // A tab closed mid-mission should not lose the salvage from that mission.
    this._onHide = () => { if (document.visibilityState === 'hidden') this._saveLoadout(); };
    document.addEventListener('visibilitychange', this._onHide);
    window.addEventListener('pagehide', () => this._saveLoadout());
  }

  /**
   * Global audio keys. M mutes, minus and equals move the master volume.
   *
   * `AudioDirector` has had `setVolume`, `setMuted` and `toggleMute` — and a
   * `_saveSettings` that persists them — for as long as it has existed, and
   * NOTHING CALLED ANY OF THEM. `setVolume` had no caller anywhere in src/,
   * and `setMuted` had exactly one: `toggleMute`, which itself had none. Four
   * thousand lines of audio with no way for a player to turn it down.
   *
   * The implementation was fine, which is what made it invisible: a probe
   * confirms the context is running, every bus is connected, the gains are
   * sane, and a mute round-trips correctly. Only the binding was missing, and
   * a screenshot cannot show that a key does nothing.
   *
   * Handled at the TOP of the update, before any state branch, deliberately.
   * The garage and non-playing branches both call `input.endFrame()` and
   * return, which clears the pressed set, so a check placed in lateUpdate
   * would never see the key in those states — and the garage is exactly where
   * someone reaches for the mute.
   */
  _audioKeys() {
    const a = this.audio;
    const input = this.input;
    if (!a || !input?.hit) return;

    // `'mission:log'` as a literal, matching every other emitter — there is no
    // EV constant for it, and the HUD subscribes to the string.
    if (input.hit('KeyM')) {
      const muted = a.toggleMute();
      bus.emit('mission:log', { text: muted ? 'AUDIO MUTED' : 'AUDIO RESTORED' });
    }

    // Minus / Equals rather than the bracket keys: they carry the volume
    // glyphs on the physical keyboard, and Equals is where a player reaches
    // for "louder" without holding shift for the plus.
    const step = (d) => {
      const next = Math.round(Math.min(1.5, Math.max(0, a.getVolume('master') + d)) * 100) / 100;
      a.setVolume('master', next);
      // Un-mute on a deliberate volume change: pressing "louder" and hearing
      // nothing because mute is still set is the worst version of this.
      if (a.isMuted() && d > 0) a.setMuted(false);
      bus.emit('mission:log', { text: `MASTER VOLUME :: ${Math.round(next * 100)}%` });
    };
    if (input.hit('Minus')) step(-0.1);
    if (input.hit('Equal')) step(0.1);
  }

  _registerLoop() {
    this.engine.addUpdate((dt, t) => {
      this._audioKeys();
      if (this.state === 'garage') {
        this.garage.update(dt, t);
        this.sky.update(dt, t);
        this.input.endFrame();
        return;
      }
      if (this.state !== 'playing') {
        this.input.endFrame();
        return;
      }

      this.sky.update(dt, t);
      this.lighting.update(dt, t, this.player.root.position);
      this.level.update(dt, t, this.player.root.position);

      this.controller.update(dt, t);
      this._updatePlayerThrusters();
      this.enemies.update(dt, t);
      this.physics.update(dt);

      this.targeting.update(dt, t);
      this.weapons.update(dt, t);
      this.projectiles.update(dt, t);
      this.damage.update(dt, t);

      this.vfx.update(dt, t);
      this.loot.update(dt, t);
    });

    this.engine.addLateUpdate((dt, t) => {
      if (this.state === 'playing') {
        this.cameraRig.update(dt, t, this.targeting);
      }
      this.hud.update(dt, t);
      this.audio.update(dt, t);
      this.pipeline.syncFromGame?.(this, dt);
      this._wireVfxSceneColor(); // history ping-pongs; re-push each frame
      this.input.endFrame();
    });
  }

  openGarage() {
    if (this.state !== 'playing') return;
    this.state = 'garage';
    this.input.exitLock();
    this.garage.open();
  }

  closeGarage() {
    if (this.state !== 'garage') return;
    this.garage.close();
    this.state = 'playing';
    this.input.requestLock();
  }

  _onPlayerDeath() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.input.exitLock();
    bus.emit(EV.GAME_OVER);
    this.hud.showGameOver();
  }

  restart() {
    this.player.stats.reset();
    this.player.root.position.set(0, 8, 0);
    this.controller.reset();
    this.enemies.reset();
    this.projectiles.reset();
    this.state = 'playing';
    this.hud.hideGameOver();
    this.input.requestLock();
  }
}
