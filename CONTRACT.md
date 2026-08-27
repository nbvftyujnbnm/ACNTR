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

- 2026-08-26 [player] `Entity.aimYaw` / `Entity.aimPitch` (numbers, radians) — CameraRig writes
  them every late-update; PlayerController reads them at the start of its update and re-applies
  the same frame's raw mouse delta, so movement direction has zero-frame latency while the camera
  keeps aim authority (lock-on assist included). MechRig may read them too.
- 2026-08-26 [player] `Entity.moveState` — PlayerController publishes its live `.state` object
  onto the player entity so CameraRig/HUD/audio can read `{ grounded, airborne, boosting,
  assaultBoost, quickBoost, hovering, ascending, enRecovering, staggered, qbTimer, qbCooldown,
  qbReserve, assaultRamp, landing, speed, verticalSpeed, enRatio, moveX, moveZ, heightAboveGround }`
  without importing the controller. Mutated in place — never cached by value.
- 2026-08-26 [player] `Entity.iframes` (seconds, counts down) — set by PlayerController on a quick
  boost (0.12 s). DamageSystem may honour it; ignoring it is also fine.
- 2026-08-26 [player] `Entity.physics` — PlayerController stores its Physics reference on the
  player entity so TargetingSystem (whose contract constructor is `(camera, player)`) can do
  line-of-sight and aim convergence without extra wiring.
- 2026-08-26 [player] PlayerController writes `player.root.quaternion` (body yaw only, Y axis).
  MechRig owns the bones; the root transform belongs to the controller.
- 2026-08-26 [player] TargetingSystem additions: `.setPhysics(physics)`, `.setInput(input)`,
  `.getAimRay(out)`, `.getLeadPoint(entity, speed, out)`, `.candidates`, `.reticle`,
  `.softTarget`, `.missileLock`, `.reset()`. It owns the Tab key itself (no other module in the
  contract does); `toggleHardLock()` is debounced 40 ms so a second wiring cannot double-toggle.
- 2026-08-26 [player] CameraRig additions: `.reset()`, `.cfg` (tunables), `.trauma`, `.pivot`.
  It listens on `EV.SHAKE`, `EV.WEAPON_FIRED`, `EV.QUICK_BOOST`, `EV.LANDED`, `EV.ASSAULT_BOOST`,
  `EV.PLAYER_HIT`, `EV.EN_EMPTY` and turns them into shake/recoil/whip/FOV. Landing and quick-boost
  shake are already handled here — VFX/audio should not also emit `EV.SHAKE` for those two.
- 2026-08-26 [player] Control resolution for Space (one key, three jobs): the movement stick picks
  the thrust axis. **Space + a direction = horizontal thrust** (ground-boost hover skim near the
  ground, glide in the air). **Space + neutral = vertical thrust** (jump impulse on the press edge,
  then sustained climb). No hold timers or double taps, so every transition is same-frame.
- 2026-08-26 [physics/player/ai] CLARIFICATION: `Physics.moveCapsule(pos, ...)` takes the
  capsule **CENTRE** (consistent with `Entity.collider.center`), but mech roots are authored
  with the origin **at the feet**. Callers must convert: `centre.y = root.y + height/2` going
  in, `root.y = centre.y - height/2` coming out. The original contract left this unstated and
  both PlayerController and Brain passed feet as centre, which floated every mech half its
  height off the ground. Fixed at both call sites.
- 2026-08-26 [pipeline] REQUEST: RenderPipeline should expose a public `.depthTexture`
  getter for the scene depth buffer. Game wires it into `VFX.setDepthTexture()` so soft
  particles fade against geometry, and currently has to probe `_depthTexture` /
  `rtScene.depthTexture` defensively. It re-wires on `engine:resize` since the pipeline
  recreates the texture there.
- 2026-08-27 [mech/render] BUG FOUND IN `TextureForge.armorPanel`, worked around from the
  caller side. When `emissiveDensity > 0` the generator composites the emissive canvas over
  the finished albedo with `globalCompositeOperation = 'multiply'` at `globalAlpha = 0.85`.
  That canvas is BLACK everywhere except the few light strips, so the intent ("paint the
  light channels dark, unlit glass is near-black") instead multiplies **every albedo texel
  by 0.15**. The mech was rendering at 15% of its authored albedo and its panel lines,
  rivets, stencils and chipped paint were quantised into the bottom ~20 of 255 sRGB code
  values, which is why they were invisible. `MechMaterials.bake()` now passes
  `emissiveDensity: 0` and gets its emissive accents from modelled `glow` geometry instead.
  **`hullPlating()` does not pass `emissiveDensity`, so it inherits the 0.12 default and the
  level's plating is crushed the same way** — whoever owns TextureForge should clip the
  multiply to the strips (draw them into an otherwise-white canvas, or composite only inside
  the stroked paths). Second, smaller issue in the same function: `new THREE.Color(baseColor)`
  decodes to LINEAR under ColorManagement but the result is written straight into a canvas
  that is then tagged `SRGBColorSpace`, so every `baseColor`/`accentColor` argument lands
  about one gamma darker than the hex implies; the hard-coded wear constants
  (`bare`, scratch 0.55, rivet 0.42) are NOT colour-managed, so they are relative to that
  darkened paint rather than to the hex you passed.
- 2026-08-27 [mech] `MechMaterials` measures the baked albedo's mean linear luminance at
  bake time (`armorMean`/`armorFineMean`/`mechMean`) and feeds it to the recolour shader's
  `uTexMean`, replacing a hard-coded 0.26 that was off by a factor of ~30. Palette `base`
  values are now the literal albedo of an average-lit patch of that paint, so tuning a
  scheme no longer means guessing at an unknown texture gain.
- 2026-08-27 [mech] Painted armour is now `metalness = 0` (dielectric); only the `steel`
  mask slot is a conductor. The previous all-metal setup gave the armour no diffuse lobe at
  all, which is what made a dark palette render as black plastic. Per-slot metalness still
  resolves to a hard 0 or 1 except at the two physical transitions the contract allows:
  chipped paint exposing bare alloy, and thick grime burying metal.
- 2026-08-27 [mech] `MechMaterials` now exports `MECH_TEXELS_PER_M` (320) and
  `MECH_TILE_METRES` (3.2). Every mech map is baked at `MECH_TILE_METRES * MECH_TEXELS_PER_M`
  square and MechFactory derives EVERY part's UV scale from `MECH_TILE_METRES` alone, so
  there is exactly one tiling number for the whole mech. Holding texels/m constant across
  three resolutions (1024/768/512) was only half of consistency: the forge specifies its
  noise in cycles PER TILE and its plate splitter is depth-capped, so a tile's WORLD size —
  not its resolution — sets how big a plate, a grime blotch or a chip cell is in metres.
  Three tile sizes (3.2/2.4/1.6 m) put grime blotches at 40 cm on the chest, 30 cm on the
  arms and 20 cm on the joint housings, which is what made the accent pauldron read visibly
  coarser than the plates bolted next to it. The `armor` and `armorFine` material slots now
  share one map set; `armorFor(fine)` is unchanged and still returns two distinct materials.
- 2026-08-27 [mech] `MechFactory._partGeo` seeds its per-part UV offset from a hash of the
  PART key, not from `opts.seed`. `opts.seed` is one value for a whole mech, so every part
  previously received the identical offset and the entire frame sampled one patch of the
  tile. The hash deliberately excludes the LOD `mode` so a part's hi and lo meshes keep the
  same offset and the texture cannot jump at the LOD switch.
- 2026-08-27 [mech] `MECH_DIMS.shoulderX` 1.46 -> 1.26, `elbowDrop` 1.50 -> 1.40,
  `wristDrop` 1.60 -> 1.48, and the arm sections went up ~30% (upper arm 0.52x0.56 ->
  0.66x0.78, forearm 0.56x0.62 -> 0.72x0.82). Anything reading these to place a weapon or a
  hardpoint gets the new numbers automatically; the forearm muzzle anchor moved outboard
  from `s * 0.46` to `s * 0.55` with the wider shell.
- 2026-08-27 [render] BUILD BREAK FOUND AND REPAIRED IN A FILE THIS AGENT DOES NOT OWN.
  `src/render/shaders/grade.js` had two backticks inside a GLSL *comment* in the
  `FINAL_FRAG` template literal ("the textbook `(x - 0.5) * c + 0.5`"). A backtick closes
  the template, so the comment's contents were parsed as JavaScript and the module threw
  `ReferenceError: x is not defined` at import time — every boot, every capture, every
  pose. Only the two backticks were removed; the grade maths was not touched. Whoever owns
  the post pipeline: the no-backtick-in-GLSL rule includes comments.
- 2026-08-27 [mech] The armour shader now samples its albedo map at TWO scales. The macro
  layer is the 3.2 m tile; a DETAIL layer repeats `DETAIL_SCALE` (3.11) times inside it, so
  its plates land at ~0.19 m against the macro layer's ~0.58 m. Reason: the forge's plate
  splitter is depth-capped at ~30 plates per tile whatever `panelScale` says, which fixes a
  plate at 0.58 m on EVERY part. That is right for a chest (1.86 x 1.56 m, ~3 x 3 plates)
  and useless for a pauldron face (0.96 x 0.76 m, ~1 plate) — measured, not guessed. Small
  parts rendered as one flat colour with a couple of bolts next to a fully panelled chest.
  Rescaling small parts' UVs would have fixed coverage by reintroducing the texel-density
  defect, so the second scale is applied IDENTICALLY to every part instead: metres per
  feature stays the invariant, there are simply two scales of it everywhere. Only the
  detail tap's luminance RATIO is used (it modulates, never replaces) and it is clamped
  asymmetrically to [0.34, 1.38] — it may darken freely for sub-panel seams and recess
  grime but cannot brighten past the chip gate, which is also what keeps the one tap the
  speckle guard does not cover from adding speckle at a new frequency. Mean gain measured
  at 1.001, so it does not shift overall brightness. `acDetail` is also read by the
  roughness chunk; without that the layer reads as a decal rather than as surface.
- 2026-08-27 [mech] `MaterialSet.m.armorFine` is now THE SAME OBJECT as `m.armor`, not a
  sibling. Once both were baked on one tile the only difference left was a 0.06 roughness
  offset, which showed up as two adjacent parts of one model rendering to visibly different
  specular. `armorFor(fine)` is unchanged and still correct to call. `MaterialSet.list` is
  de-duplicated through a Set so `setDamage` and `dispose` still run exactly once per
  material — anything constructing a MaterialSet must not assume `list.length === 5`.
- 2026-08-27 [mech] Palette `base` values carry real chroma now (raven 0.115 -> 0.197
  saturation) at EXACTLY unchanged luminance — the boost pushes each channel away from the
  colour's own luminance, which leaves `dot(luminanceWeights, rgb)` invariant. A
  near-neutral paint has nothing to hold on to under a warm key, so the lit side of every
  part took the colour of the sun and read as unpainted plastic. Keep any future palette
  edit above ~0.18 saturation for the same reason.
- 2026-08-27 [mech] The detail layer has a RELIEF half as well as an albedo half: the
  armour shader appends to `<normal_fragment_maps>` and adds a second normal-map tap at the
  same `DETAIL_SCALE`, tilting the resolved normal by `DETAIL_NORMAL` (0.55) in tangent
  space. It is fenced on `USE_NORMALMAP_TANGENTSPACE`, the same define under which three's
  `normal_fragment_begin` declares `tbn` — so `tbn` and `vNormalMapUv` are guaranteed in
  scope and the patch cannot compile-break another material variant. Reason, measured:
  raising the albedo detail contrast from 0.48 to 0.58 moved the sunlit forearm by less
  than one code value (130,118,108 both times), because the grade's shoulder compresses a
  +/-25% albedo swing to +/-10% display. Relief moves N.L instead, which buys a far larger
  swing at high light levels. Anything adding a scale of detail to the mech should add it
  to BOTH halves — an albedo-only layer reads as a decal and dies in the highlights.
- 2026-08-27 [mech] The two shoulder mounts now carry ORDNANCE, and deliberately not the
  same ordnance: `MP.buildMissileRack` on the left, `MP.buildShoulderCannon` on the right
  (crude MTs get the rack only). Both mounts were previously empty anchors, which made the
  frame perfectly bilaterally symmetric — the loudest "procedural robot, not an Armored
  Core" tell in a silhouette. `hardpoints.lShoulder` / `rShoulder` now sit on the
  ordnance's own muzzle anchor rather than a bare point on the deck, so shoulder muzzle
  VFX leaves the cell mouths or the barrel; an empty mount still falls back to the old
  [0, 0.22, -0.42]. Both parts are attached with `mergeSolid`, so a shoulder weapon costs 2
  draw calls, not 3. Mech total is ~58k triangles against the ~90k budget.
- 2026-08-27 [render] NOT A MECH BUG — the dark smeared streaks on the chest are POST.
  Measured both ways. (a) Per-triangle UV stretch across every part of the frame: worst
  case 2.5x, and under 1% of surface area exceeds 1.6x, so `applyBoxUV` is not smearing
  anything. (b) Same pose, same build, one frame with all post on and one with
  `pipeline.q.taa/motionBlur/dof = false`: with them off the exact region is razor sharp
  down to a legible "ELCANO" stencil and individual vent slats; with them on the stencil is
  gone and the plate seams are mush. The review poses teleport the camera
  (`cameraRelativeToPlayer`) and then settle for ~1.1 s, which at SwiftShader frame rates
  is ~13 frames — not enough for a 0.925-blend TAA history to converge, and the velocity
  buffer right after a teleport is full of huge vectors for motion blur to smear along.
  Owner of the post pipeline / capture harness: either let stills settle far longer, or
  reset TAA history and zero the velocity buffer after a pose's camera jump.
- 2026-08-27 [mech] The armour chip gate reads the MACRO luminance ratio, not the
  detail-modulated one. The dual-scale detail layer multiplies acRatio by up to 1.22, and
  a multiplier does not respect a threshold: a clean plate at macro ratio 1.40 arrives at
  the gate as 1.71 and comes out as polished bare alloy. Measured against the real baked
  map, that took the gate from 2.0% of texels tinted at all / 0.40% past half strength to
  5.9% / 2.28% — nearly six times the fully alloyed area — which is what drained whole
  small parts (the pelvis skirt worst) to hueless neutral grey once the environment got
  brighter. RECOLOR now divides the detail modulation back out into `acMacro` and gates on
  that, so DETAIL_MIX and DETAIL_SCALE can be retuned without silently repainting the mech
  in bare metal. If you change the detail layer, the chip gate no longer needs re-measuring.
- 2026-08-27 [render] `Sky.fogParams` gained `aerialRamp` (metres) and `Pipeline` gained the
  matching `uAerialRamp` uniform, both carried on the existing `sky:params` bus event. The
  aerial-perspective term is no longer a plain `density * distance`: its per-metre extinction
  ramps as `rn^2 / (1 + rn^2)`, `rn = distance / aerialRamp`. A linear tau cannot bury a 2 km
  ridge without also veiling the 150 m gantry in front of it, which is what destroys midground
  material read. Measured on the vista pose, the change takes 150 m sight lines from 20% veiling
  to 13% and 400 m from 49% to 42% while reaching MORE total extinction past 800 m. Anyone
  emitting `sky:params` should include `aerialRamp`; the pipeline keeps its own default if not.
- 2026-08-27 [render] `Lighting.params.fillElevation` is now the SINE of the bounce light's
  elevation above the horizon, read absolutely. It used to be an offset added to `|sunDir.y|`,
  so the fill's real elevation tracked the sun's and a nominal 0.10 was actually 18.7 degrees.
  Read absolutely, 0.13 is 7.5 degrees, which puts cos(theta) at 0.13 on horizontal ground and
  0.99 on a vertical flank — a 7.6:1 ratio against the old 2.7:1. That ratio is the only knob in
  the rig that separates "shadow on the mech" from "shadow on the ground": at `fillIntensity`
  2.75 it lifted the mech's unlit side 60% (display 42 -> 67 on the hero pose) while taking 37%
  of the undirected light off the sand in the same frame.
- 2026-08-27 [render] `Lighting` now renormalises `hemi.color` / `hemi.groundColor` to a peak
  channel of 1 before applying `hemiIntensity` (the bounce light already did this). The sky
  palette stores RADIANCES around 0.13, so copying them raw made `hemiIntensity` off by a factor
  of eight and the one knob for "light inside a shadow" was doing nothing measurable. It is a
  real irradiance now: 0.30 means 0.30. Anyone reading `Sky.skyFillColor` / `Sky.groundFillColor`
  is still getting radiances — normalise at the consumer, as both lights do.
- 2026-08-27 [render] `Pipeline.params.bloom` gained `mipTaper`, `tint` and `tintCore`. The
  upsample chain is geometrically tapered (mip k reaches the frame at taper^k) instead of
  equally weighted, which is the difference between a tight hot core with a wide soft skirt and
  the uniform veiling glow REVIEW calls an automatic failure. `tint`/`tintCore` colour the bloom
  by how hot each sample is: the core keeps its own colour, the skirt is pulled amber, because
  the glow around a low sun in a dust column is long-path scattering and long-path scattering is
  red. One mix in FINAL_FRAG, applies to the sun, thruster plumes and muzzle flashes alike.
- 2026-08-27 [render] MEASURED DEAD END, recorded so nobody spends an iteration on it: AgX
  `slope` (`grade.agxLook.x`) and `exposure` cannot be traded against each other to buy highlight
  shoulder. The clip point in scene terms is `sigmoid(L * exposure) = 1 / slope` and the sigmoid
  maps 16.5 EV onto [0,1], so recovering the 5% of mid-tone that slope 1.13 -> 1.07 costs takes
  +0.4 EV of exposure, which puts the clip point back exactly where it was. A blown highlight is
  fixed at the source or not at all.
- 2026-08-27 [world] DEFECT FOUND, not owned by this agent. The long conveyor bridge on the right
  of the vista pose renders a ~350x60 px continuous white specular streak with a hard edge and no
  falloff — it reads as a lens smear rather than a glint, and it is the single most artificial
  element left in that frame. It is NOT the IBL sun blob: halving the baked sun's solid angle at
  constant energy (`envSunWiden` 6.5 -> 4.0 with `envSunGain` compensated) moved the frame's
  above-230 area by 0.1 percentage points. It is the ANALYTIC sun specular on a near-mirror
  roughness in that structure's material. Whoever owns the conveyor: raise its roughness (0.35+)
  or break it up along its length. No exposure, tonemap or bloom setting can fix a source that
  runs several stops past the shoulder along 300 m of continuous geometry.
