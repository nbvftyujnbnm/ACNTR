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
