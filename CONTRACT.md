# ACNTR — Module Contract (AUTHORITATIVE)

Every agent works inside this contract. **Do not change these signatures.** If you
genuinely need a new method, ADD it (never rename/remove), and append a line to the
"Contract Amendments" section at the bottom of this file.

Project: a high-speed mech looter-shooter in Three.js, targeting the look and feel of
Armored Core VI. Stack: `three@0.180`, Vite, ES modules, no build-time asset pipeline —
**all art is generated procedurally at runtime** (geometry, textures, audio). No external
binary assets, no CDN fetches.

Renderer facts you can rely on:
- `THREE.ACESFilmicToneMapping`, `outputColorSpace = SRGBColorSpace`, ColorManagement ON.
- Renderer AA is **off**; the post pipeline owns antialiasing.
- Shadow maps enabled, `PCFSoftShadowMap`.
- Units: **1 unit = 1 metre**. Player mech is ~9 m tall. Gravity 24 m/s².
- Scene up is +Y. Mech forward is **-Z** in local space (Three.js convention).

---

## Shared singletons

```js
import { bus, EV } from '../core/EventBus.js';   // event bus + canonical event names
import * as M from '../core/MathUtils.js';        // clamp/lerp/damp/mulberry32/interceptPoint...
```

`bus.emit(EV.X, payload)` / `bus.on(EV.X, fn)`. Never import a sibling subsystem just to
poke it — emit an event.

---

## Entity shape (used by damage, targeting, AI, HUD)

Every damageable thing (player + enemies) exposes:

```ts
interface Entity {
  root: THREE.Object3D;         // world transform
  isPlayer: boolean;
  faction: 'player' | 'enemy';
  alive: boolean;
  stats: Stats;
  velocity: THREE.Vector3;      // m/s, world space
  collider: { radius: number; height: number; center: THREE.Vector3 }; // capsule, center is world
  hardpoints: { [name: string]: THREE.Object3D }; // muzzle anchors: rArm,lArm,rShoulder,lShoulder,core
  onDamage(info: DamageInfo): void;
  onStagger(): void;
  onDeath(): void;
  getAimPoint(out: THREE.Vector3): THREE.Vector3;  // centre-of-mass to shoot at
}

interface Stats {
  ap: number; apMax: number;               // armor points (health)
  acs: number; acsMax: number;             // impact/stagger gauge — fills up, resets on stagger
  staggered: boolean; staggerTimer: number;
  en: number; enMax: number;               // boost energy
  heat: number;
  defKinetic: number; defEnergy: number;   // 0..1 damage multipliers reduction
  reset(): void;
}

interface DamageInfo {
  amount: number;
  impact: number;                // ACS build-up
  type: 'kinetic' | 'energy' | 'explosive';
  point: THREE.Vector3;
  normal: THREE.Vector3;
  source: Entity | null;
  direct: boolean;               // direct-hit bonus (target already staggered)
}
```

---

## Modules & owners

### `src/render/Pipeline.js` → `class RenderPipeline`
```js
new RenderPipeline(engine)            // engine: { renderer, scene, camera, width, height }
.render(dt, elapsed)                  // REQUIRED — draws the frame
.setSize(w, h, pixelRatio)            // REQUIRED
.syncFromGame(game, dt)               // OPTIONAL — read game state to drive effects
.setQuality(level)                    // 'low'|'med'|'high'|'ultra'
```
Exposes tunables on `.params` (bloom, grade, motionBlur, chromatic, vignette, grain, dof).

### `src/render/Sky.js` → `class Sky`
```js
new Sky(scene, renderer)
.update(dt, elapsed)
.sunDirection : THREE.Vector3   // normalized, points FROM origin TOWARD sun
.sunColor : THREE.Color
.environment : THREE.Texture    // PMREM env map, also assigned to scene.environment
.fogParams : { color, density, height }
```

### `src/render/Lighting.js` → `class Lighting`
```js
new Lighting(scene, renderer, sky)
.update(dt, elapsed, focusPos)   // focusPos: THREE.Vector3, used to re-centre CSM/shadow frustum
.sun : THREE.DirectionalLight
```

### `src/world/Physics.js` → `class Physics`
Capsule-vs-world collide & slide. Static world is registered by `Level`.
```js
new Physics()
.addStatic(mesh)                     // triangle-mesh collider, builds a BVH-ish grid
.addBox(box3)                        // fast AABB collider
.update(dt)
.moveCapsule(pos, vel, radius, height, dt, out) -> { position, grounded, normal, hitWall }
.raycast(origin, dir, maxDist, out?) -> { hit, point, normal, distance, object } | null
.sphereCast(origin, dir, radius, maxDist) -> hit | null
.groundHeight(x, z) -> number
```

### `src/world/Level.js` → `class Level`
```js
new Level(scene, physics)
await .build()
.update(dt, elapsed, playerPos)
.spawnPoints : THREE.Vector3[]
.bounds : THREE.Box3
.arenaRadius : number
```

### `src/mech/MechFactory.js` → `class MechFactory`
```js
new MechFactory()
await .init()                        // bake shared textures/materials once
.buildPlayer(loadout) -> PlayerMech  // implements Entity + .rig
.buildEnemy(archetype, tier) -> EnemyMech
.buildPartPreview(partId) -> THREE.Object3D   // for garage
```
Mech object also exposes:
```js
.rig : MechRig       // see below
.setLoadout(loadout)
.applyDamageVisual(t)  // 0..1 battle damage
```

### `src/mech/MechRig.js` → `class MechRig`
Procedural animation. No skeletal assets — driven bone transforms.
```js
new MechRig(mechRoot, bones)
.update(dt, state)   // state: { velocity, grounded, boosting, quickBoost, aimYaw, aimPitch, speed, staggered }
.bones : { pelvis, torso, headYaw, lArm, rArm, lShoulder, rShoulder, lLegUpper, ... }
```

### `src/player/PlayerController.js` → `class PlayerController`
AC6 movement: ground boost, quick boost (burst dash w/ i-frames-ish), assault boost,
hover/glide, EN drain & recharge, EN-empty penalty, landing recovery.
```js
new PlayerController(player, input, physics, level)
.update(dt, elapsed)
.reset()
.state : { grounded, boosting, assaultBoost, qbTimer, enRecovering, speed }
```

### `src/player/CameraRig.js` → `class CameraRig`
```js
new CameraRig(camera, player, input, physics)
.update(dt, elapsed, targeting)
.yaw, .pitch
.addShake(intensity, duration)
```
Must implement: soft target-framing when locked on, FOV kick on boost, collision
pull-in, recoil punch, roll on strafe.

### `src/player/TargetingSystem.js` → `class TargetingSystem`
```js
new TargetingSystem(camera, player)
.setTargets(list)                     // live array of enemy entities
.update(dt, elapsed)
.hardLock : boolean
.target : Entity | null
.lockProgress : number                // 0..1 reticle convergence
.screenPos(entity, out) -> {x,y,visible}  // normalized 0..1 screen coords
.toggleHardLock()
```

### `src/combat/WeaponSystem.js` → `class WeaponSystem`
```js
new WeaponSystem(player, input, projectiles, targeting, vfx)
.update(dt, elapsed)
.slots : { rArm, lArm, rShoulder, lShoulder }   // each a Weapon instance or null
.setLoadout(loadout)
```
Weapon defs live in `src/combat/Weapons.js` (`WEAPON_DEFS`, `createWeapon(id)`).

### `src/combat/ProjectileManager.js` → `class ProjectileManager`
Pooled, instanced. Bullets, tracers, missiles (with homing + smoke trails), lasers,
plasma, shotgun pellets, explosions.
```js
new ProjectileManager(scene, physics, vfx)
.spawn(def, origin, direction, owner, targetEntity?)
.update(dt, elapsed)
.reset()
.setTargetList(entities)
```

### `src/combat/DamageSystem.js` → `class DamageSystem`
Owns AP/ACS/stagger resolution, direct-hit bonus, death.
```js
new DamageSystem()
.register(entity) / .unregister(entity)
.applyDamage(entity, damageInfo)
.update(dt, elapsed)
```

### `src/combat/VFX.js` → `class VFX`
```js
new VFX(scene, renderer)
.update(dt, elapsed)
.muzzleFlash(pos, dir, scale, color)
.impact(pos, normal, type)          // 'metal'|'concrete'|'energy'|'shield'
.explosion(pos, radius, opts)
.boostFlame(anchor, on, intensity)  -> handle
.trail(...) / .smoke(...) / .sparks(...) / .shockwave(...)
.staggerBurst(entity)
.scanLine(...)
```

### `src/ai/EnemyManager.js` → `class EnemyManager`
```js
new EnemyManager(scene, mechFactory, physics, level, projectiles, vfx)
.setPlayer(player)
.list : Entity[]        // LIVE array reference; targeting holds onto it
.update(dt, elapsed)
.reset()
.waveIndex : number
```

### `src/loot/Loadout.js` → `class Loadout`
```js
new Loadout()
.slots : { head, core, arms, legs, booster, generator, rArm, lArm, rShoulder, lShoulder }
.inventory : Part[]
.equip(part) / .unequip(slot)
.derived : { apMax, enMax, weight, loadLimit, boostSpeed, qbThrust, enRecharge, acsMax, ... }
.recompute()
```
Part database in `src/loot/PartsDB.js` (`PART_DEFS`, `rollPart(tier, rng)`, `RARITY`).

### `src/loot/LootSystem.js` → `class LootSystem`
```js
new LootSystem(scene, player, loadout, vfx)
.update(dt, elapsed)
.dropAt(pos, tier)
```

### `src/ui/HUD.js` → `class HUD`
DOM + canvas overlay in `#ui-root`. AC6-style: AP bar, ACS gauge, EN bar, boxed reticle
with lock-on convergence, target list, enemy AP arcs, damage numbers, mission log.
```js
new HUD(rootEl, game)
.update(dt, elapsed)
.setPaused(b) / .showGameOver() / .hideGameOver()
```

### `src/ui/Garage.js` → `class Garage`
```js
new Garage(rootEl, game)
.open() / .close() / .update(dt, elapsed)
```

### `src/audio/AudioDirector.js` → `class AudioDirector`
Fully procedural WebAudio (no files).
```js
new AudioDirector(camera)
.update(dt, elapsed)
```
Listens on `EV.SFX`, `EV.WEAPON_FIRED`, `EV.IMPACT`, `EV.QUICK_BOOST`, ...

---

## Style rules

- ES modules, no TypeScript, no semicolon-less style — match the existing files.
- JSDoc on public methods. Comments explain *why*, not *what*.
- Zero per-frame allocation in hot paths: preallocate scratch vectors at module scope
  (`const _v = new THREE.Vector3()`), use object pools for particles/projectiles.
- Dispose geometries/materials you create in a `dispose()` method.
- Never `console.log` in the frame loop.
- All materials must react correctly to `scene.environment` (PBR), use real metalness
  values (metal = 1.0 or 0.0, nothing in between except at rust transitions).

## Visual bar

This is judged side-by-side against Armored Core VI screenshots by a hostile critic.
Non-negotiables: crisp panel-line detail on the mech, physically plausible metal
response, strong emissive accents that bloom, layered atmospheric depth (haze bands,
not flat fog), grounded contact shadows, no untextured flat-colour surfaces anywhere,
no "default Three.js" look (no lambert-grey, no visible polygon silhouettes on curves).

## Contract Amendments
<!-- append: `- YYYY-MM-DD [module] added X because Y` -->
