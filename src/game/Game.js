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
    this.audio = new AudioDirector(this.engine.camera);

    this._wire();
    this._registerLoop();
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

    // Soft particles need the scene depth buffer to fade against geometry.
    // The pipeline recreates it on every resize, so re-push whenever it changes
    // rather than wiring once at init.
    this._vfxDepthTex = null;
    this._wireVfxDepth();
    bus.on('engine:resize', () => this._wireVfxDepth());
  }

  /** Hand the pipeline's depth texture to the VFX system for soft-particle fade. */
  _wireVfxDepth() {
    const p = this.pipeline;
    const tex = p?.depthTexture || p?._depthTexture || p?.rtScene?.depthTexture || null;
    if (!tex || tex === this._vfxDepthTex) return;
    this._vfxDepthTex = tex;
    const cam = this.engine.camera;
    this.vfx?.setDepthTexture?.(tex, cam.near, cam.far);
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

    // Mech faces -Z, so +Z in its own frame is out the back.
    this._plumeAxis.set(0, 0, 1).applyQuaternion(this.player.root.quaternion);
    for (const p of this._plumes) {
      if (p.main) p.handle.setAxis(this._plumeAxis);
      p.handle.set(true, p.main ? level : level * 0.5);
    }
  }

  _registerLoop() {
    this.engine.addUpdate((dt, t) => {
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
