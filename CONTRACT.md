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

### Read these first — the traps that have each cost more than a day

Ninety-odd amendments follow and they are all worth having, but these are the
ones that have burned multiple agents, several of them more than once. Search
the file for the phrase in caps.

| If you are about to… | Read |
|---|---|
| write or fix a review pose | **THE SHUTTER IS TENS OF SECONDS AFTER THE POSE RETURNS, NOT 1.1 s** — and a pose must NEVER tear down its own state on a `setTimeout`. Five diagnoses died on this |
| read a `__POSE_NOTE__` field | if it was sampled by a `setTimeout`, it describes a frame that is tens of seconds older than the picture beside it — sample from `addLateUpdate` |
| reposition the player in a pose | **ROOT ROTATION IS NOT THE AIM** — CameraRig owns `aimYaw`, and setting only the root is undone within a second |
| judge whether something is "in frame" | **BEING INSIDE THE FRUSTUM AND BEING VISIBLE ARE DIFFERENT QUESTIONS** |
| put a backtick anywhere near GLSL | **THE GLSL LINT HAD A FALSE NEGATIVE** — this bug has broken the build three times |
| A/B two renders | `debug.setPass` silently no-opped before 2026-09-01, so older A/Bs compared identical frames |
| conclude the shadows are weak | **THE SHADOWS ARE NOT WEAK** — measured; at a 13.5° sun the cast is a 37 m blade, and the contact cue is AO's job |
| lighten the mech's paint | the MECH_PALETTES comment: paint owns darkness, lighting owns shadow-side legibility. Two passes were lost oscillating on this |
| add negative space to the mech | **THE "ONLY ONE TRUE SKY-GAP" DEFECT IS STALE** and **THE LEG'S FLAT PROFILE IS A WIDTH/DEPTH BUDGET PROBLEM** |
| change a loadout-derived number | **EVERY LOADOUT MULTIPLIER WAS PINNED AT ITS CLAMP FLOOR** — `warnIfSaturated` exists to catch the recurrence |
| debug the thruster plumes | **THE THRUSTER PLUMES RENDER**, **THE mech.thrusters ANCHORS POINTED THE WRONG WAY**, and **THE INSTANCED PARTICLE PATH WORKS** — a long elimination list, do not redo it |
| ask "which way is the mech facing" in a tool | **`root.rotation.y` IS 180 DEG FROM `aimYaw`** — use `debug.forward()`/`right()`/`aheadOfPlayer()`/`yaw()`, never rebuild the basis from the root |
| spawn or place an entity from a tool | **`debug.spawnEnemy` TRANSPOSED TIER AND POSITION** — every review frame had NaN enemies; print coordinates before theorising about occlusion |
| wire a subsystem | **THE NEVER-CALLED-SETTER SWEEP** — it has found seven real bugs |

Two habits the file exists to enforce: **measure before you fix**, and when a
measurement and an image disagree, believe the image and go fix the metric —
two of the silhouette metrics were wrong on their first outing.

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
  [2026-09-05: the frame budget is larger than "~13" says. The screenshot itself takes
  24-130 s with the page still ticking, at roughly 0.15 fps, so add another handful of
  frames. It is still nowhere near convergence, so the conclusion stands — but do not
  quote 13 as the number.]
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
- 2026-08-27 [mech] Torso asymmetry. `buildCore` now hangs a DIFFERENT assembly on
  each flank — a clamped coolant conduit + header tank + bleed line on the right, a
  stepped countermeasure box with a hinged accent lid and a stub exhaust on the left —
  plus a 1.2 m whip antenna off the right yoke and a short blade antenna off the left.
  `buildHead` gains a left-temple rangefinder pod (with a counterweight stub, not a
  mirror, on the right). Together with the shoulder ordnance these mean no two halves
  of the frame match. All of it is gated behind `detail !== 'low'` and `!crude`, so MTs
  and the LOD meshes are unaffected. Both flank assemblies deliberately run y 0.9..2.0
  against a hull that tapers inward with height, so each stands further proud as it
  climbs and the waist-to-shoulder run gains a profile instead of a single edge.
- 2026-08-27 [render] DIAGNOSIS, NOT A FIX — the "smeared dark streak" on the mech's
  upper chest is the DEPTH OF FIELD pass defocusing the subject, not a mech texture,
  UV or normal problem. Measured with `q.dof` on vs off on the `mech_detail` pose
  (mean |Laplacian| per region, higher = sharper):
      region      dof on   dof off
      streak       12.37     23.45
      pauldron     10.67     24.89
      chest        11.51     33.68
      background   15.00     14.93   <-- unchanged
  The mech loses half to two thirds of its high-frequency detail while the background
  keeps all of its. That is backwards, and it is what turns a 3 cm cable and a plate
  edge into a soft dark band that reads as a stretched texture. Cause is in
  `src/render/Pipeline.js`: `params.dof.restFocus` is 90 m and `_dyn.focus` only leaves
  that value when something drives it, while every review camera sits 8-20 m from the
  mech. Whoever owns the pipeline: focus wants to track the subject (a depth probe at
  the reticle, or the player's distance from the camera). Ruled out on the mech side —
  per-triangle UV density measured across every part of every builder is 0.4-1.0 of
  target with no texel below 0.4 and no degenerate triangles, so nothing is stretched.
- 2026-08-27 [mech] The chip gate in `MechMaterials.RECOLOR` now has a SECOND,
  locality term. Testing a texel's brightness against the map MEAN alone cannot
  distinguish a chip from a plate that is merely bright: `TextureForge.armorPanel`
  tints every plate independently by up to +16%, so a plate at the top of that
  spread clears the onset across its whole area and renders as one hue-free slab of
  bare alloy. Measured in the hero frame: the pelvis skirt came out at saturation
  0.019 while every other lit surface on the mech read 0.23-0.44, and the alloy
  colour is the only neutral this shader can produce. The gate now also samples the
  albedo at `uChipLod` (mip bias 5.5, ~45 texels ~ 14 cm — between a chip cell and a
  plate) and requires the texel to be brighter than its own plate, which is
  scale-invariant. The two smoothsteps multiply, so this can only ever remove chip
  coverage relative to the macro gate alone, never add it.
- 2026-08-27 [mech] The pale plate on the pelvis is NOT a mask bug. Rendered with each
  mask slot flat-tinted (base=red, accent=green, trim=blue, steel=white), the front hip
  skirt samples 198,99,87 against the chest's 175,99,88 — both plainly `MASK.BASE`, as
  authored. It reads pale because it is the one plate on the frame that hangs clear of
  the hip cavity, so it is unoccluded to the sky while everything behind it is deeply
  occluded (129,127,129 against 28,31,45), and the sky is neutral where the key is warm.
  The AO/ambient contrast is the lighting owner's call; what WAS a mech defect is that a
  surface that bright carried no hardware at all, so `buildPelvis` now bolts three
  raised blocks, an accent hazard strip and a trim rail onto it. Note for anyone adding
  detail to a doubly-rotated plate: `greebleFace` only builds axis-aligned frames, so
  compose the plate's own transform and post-multiply a translation along its face.
- 2026-08-27 [render] `Sky.fogParams` retuned to move haze OUT of the midground:
  `bandDensity` 0.0013 -> 0.0008, `bandColor` multiplier 0.86 -> 0.78,
  `aerialDensity` 0.0016 -> 0.0024, `aerialRamp` 520 -> 1000. The finding behind it:
  the BAND, not the deck and not the aerial term, was what made 100-400 m read as milk.
  Its optical depth is linear in distance, and from an elevated camera it is linear with
  a large coefficient — the vista pose sits at y=78 with the stratum at 55 +/- 16, so
  every sight line down to the plain crosses it near its peak and Simpson returns ~0.30
  of full band density AT EVERY RANGE. At 400 m that was 44% of the total tau on a
  structure, more than the deck and the aerial term combined, carrying the brightest of
  the three colours. A constant-per-metre veil with a bright terminator is the definition
  of a flat wash. Measured on the vista pose: total veiling on a structure at 400 m
  34.6% -> 22%, on the plain at 800 m 77% -> 69%, on the 2 km ridges 98.8% -> 98.6%.
  Frame result, 100-400 m band: mean 79.7 -> 67.2 with standard deviation 16.6 -> 19.3.
  The band still draws its haze line across the towers — that is a HEIGHT effect and
  survives a density cut. `aerialRamp` is the knob that makes this trade cheap: tau on
  that term goes as d^3 / (ramp^2 + d^2), so the 400 : 800 : 2000 m ratios go from
  1 : 3.8 : 21 at ramp 520 to 1 : 5.7 : 29 at ramp 1000 — the same burial on the ridges
  for a third of the cost on the midground.
- 2026-08-27 [render] MEASURED DEFECT in `Lighting.params.splits`, now fixed: CSM splits
  on VIEW DEPTH, not radial distance, and the hero pose put its subject on a cascade
  boundary. The camera sits at player + (12, 6.4, 14) looking at (0, 4.7, 0), which puts
  the mech's FEET — exactly where the contact shadow is drawn — at a view depth of
  18.95 m against a first split of 18. The contact shadow of the hero shot was therefore
  being drawn by cascade 1 at ~3.5x coarser texels AND inside the `fade` blend band
  between two cascades of different resolution. Splits are now [28, 78, 200, 560] with
  `shadowMaxFar` 420 -> 560: the mech sits at 68% of cascade 0, clear of the fade margin,
  at ~17 mm/texel. Anyone adding a review pose should check its subject distance against
  `splits[0]` — landing on a split is invisible in code and obvious in the frame.
  `shadowMaxFar` went out because at 420 m the vista stopped casting roughly where its
  midground begins; the cost is +25 draw calls on that pose (199 -> 224 of a 400 budget).
- 2026-08-27 [render] `Pipeline.params.bloom.threshold` 1.45 -> 1.90, and this is the
  fix for the vista's blown sun. The threshold is in SCENE-LINEAR radiance — the
  prefilter runs before exposure — and through exposure 0.662 + AgX, 1.45 lands at
  display 225 and 1.90 at display 239. The sky's Mie lobe around a 13.5-degree sun peaks
  near 3.0 linear / display 237 across roughly a sixth of the vista frame, so at 1.45
  THE SKY ITSELF was the largest bloom emitter in the shot, feeding every mip a broad
  low-contrast source. The white smear was not the sun's falloff, it was a quarter of the
  sky bleeding sideways. Frame result: pixels above display 240 went 0.45% -> 0.13%.
  When tuning this knob, convert it to a display value first — the number is meaningless
  in isolation because everything interesting in the frame lives within 30 code values
  of it.
- 2026-08-27 [render] MEASURED, and it generalises the existing "a blown highlight is
  fixed at the source" note: near the sun the AgX shoulder makes display value almost
  INDEPENDENT of radiance. Halving the sky's radiance 6 degrees off the sun moves the
  frame by 4 code values out of 255; cutting it to 25% moves it by 57. Any attempt to put
  structure into a flare by mixing a colour into it therefore does nothing visible — the
  sky-side dust in `shaders/sky.js` had to become an EXTINCTION at 0.90 before it drew a
  silhouette at all. Same reason the aerial-perspective colour work in this file only ever
  shows up below ~display 200. If a change is meant to be visible above that, express it
  as a multiplier on radiance, not as a mix toward a colour.
- 2026-08-27 [render] DO NOT "FIX" THE AgX MATRICES IN `shaders/lib.js` BY TRANSPOSING
  THEM. `AGX_IN` / `AGX_OUT` are written so that GLSL's column-major `mat3(...)`
  constructor produces the CORRECT matrix: read that way both have row sums of exactly
  1.0000 and the pair round-trips a saturated colour to within 3%. The identical
  constants in three.js are fed to `Matrix3.set()`, which is ROW-major — so the same
  nine numbers mean transposed things in the two places, and reading these as row-major
  gives row sums of 1.106 / 0.933 / 0.961, which tints every neutral in the game warm.
  Checked because the vista's sun quadrant renders R exactly equal to G; that turned out
  to be ordinary highlight desaturation, not a matrix bug.
- 2026-08-27 [render] `Pipeline.params.grade.lift` 0.026 -> 0.032 and `agxLook.power`
  1.00 -> 0.94, with the exchange rates measured on the curve so the next person does not
  have to rediscover them. `lift` is purely additive and scaled by (1 - disp), which makes
  it the most toe-selective knob in the grade: +18% on a display-9 black, +0.7% on
  display-146 sunlit sand. `power` is a pow() on the sigmoid's [0,1] output and targets
  the MID shadows instead: +12% at display 38, +5% at display 115, +1% at display 217 —
  which is where a mech's unlit plating lives. `contrast` and `exposure` are NOT
  substitutes for either; both move the sunlit half of the frame by as much as the
  shadows, and on these poses the sunlit half has no headroom.
- 2026-08-27 [world] DEFECT FOUND, not owned by this agent, and it is the reason the hero
  pose has no readable contact shadow. The mech in `tools/poses/hero.js` stands INSIDE the
  cast shadow of the large building behind it — measured, the sand around the mech reads
  display 17-27 with RGB (18, 20, 32), i.e. pure cool fill and no sun, while the dunes
  60 m further back read 75 with RGB (88, 73, 67). At a 13.5-degree sun a 25 m building
  throws a 104 m shadow, so the whole apron is in it. The ambient occlusion IS working
  there — walking away from a barrel base the sand goes 15.4 -> 26.6, a 42% contact
  darkening — but 11 code values in the black end of the curve is invisible, and no
  lighting or grade knob can fix that without flattening the vista's sand, which is the
  higher priority. A contact shadow reads because the ground AROUND it is lit. Whoever
  owns the pose or that building's placement: move the hero framing so the mech stands in
  sun, and the contact shadow appears for free.
- 2026-08-27 [render] BUG, fixed: THE DEPTH-OF-FIELD PASS WAS DEFOCUSING THE SUBJECT AND
  LEAVING THE BACKGROUND SHARP, in every frame this project has ever been reviewed on.
  `Pipeline.syncFromGame` only ever set `_dyn.focusT` from a LOCKED TARGET and otherwise
  fell back to `params.dof.restFocus` (90 m). Review poses call `debug.clearEnemies()`, and
  normal play is unlocked most of the time, so focus sat at 90 m while the third-person
  camera sat 7-20 m from the mech. Confirmed independently by mean |Laplacian| on the
  untouched baseline: mech_detail chest 12.6 and pauldron 10.5 against a BACKGROUND of
  18.0 — the subject measurably softer than what is behind it. Worst case is the
  mech_detail pose, whose camera is 7.07 m of view depth from the chest: the CoC term
  `(z - focus) / z` returns -11.7, which saturates the clamp and applies the pass's
  MAXIMUM 3.2 px blur radius to the subject of the shot.
  Focus is now driven by what is in frame: view depth of the player's mech (lifted
  `dof.subjectRise` = 4.5 m off the origin, which the contract puts at the feet), or the
  harmonic mean of player and locked target when both exist — the two-plane DOF split, so
  neither is traded for the other. Two things to know before touching this:
  (a) `uFocus` is compared against VIEW DEPTH in DOF_FRAG, not radial distance, so use the
  new `_viewDepth()` helper rather than `camera.position.distanceTo()` — the old code used
  distanceTo, which is wrong for anything off-centre;
  (b) focus now SNAPS instead of damping when the target ratio exceeds 2.5x. That is a cut
  versus a rack: a teleport or respawn moves focus by an order of magnitude, and at damp
  rate 3.2 a still capture that settles for 0.6 s never converges, which would have left
  this bug half-fixed and unmeasurable.
  Consequence worth flagging: with focus correct, `farScale`/`nearScale` of 0.10 put
  essentially every surface in these poses under the 0.6 px threshold the pass early-outs
  on, so DOF is now close to a no-op. That is deliberate and strictly better than the old
  behaviour, but whoever wants real subject separation can now raise `farScale` safely —
  it was only ever dropped to 0.10 because a wrong focus distance made it destroy the
  midground. Also note the earlier amendment blaming the chest's "dark smeared streak" on
  TAA and motion blur: that investigation was run through a 3.2 px defocus of the subject,
  so its conclusion should be re-measured before anyone acts on it.
- 2026-08-27 [mech] Shoulder ordnance anchors `mountL`/`mountR` moved from y 3.02 to
  **3.14** in core-local space. The yoke's upper mass is now carried 12 cm clear of the
  lower one on two short posts, opening an 11 cm x 38 cm through-slot in the top of each
  shoulder — the only gap on the frame guaranteed to have sky behind it rather than more
  mech. The whole hardpoint stack (base plate, pylons, rail, cleats) moved up with it.
  Anything that positions shoulder weapons off these anchors follows automatically; anything
  that hard-codes 3.02 will now float 12 cm low.
- 2026-08-27 [mech] `MechRig._updateArms` rest roll 0.05 -> **0.095**, and `tuckRoll` flipped
  sign: `+0.05 * wBoost + 0.14 * wAssault`, was `-0.10 / -0.30`. Positive `rotation.z` swings
  a downward-hanging arm AWAY from the body on the right side, so the old negative tuck drove
  the hands 57 cm across the frame and buried both forearms inside the thighs at assault
  boost (measured: 20 of 40 shared cells interpenetrating). The boost tuck was always meant
  to be the pitch term; roll's job is keeping the arms clear of the legs while it happens.
  Measured clearance now: 2.3 cm standing, 13 cm boosting, 30 cm at assault boost.
- 2026-08-27 [mech] `buildThigh`'s outboard plate moved from 0.44/0.12 to **0.36/0.11**
  (outer face 1.22 -> 1.135 in torso space). At 1.22 its top corner sat 9-13 cm inside the
  forearm in the DEFAULT STANDING POSE. The thigh's own box is the widest thing on the leg
  again; if anyone widens the thigh past 1.13, re-run the arm/leg clearance check before
  shipping it.
- 2026-08-27 [mech] PAINT OWNS DARKNESS, LIGHTING OWNS SHADOW-SIDE LEGIBILITY. Palette
  bases are back down to **0.075..0.15 linear (most near 0.09)**, i.e. dark painted armour.
  This value has now been wrong in both directions — 0.15 read black on the shadow side,
  0.235 turned the sunlit arms into a white slab, and 0.19 put the whole mech at the same
  value as the pale hangar wall behind it so it lost its silhouette into the background. The
  division of labour is the fix, not a compromise number: if the shadow side crushes at these
  values it is a FILL problem and must be solved with fill. Do not lift the paint to
  compensate — that is the loop that produced the pale mech.
- 2026-08-27 [mech] Lower-leg and pelvis masses up 15-25%: shin 0.94 -> 1.22 m across
  (10.5% -> 13.6% of height), sole 1.04 -> 1.22 (foot now 1.55 m across the claws), waist
  block 1.06 -> 1.24, pelvis 1.24 -> 1.42, hip skirts flared. The frame read tall and
  spindly at hero distance. The lower leg is the one place mass is free: the hands bottom
  out at y 2.91 and the shin's top is 2.10, so nothing down there can reach the arms. The
  THIGH is not free — it is capped by the arm's rest-pose clearance (measured 2.3 cm), so
  its added mass went into Z. Re-run the arm/leg clearance check before widening it in X.
- 2026-08-27 [world/Level] LIKELY BUG, unowned: a flat panel has been visible floating in
  the sky in the upper-right of the hero frame across several iterations. A raycast through
  that exact screen point (tools/probes/floaters.js) hits `ContainmentField` — the arena
  boundary, a ShaderMaterial parented to `Level` — at ~477 m, at y=94 with 85 m of clearance
  above the terrain, and it occupies that WHOLE screen region. Hypothesis: the boundary
  renders as discrete panels and one segment is failing to fade out, so it reads as an opaque
  floating rectangle instead of a subtle boundary shimmer. Whoever next owns Level should
  check the field's per-panel fade/alpha against camera distance and view angle.
- 2026-08-27 [mech] Painted armour is now MATTE: slot roughness multipliers went
  base 0.92 -> 1.12, accent 0.84 -> 1.02, trim 1.06 -> 1.18, and `envMapIntensity`
  1.15 -> 0.95. STEEL deliberately stays at 0.52. This was diagnosed, not guessed:
  halving the palette's albedo (0.19 -> 0.09 linear) moved the sunlit arm only from 143
  to 126, which means that surface was showing a specular lobe rather than its own
  colour — an albedo-independent term no amount of darkening the paint could reach.
  If a lit surface on this mech is ever "too bright" again, check whether it is diffuse
  (it will carry the palette's chroma, sat 0.2-0.4) or specular (near-neutral, sat < 0.06)
  BEFORE touching the palette.
- 2026-08-27 [mech] MEASUREMENT TRAP, do not chase this a third time. The "pale skirt
  plate" at the mech's crotch in the hero pose is NOT a mech surface — it is the
  background seen through the daylight gap between the legs. It reads neutral and bright
  because the hangar wall behind it is neutral and bright, and it tracks that wall across
  every exposure the lighting agent has tried (0.91 / 1.06 / 1.13 of wall value over three
  captures) while the solid pelvis 2 cm to its left reads 66 and the thigh face reads 10.
  Two separate passes have now "fixed" this in the material system. Sample at
  (752,462) for real pelvis armour; (772,505) is sky.
- 2026-08-27 [render] SHADOW-SIDE FILL is now TWO lights, and the second one is
  free on the terrain. `Lighting.params` gains `bounceIntensity` 2.1,
  `bounceElevation` -0.11, `bounceAzimuth` 0.95 rad. The existing `fill` buys its
  asymmetry by being nearly horizontal (0.13 of itself lands on the plain, 0.99 on
  a vertical flank); taking the elevation NEGATIVE takes that to the limit — at
  6.3 degrees BELOW the horizon, n.l on an up-facing surface is negative and
  clamps to zero, so the plain receives EXACTLY NOTHING from this light however
  hard it is pushed. What it reaches is what the sky fill cannot: the
  downward-facing half of the mech, plus the flanks at 90 degrees to the sun,
  which previously got cos(90) = 0 from BOTH the key and the fill and fell back on
  the hemisphere's 0.22. Hence the 54-degree azimuth offset — it puts a second
  lobe in the middle of that dead zone. Physically it is the sand bouncing the key
  back up, so it takes the sky's `groundFillColor` (warm ochre) against the fill's
  cool `skyFillColor`: warm from below, cool from the side, warm key.
  Paid for with `Pipeline.params.grade.lift` 0.032 -> 0.022, and that trade is the
  point. `lift` is ADDITIVE on the display value (disp = lift + (1-lift)*disp), so
  every code value it adds to the floor is bought by compressing everything above
  it — a contact shadow that darkens its surround 42% before the grade darkens it
  less than 42% after. A light is MULTIPLICATIVE: the AO and cascade ratios
  survive intact, so the contact shadow gets MORE readable as the shadows open.
  Measured on the hero pose, against the same build with only the mech differing:
    frame below display 8      9.91% -> 5.33%   (-46%)
    mech feet region  mean/sd  22.4/17.5 -> 26.2/21.5   (level AND contrast up)
    mech legs         mean/sd  37.1/29.2 -> 41.2/31.8
    shadowed ground   mean/sd  19.2/9.8  -> 17.7/11.1   (DARKER, more range)
    sunlit ground     mean     67.8      -> 65.4
    hangar wall       mean     120.1     -> 119.7        (unmoved, as designed)
    dark containers   median   display 7 -> 44           (black void -> read metal)
  i.e. the subject opened up while the ground it stands on got darker, which is
  the separation the flat-looking frames were missing. Vista frame mean is
  unchanged at 111.8 — this is not an exposure lift.
- 2026-08-27 [render] `Pipeline.params.chromatic.amount` 0.85 -> 0.34, plus the
  unsharp mask in FINAL_FRAG rewritten as a LUMA high-pass applied as a RATIO.
  The two go together because the second was amplifying the first. The CA offset
  is `cc * r2 * 4.0 * amount * uTexel`, which at the frame corner (|cc| = 0.707,
  r2 = 0.5) is 1.20 texels per channel — a 2.4 px red/blue split on every edge
  out there. Binned |R-B| over pixels with a luminance gradient above 40, by
  radius, on the vista pose: 16.7 at centre rising to 44.8 in the corner, which at
  1:1 is a visible rainbow outline on every gantry rung and crate edge in the
  lower right — the loudest remaining "cheap post filter" tell in the frame.
  Worse, the sharpen's four neighbour taps are read at the UNSHIFTED uv while
  `color` has already been split per channel, so the old per-channel form
  differenced a shifted red against an unshifted red and added the mismatch back
  at uSharpen strength: the sharpen pass was amplifying the fringe by a further
  30% and ringing it. A luma high-pass cannot do that (one scalar cannot invent a
  colour), and a ratio preserves hue exactly where an additive high-pass
  desaturates sharpened highlights. Result: corner |R-B| 44.8 -> 32.2 while the
  count of high-gradient pixels went UP at every radius, i.e. less false colour
  and more real edge. `sharpen` keeps its meaning and did not need retuning.
- 2026-08-27 [render] MEASURED DEAD END, do not repeat: splitting the SSAO kernel
  into a short-range half (0.35 x radius, for a tight contact term) and a
  long-range half is free multi-scale AO in theory and a straight regression on a
  greebled subject. At 0.35 x 1.55 m = 54 cm every rivet, strake and panel step on
  the mech occludes the near samples, so that half of the kernel saturates almost
  everywhere on the hull and arrives as a CONSTANT DIMMER rather than a localised
  contact darkening. Measured on the hero pose: mech torso lost 8.6% of its mean
  AND 6.5% of its standard deviation, p95 161 -> 147 — darker and flatter at once,
  the exact opposite of what a contact term is for. Also cost the world geometry
  (containers 40.3/22.3 -> 39.7/22.0). Reverted; the comment in AO_FRAG records it.
  A tight contact shadow on geometry this dense needs a separate depth-aware pass,
  not a share of these twelve taps.
- 2026-08-27 [render] CLOSED, with measurements, so these stop being reopened:
  (a) SKY BANDING — there is none. Vertical scans down three columns of the vista
  sky give maximum constant-value runs of 3, 3 and 7 px across spans of 86, 21 and
  43 code values, with 189-242 direction changes per 280-row scan. The value
  oscillates far faster than it drifts, which is a dithered gradient, not a band.
  The two-term dither in `shaders/sky.js` (multiplicative for the dark zenith,
  additive for the bright horizon) is doing its job.
  (b) MIDGROUND HAZE AT 100-250 m — already resolved by the earlier fog retune and
  should NOT be pushed further. Working the current numbers at the vista camera
  (y=78): at 150 m the deck contributes ~0 (it e-folds over 8.7 m and the whole
  sight line but the last metres is above it), the band 0.0008 x 150 x 0.30 = 0.036
  tau, the aerial term 0.0024 x 150^3/(1000^2 + 150^2) = 0.008 tau — about 4.3%
  total veiling. There is nothing left to remove at that range; what still reads
  milky in that part of the frame is at 400-800 m, where veiling is supposed to be
  strong. Frame-level: the 100-400 m band's standard deviation is 27.6 against
  20.3 at iter03, and the near sand went 19.6 -> 47.7.
  (c) THE BLOWN "SUN FLARE" ON THE RIGHT OF THE VISTA IS NOT THE SUN. Bucketing
  every pixel at or above display 245 into 50 px cells puts 859 of 1148 of them
  (75%) in a 200x60 px band at x 1250-1450, y 500-550 — the conveyor bridge deck,
  not the sky. The sun disc is not even in frame in that pose; the bright sky
  quadrant peaks at 235-240 and rolls off smoothly. The flare complaint and the
  conveyor-specular defect logged earlier are THE SAME DEFECT, and it is still
  owned by whoever owns that structure's material (raise its roughness past 0.35
  or break it up along its length).
- 2026-08-28 [world] THE CONVEYOR BLOWOUT IS FIXED, and it was two defects wearing one
  coat. (a) MATERIAL: every structure family's `rough` is a MULTIPLIER on the baked
  roughness map, not a roughness — three evaluates `roughness * roughnessMap.g`, and the
  forge writes a mean near 0.62 with a floor near 0.45. `dark`, which carries every deck,
  truss, handrail and grating in the level, was at 0.48, so its smoothest texels rendered
  at **0.22 — a mirror**. Every family was in that neighbourhood. They are now
  0.80-0.96 (`dark` 0.96, `steel` 0.80, `trim` 0.86, `teal` 0.86, `rust` 0.96,
  `ochre` 0.90), i.e. effective 0.36-0.77, and `env` came down with them. Read the new
  numbers as "1.6x the effective roughness"; a family needs `rough` past ~0.78 before its
  smoothest texels clear 0.35. (b) GEOMETRY, which the material alone could not reach: the
  312 m span's deck was ONE box and each handrail was ONE 8 cm bar, so the whole run
  presented one normal to a 13-degree sun. `pipeBridge`, `catwalk`, the cantilever arm and
  `railing` now build in plates and bays — each rolled 1-3 degrees about the run axis, set
  a few centimetres off its neighbours and tinted independently — plus grating treads every
  2.5 m. Measured on the vista pose over the bridge's whole run: pixels at or above display
  245 **-46%** (1754 -> 953) and above 235 -49%; inside the 200x60 px band the review
  measured (x 1250-1450, y 500-560) the mean fell 159.6 -> 95.5 and the above-245 count
  1515 -> 583.
  More to the point the highlight is now a broken chain of plate glints instead of a
  300 m smear. NOTE for the render owners: the frame's TOTAL above-245 count went UP over
  the same interval (9839 -> 14212) and every one of those pixels is in the sky above
  y=430 (7896 -> 12806) — that is not the level.
- 2026-08-28 [world] `GeoBatch.tint(tint, scale)` is now a public static. It resolves a hex
  tint multiplier exactly the way `add()` does and then scales it, so a builder can vary
  plate-to-plate INSIDE one assembly and still compose with the caller's tint instead of
  replacing it. `add()` calls it, so there is one implementation of the renormalisation.
- 2026-08-28 [world] All seven structure families and the four prop families share one
  `onBeforeCompile` (`surfaceBreakup`) that adds WORLD-space grime: roughness +0..0.26 and
  albedo x0.90..1.07 from a two-term field at 20 m and 5.5 m. Roughness is only ever ADDED,
  so it can break a highlight up but never sharpen one. The shortest wavelength is 5.5 m
  deliberately — that is ~12 px at the vista's 400 m sight lines, and a sub-metre
  procedural term would alias into a crawling speckle at that range while the baked
  roughness map already owns that scale. It is ONE function object on purpose: three keys
  its program cache on `onBeforeCompile.toString()`, so the families keep sharing compiled
  programs (37-39 total, unchanged) instead of forking one each. It is also what stops 168
  instanced containers from wearing identically — the varying is computed through
  `instanceMatrix` under `#ifdef USE_INSTANCING`.
- 2026-08-28 [world] THE FLOATING PANEL IS NOT `ContainmentField`. It is `Level.banners`,
  and the earlier diagnosis should not be acted on. Raycast through the exact screen point
  in the old hero framing: FIRST hit `Level.banners` at **89 m**, world (6.4, 34.9, -52.4);
  `ContainmentField` is the SECOND hit 384 m further out. The field could not have drawn it
  anyway — far from the player its fragment alpha is 0.035 before a `exp(-fog*dist)` factor
  and additive `SrcAlpha, One` blending squares it, so it contributes ~1e-4 of anything.
  The raycast reached it because a raycast does not read alpha. What `_buildBanners`
  actually did was scatter tarps on a random bearing from each district centre at
  `heightAt + 6..22` with `castShadow` off and a `PlaneGeometry`'s default 0..1 UVs — one
  whole tile of the armour-panel map stretched across a 12 m piece, so its plates rendered
  a metre wide each and it read as a rigid bulkhead hanging in clear sky. Now: anchors come
  from `_blockers` and `_decks` so every tarp hangs off a real parapet or handrail, UVs are
  world-scaled at 1.7 m/tile, the free edge is torn, and the mesh casts shadows. Same
  screen point now returns nothing but the boundary shell. Two supporting changes: the
  wave amplitude went 0.55 -> 0.28 because a tarp 20 cm off a wall cannot swing half a
  metre, and `_blockers` entries gained a 6th slot, **1 for `_addOBB` slabs and 0 for
  `_addAABB`** — only the sliced footprints bound a real flat wall, and allowing the rest
  left 8 of 29 tarps with no geometry within 6 m because a tank's or a lattice tower's
  bounding box face stands metres clear of anything solid. Everything else reads slots 0..3
  only.
- 2026-08-28 [world] THE VERTICAL STRIATION ON THE DISTANT RIDGES IS A NYQUIST BUG IN THE
  BOUNDARY REVOLVES, not fog and not terrain. Angular noise sampled on a CIRCLE in noise
  space steps `TAU * R / NA` per column times the octave multiplier. `_mesaRing` used
  R = 28.8 for its erosion field over 288 columns: 2.5 lattice units per column at the top
  octave, i.e. fully decorrelated, so every column got an independent radius, height and
  shade. One column is 10 m of cliff, which at the vista's 600 m sight line is 19 px —
  measured stripe pitch 10-18 px, RMS 0.42 and peak 1.6 code values on the ridge face and
  none in the sky above it. `_farPlain` (finest octave 152 m against a 157 m column) and
  `_distantButtes` (a field repeating 62 times around 30 columns) had it worse. Radii and
  octave counts now hold the finest octave at 5+ columns per feature everywhere, and the
  buttes use fixed harmonics 3/5/8 in angle instead of a noise lookup. THE TRAP ON THE
  OTHER SIDE, hit and recorded: simply lowering a butte's noise radius until it stopped
  aliasing took the field almost constant, and a smooth revolve under a low sun is one
  coherent normal — the butte came back as a flat, hard-edged pale trapezoid with no
  interior value at all, which is an automatic REVIEW failure where the striation was
  merely a blemish. Band-limited harmonics cannot do that: their amplitude is fixed rather
  than sampled. Anyone adding a revolve to the boundary should check the same ratio.
- 2026-08-27 [render] `Pipeline.params.dust` (`amount` / `scale` / `drift`) and
  `dustGain()` in `COMPOSITE_FRAG` — the deck and band media now have STRUCTURE.
  Every other term in that pass is a smooth closed-form function of position, so
  a sight line across open ground produces a smooth ramp and nothing else.
  Measured on the vista pose, that showed up as the plain between 300 m and
  800 m: standard deviation 15.9 code values across a 700x70 px band, a pale
  featureless sheet occupying the middle third of the frame and the largest
  single reason its lower half read as flat. Nothing stands on that stretch to
  cast onto it (and it is past `shadowMaxFar` anyway — tested, extending the
  cascades to 950 m moved that region by 0.1 code values), and the terrain there
  has no relief, so the only place structure can come from is the AIR.
  Two world-space probes per ray at 0.30 and 0.68 of the distance, fbm2 each,
  squashed 3.5x in Y so banks lie in sheets. World space, not screen space, so
  banks stay put under camera motion and TAA does not fight them; the gain is
  built to average exactly 1.0, so total veiling on the ridges is unchanged and
  the numbers tuned in the earlier fog pass still hold. Aerial term deliberately
  excluded — it is Rayleigh-ish and really is uniform.
  TWO THINGS TO KNOW BEFORE RETUNING IT. (a) `scale` is the knob that matters,
  and the first value tried (190 m) was useless: the 700 px measuring window
  spans only ~140 m of world at the far probe, so ONE noise cell covered the
  whole region and the term shifted its level without adding structure inside it
  — sd 15.9 -> 16.9, and no further at 0.85 amplitude. Two or three banks across
  the frame is the target. (b) A fixed-region standard deviation is a bad metric
  for this at any scale, because which bank happens to land on the measured
  rectangle dominates it; cross-variant region stats moved the FOREGROUND sand
  by 3-5 code values purely from reseeding. Judge it on frames.
- 2026-08-27 [render] Ambient rebalance, and the reasoning generalises: on the
  PLAIN, and only on the plain, shadow value is dominated by undirected light. A
  13.5-degree sun delivers sin(13.5) = 0.23 of its irradiance to horizontal
  ground but cos(13.5) = 0.97 to a vertical flank, so the ground is the one
  surface in the frame whose lit value the key barely wins. Every 0.01 removed
  from an omnidirectional term is therefore worth about 4x more contrast on the
  sand than it costs the mech, which has a directional fill of its own.
  `hemiIntensity` 0.22 -> 0.16 and `envIntensity` 1.18 -> 1.00, both paid into
  `bounceIntensity` 2.1 -> 2.4 (which lands EXACTLY zero on up-facing ground —
  see the earlier amendment — so it cannot give back what was just taken).
  Measured on the vista pose against the same build with only these three
  differing: sunlit sand 128.0 -> 127.1, sand in shadow 55.8 -> 54.3, ratio
  2.29 -> 2.34. Small, and honestly smaller than predicted, because AgX
  compresses it. `envIntensity` is the term that wants to come down further and
  the one that cannot: it also drives specular, i.e. whether metal picks up the
  sky. A harder setting (0.11 / 0.86 / 2.7) was measured at ratio 2.30 against
  2.21 for its own paired baseline — a slightly better trade on paper, not taken
  because of the 27% specular cut. That is the documented next step if someone
  wants more ground contrast and is willing to pay for it.
- 2026-08-27 [render] `grade.splitShadow` (-0.026,-0.006,0.044) ->
  (-0.038,-0.008,0.058). AC6's signature is a warm key against a COOL shadow and
  this frame was only delivering the first half: measured on the vista, sunlit
  sand reads R/B 1.38 and sand IN SHADOW still read 1.20. The cause is that the
  terrain albedo is warm ochre and the largest ambient term reaching it (the
  PMREM environment) is warm too, so nothing in the shadow is cool enough to
  overcome the paint — the two directional fills already carry the right
  temperatures and cannot be pushed harder without flattening the plain. Moves
  shadowed sand to R/B 1.13 at no cost anywhere else, because it is gated on the
  bottom of the curve.
- 2026-08-27 [render] MEASURED, and it contradicts the review note it answers:
  THE SHADOWS ARE NOT WEAK. Rendered one pose twice, identical but for
  `castShadow` on every cascade light, and differenced: 31% of lit pixels are
  darkened below 0.6x, the ground immediately around the mech goes 58.8 -> 26.3
  (a 2.2x darkening) and the mech's own self-shadowing runs 0.66. What is
  missing is not shadow DEPTH, it is a framing in which one is visible. At a
  13.5-degree sun a 9 m mech throws a 37 m shadow: it is a long blade cast far
  to one side, not a pool at the feet, so whether the frame contains it is
  decided entirely by the camera azimuth relative to the sun. A tight
  under-the-feet darkening at this sun elevation can only come from AO, never
  from the cascades. Anyone still chasing "faint contact shadow" should fix the
  pose, or accept that the cue is AO's job.
- 2026-08-27 [world] DEFECT, not owned by this agent: the distant ridge meshes
  carry VERTICAL FACET STRIPING. Measured by comparing the horizontal
  high-frequency content of a single scanline against the same statistic on a
  100-row average — noise averages down by sqrt(N), a vertical stripe does not.
  Coherence comes out at 0.35-0.52 against the ~0.1 that independent noise would
  give, i.e. genuinely coherent columns. Amplitude is 2.1 code values with the
  post fog off and 0.6 with it on, so the fog is already burying it 3.7x and it
  is invisible in the vista pose; it is clearly visible in any LOW camera, where
  the ridges are less veiled — the boost frame measures 2.06 at coherence 0.52.
  It is not post: TAA, sharpen and grain were each ruled out by isolation, and
  the fog attenuates it, which places it before the composite. Likely a
  heightfield ridge whose vertex normals face-band along its grid columns.
- 2026-08-27 [render] MEASUREMENT TRAP, recorded so nobody chases it: an
  autocorrelation peak at lag 25-27 px appeared on every ridge in every frame at
  two different cameras and FOVs, which looks exactly like a fixed screen-space
  period and is not. It is the analysis: subtracting a moving average of radius
  12 (a 25-wide window) to detrend a profile plants a positive echo at precisely
  the window width. Vary the detrend width before believing any peak near it.
- 2026-08-27 [tools] TWO POSE DEFECTS that make lighting unreviewable, found by
  capturing at HEAD. (a) `Debug.placePlayerInSun` scores candidates on the SUM
  of eight 60 m clearance rays, so a spawn with one wall 3 m away and seven open
  directions still wins, and it never tests the point the camera will actually
  occupy. On this build it picks a spawn where the hero camera (player +
  12, 6.4, 14) lands INSIDE geometry: `shots/L40/hero.png` is a full-frame
  close-up of armour plating. Score the MINIMUM ray, not the sum, and reject a
  candidate whose camera offset is occupied or whose line back to the mech is
  blocked. (b) Even a perfect sunlit spawn is not enough for the thing the hero
  pose exists to show: the shot also needs the sun roughly SIDE-ON to the
  camera, or the mech's shadow falls behind it and out of frame. Both hero
  framings tried this session put the sun near the camera axis and neither shows
  a contact shadow, despite the shadows measuring strong (see above).
- 2026-08-27 [tools] The boost pose's motion blur is a function of the capture's
  SETTLE TIME, which makes it easy to grade the wrong frame. The pose releases
  its keys and then steps; at the harness default (1100 ms) the frame still has
  the assault-boost velocity and shows heavy, correct blur, and at 1800 ms the
  velocity has decayed and the same pose renders sharp at 59 m/s. Do not raise
  `--settle` when capturing `boost`.
- 2026-08-28 [harness] DEFECT, not owned by this agent, and it makes the `hero` pose
  unreviewable: `Debug.placePlayerInSun` scores a spawn on the PLAYER's elbow room and the
  pose then puts the camera 18.4 m away on a fixed bearing, so nothing checks what is
  behind the lens. Its clearance term is a SUM over 8 rays capped at 60 m, so a spot with
  60 m of open ground in seven directions and 5 m of wall in the eighth scores 425 of 480
  and wins — and if that eighth direction is the camera's, the shot is taken from inside
  the wall. Reproduced on two consecutive builds, deterministic, and confirmed by
  measurement rather than by eye: the frame is a `plateA`-family wall at about 11 m
  (three 4 m plates across a 55-degree horizontal field). The fix belongs in the scorer —
  score the camera's position too, or reject any candidate whose camera offset raycast
  hits inside ~25 m. `shots/level2/hero.png` and `shots/level/hero.png` are both this.
- 2026-08-28 [render] THE PALE MECH IS THE FILL RIG, NOT EXPOSURE AND NOT THE
  GRADE'S TOE. Settled by rendering the hero pose five times on ONE build, each
  frame differing only in which light term was removed at runtime, and taking
  the median display value inside ten rectangles that lie strictly INSIDE the
  mech's silhouette (so the population is subject pixels and nothing else):

      base ................ mech 67   rest 63
      fills removed ....... mech 10   rest 54
      environment removed . mech 62   rest 60
      hemisphere removed .. mech 67   rest 62
      KEY removed ......... mech 43   rest 46

  Turning the SUN completely off changed the subject by 24 code values; turning
  off the two shadowless fills changed it by 57. The no-key frame is nearly
  indistinguishable from the shipped one. `fillIntensity` 3.35 and
  `bounceIntensity` 2.4, both aimed at vertical flanks (cos 0.99 and 0.58),
  were delivering an unlit flank MORE irradiance than sunlit horizontal ground
  gets from the key — which is why a 0.09-albedo machine was rendering at the
  same median as the sand and silos behind it (mech/rest median ratio 1.07) with
  no modelling on it at all.
  Exposure and the toe were the wrong suspects and the measurement says why:
  both move the whole frame, and the frame AROUND the mech is placed correctly
  (rest median 63, 5th percentile 11, 0.02% of the hero frame above display 230).
  The subject was 6% of the pixels and the only thing mis-lit.
  Fix: `fillIntensity` 3.35 -> 1.25, `bounceIntensity` 2.4 -> 1.10 (cut
  proportionally less — it is the only light reaching the mech's downward-facing
  half), `sunIntensity` 17.5 -> 24.0. Result on the same pose: mech median
  67 -> 43 against an unchanged background, ratio 1.07 -> 0.71, p95 121 -> 131.
  The fills keep their old job — the fraction of the mech below display 24 goes
  18.5% -> 28%, against 72% with them off — they just stop out-voting the sun.
- 2026-08-28 [render] `sunIntensity` has a measured CEILING of about 24 in this
  rig, and the thing that ends it is not clipping. Stepping 17.5 / 20.5 / 24 /
  27 on the hero pose: mech p95 113 / 122 / 131 / 135, mech below-display-24
  27.4% / 27.3% / 28.3% / 28.0%, rest-of-frame median 58 / 59 / 60 / 66. Up to 24
  the entire gain lands on the subject's key faces and neither its shadows nor
  the background move; the frame's above-230 area is identical to three decimals
  throughout. At 27 the BACKGROUND comes up with it, which spends the
  figure/ground separation the key was raised to buy. Raise the key, not the
  exposure, whenever the subject needs contrast: at a 13.5-degree sun the key is
  4.2x more efficient on a vertical flank than on horizontal ground, and no
  grade knob has that asymmetry.
- 2026-08-28 [render] MEASURED DEAD END, closing the one the earlier ambient
  rebalance left open. Cutting `envIntensity` and `hemiIntensity` together for
  ground contrast (0.85/0.08 and 0.70/0.05) moves the vista's sunlit:shadowed
  sand ratio 2.51 -> 2.54 -> 2.59 and the sunlit dune's standard deviation
  38.5 -> 38.6 -> 38.8 — a 30% environment cut for 3% of ground contrast — while
  on the hero pose it takes the mech's p95 121 -> 115 and its above-128
  population 4.1% -> 3.4%, i.e. the chamfer glints go out. The payoff is now
  much smaller than when it was first costed, because the `fillIntensity` cut
  above already removed the plain's largest undirected term (the sky fill
  delivered 0.44 of irradiance to horizontal ground and now delivers 0.16).
  Both were reverted; the shipped values are 1.00 / 0.16.
  Related: at 0.16, `hemiIntensity` is a NO-OP ON THE MECH — removing it
  entirely moves the subject's median by zero (67 -> 67). It is spent as a knob.
- 2026-08-28 [render] THERE IS NO BANDING IN THE SKY GRADIENT. Measured rather
  than eyeballed, on three regions across two poses, two ways: the run-length
  histogram of a single column's raw 8-bit values (banding shows as long
  plateaus) gives a mean run of 1.10 and a maximum of 2-3 rows everywhere, i.e.
  the value changes on almost every row; and the second difference of a
  400-px-wide strip average is fully accounted for by the grain. The two-term
  dither in SKY_FRAG (multiplicative for the dark zenith, additive for the
  bright horizon) is doing its job. Do not add more.
- 2026-08-28 [tools] A/B MEASUREMENT RIG, and the trap it exists to avoid.
  `Lighting.params`, `Pipeline.params` and `scene.environmentIntensity` are all
  re-read every frame, so a whole variant sweep can be captured from ONE build
  in ONE browser session by mutating them between poses — about 90 seconds a
  frame instead of eight minutes, which is what made a five-way light
  decomposition affordable. The trap: `tools/capture.mjs` runs `vite build`, and
  with several agents editing at once a "before" and an "after" taken from two
  builds differ by everyone's work, not yours. Two vista frames measured 30
  minutes apart in this session differ by 12 code values on the far ridge purely
  from concurrent Level.js edits. Any lighting or grade number quoted as a
  before/after must come from a SINGLE build with the parameter changed at
  runtime; a rebuild between the two frames invalidates it.
  Second trap, specific to the fog: the dust banks advect with `dust.drift`, so
  heavily-veiled far-field regions (the 2 km ridges, the 300-800 m plain) move
  by several code values between any two frames taken at different times, even
  in the same build. Near-field regions reproduce to under 1%.
- 2026-09-01 [tools] SILHOUETTE AUDIT — `node tools/silhouette.mjs [--out DIR]
  [--yaws 0,45,90,135,180]`, backed by `debug.silhouette()` /
  `debug.silhouetteMask()`. Renders the mech as a flat black shape on white
  with the entire post stack bypassed, then scores it. This exists because
  "does the silhouette read as an Armored Core" was argued from lit screenshots
  three separate times and settled none of them — a lit render hands the eye
  paint, panel lines and rim light to latch onto, and the shape underneath
  never has to carry its own weight.
  The metric that matters most is `openRows`: the fraction of occupied rows
  containing two or more separate runs of mech, i.e. rows you can see sky
  through. It deliberately does NOT require a gap to be enclosed, because the
  single most important gap on a biped (between the legs) is open at the bottom
  and an enclosed-hole count scores it zero. `fill` (mech pixels / bbox pixels)
  is the blob detector; `complexity` is perimeter over the perimeter of an
  equal-area disc; `widths` is a 12-band head-to-foot profile, which is how leg
  taper becomes a number instead of an argument.
  The targets in the tool's output are derived from the shape language REVIEW.md
  describes, NOT measured from the real game — we cannot download AC6 frames in
  this sandbox. Treat them as a floor to clear, not a score to hit.
- 2026-09-01 [tools] The silhouette framing must be computed from CHASSIS
  MESHES ONLY. `Box3.setFromObject(player.root)` includes the thruster Points
  clouds and sprites parented to the mech, whose bounding volumes are far
  larger than anything they draw; framing off that box pushed the mech low and
  small in one view and completely out of frame in four others, which read as a
  broken renderer rather than a bad box. `debug.silhouette()` now hides
  Points/Sprite/Line children, unions only visible mesh geometry bounds, and
  pins near/far around the fitted distance.
- 2026-09-01 [tools] EVERY HEADLESS TOOL NOW SERVES A BUILT BUNDLE, NOT THE DEV
  SERVER. Under vite's dev server, editing any file under `src/` while a run is
  in flight triggers HMR: the page reloads out from under the in-flight
  `page.evaluate` and its promise never settles, so the run HANGS until its
  timeout rather than failing with something legible. That cost two ten-minute
  stalls before it was diagnosed, and it is a standing hazard whenever several
  agents edit and measure at the same time. `tools/capture.mjs` already built
  and served through `vite preview`; `tools/probe.mjs` and
  `tools/silhouette.mjs` now do the same. A built bundle is immutable for the
  life of the run, so editing while measuring is safe again.
  `tools/probe.mjs --dev` opts back into the dev server for the rare case where
  you want to probe unbuilt source — accept the hazard if you use it.
- 2026-09-01 [tools] `tools/capture.mjs` no longer aborts the run when one pose
  cannot be screenshotted. The garage pose blows Playwright's 180 s budget under
  SwiftShader — a full-viewport `backdrop-filter: blur()` over the WebGL canvas
  is the suspect — and the unhandled rejection discarded six frames that had
  already been captured, report.json included. Failures are now recorded
  per-pose as `shots[].failed`, listed in `report.failedShots`, and the run
  continues and exits 1.
- 2026-09-01 [mech] THE "ONLY ONE TRUE SKY-GAP" DEFECT IS STALE — DO NOT
  RE-FIX IT. Measured with `tools/silhouette.mjs` on the current build: at the
  3/4 yaws the mech has 10-12 enclosed holes and `openRows` 0.47-0.49; head-on
  it has 9 holes and `openRows` 0.91. The hip / knee / ankle slot scheme
  documented in `buildThigh` and `buildShin` works. The frontal width profile
  also tapers the right way now — bands 6-7 (hip/thigh) are the widest at
  0.97/1.00 against 0.69-0.80 for the shin bands.
  What IS still weak is the leg **in profile**: at yaw 90 the width bands from
  thigh to shin read 0.373 / 0.363 / 0.368 / 0.402 — dead flat. The three slots
  are cut in Y and open across X, so they survive a yaw change but say nothing
  about depth, and front-to-back the thigh, knee and shin are all the same
  size. The leg reads as an unbroken slab from hip to ankle in any side-ish
  view. That is the next real silhouette task, and it is a DEPTH problem, not
  another hole.
- 2026-09-01 [tools] SILHOUETTE SCORING: JUDGE THE 3/4 YAWS, AND `fill` IS A
  TREND NUMBER ONLY. A biped backfills its own negative space at the cardinal
  angles — dead side-on the far leg sits exactly behind the near one and plugs
  every gap in it (yaw 90 scores `openRows` 0.245 against 0.91 head-on for the
  same geometry), and dead front-on the arms hang over the torso. Scoring those
  views punishes geometry that is fine. Grade 45/135, which is also what the
  hero and gameplay cameras use.
  `fill` (mech pixels / bbox pixels) was given an absolute 0.34-0.48 band on
  first outing. That band was invented, not measured, and it is not defensible:
  the bounding box rotates with the camera so the denominator is not comparable
  across yaws, and the same mech reads 0.40 side-on and 0.70 at 3/4. Compare it
  at a FIXED yaw across iterations and nothing else. `openRows`, `holeCount` and
  the per-yaw `widths` profile are the numbers that survived contact.
- 2026-09-01 [game/combat] THE PLAYER HAD NO THRUSTER PLUMES. `VFX.boostFlame()`
  is a complete persistent-plume system and `MechFactory` builds four exhaust
  anchors on every biped (`mech.thrusters` — two main nozzles then two
  verniers), but the only caller of `boostFlame` in the codebase was
  `ai/Brain.js`. The player's AC crossed the map at speed with cold thrusters
  while every MT it fought had a burning one. Wired in `Game._wirePlayerThrusters`
  / `_updatePlayerThrusters`, driven from `player.moveState`.
  Two things worth keeping: the mains are given an explicit world axis via
  `handle.setAxis()` because the anchors' own orientation (`rotation.x = PI/2`
  in `MechFactory`) points the exhaust straight DOWN — right for verniers,
  wrong for main nozzles, which must blow out the back. And the idle level is
  0.07 rather than 0: an AC's thrusters idle, they do not extinguish, and that
  faint blue pilot flame is a large part of why a parked AC still reads as
  powered.
- 2026-09-01 [player/loot] EVERY LOADOUT MULTIPLIER WAS PINNED AT ITS CLAMP
  FLOOR. `PlayerController.NOMINAL` was not in the units `Loadout.derived`
  emits. Loadout computes `boostSpeed = K_BOOST * thrust / sqrt(weight)` and
  labels it m/s; the starter AC derives 45.2 m/s boost, 42.6 m/s of dash
  impulse and 617 EN/s. Those were being divided by 340, 400 and 1650, giving
  ratios of 0.133 / 0.107 / 0.374 — so `statMul` clamped all three to their
  floors: 0.65 boost, 0.60 quick boost, 0.50 EN recharge.
  Measured consequences: assault boost topped out at 95 * 0.65 = **61.8 m/s**
  against a tuned 95; ground boost, jump impulse and ascent were cut by the
  same 0.65; quick boost fired at 60% strength permanently; EN recharged at
  half rate. And because EVERY build saturated the clamp, no booster or
  generator in the parts DB could move any of it — the entire progression axis
  was inert, which is the part a looter shooter cannot afford.
  NOMINAL is now the starter AC's own derived values (45 / 43 / 615), so a
  starter build sits at exactly 1.0 and parts move it either way. Re-measured
  after the fix: assault boost reaches **95.5 m/s** at ramp 1.0, ~1.3 s from a
  standing start.
  `NOMINAL.enMax` was deliberately left at 4000. It feeds `enScale`, which is a
  ratio rather than a clamped multiplier and at 2325/4000 is working as
  intended; retuning it is a balance decision, not a units fix.
  IF PARTSDB IS REBALANCED, THESE MUST MOVE WITH IT. `_refreshDerived` now
  calls `warnIfSaturated()`, which logs once per multiplier when one lands on a
  clamp bound — the signature of exactly this bug, and it would have caught it
  in seconds. Do not silence that warning by widening the clamps.
- 2026-09-01 [tools] THE HARNESS WAS LEAKING A SERVER PER RUN, and it presented
  as "everything is mysteriously slow". `spawn('npx', ['vite', ...])` creates
  npx -> sh -c -> node vite, and `child.kill()` signals only the npx wrapper, so
  the real server outlived every capture, probe and silhouette run. Seven had
  accumulated in one session, each holding a port and competing for the CPU
  SwiftShader needs; a four-second `vite build` was taking minutes and two runs
  were misdiagnosed as hangs before anyone counted the processes. `tools/server.mjs`
  now owns spawning: detached process group, `process.kill(-pid)`, and reaping
  on exit/SIGINT/uncaughtException. capture, probe and silhouette all use it.
  If you add a tool that spawns a server, use it too.
- 2026-09-01 [mech] THE LEG'S FLAT PROFILE IS A WIDTH/DEPTH BUDGET PROBLEM, NOT
  A MISSING-BLOCK PROBLEM. Side-on the width bands from thigh to shin measure
  0.373 / 0.363 / 0.368 / 0.402: no thigh mass, no knee pinch, no calf. The
  obvious fix — add a quadriceps wedge and a calf block — was tried and
  REVERTED. It did produce a visible profile step, but `openRows` at the graded
  3/4 yaws fell from 0.474 to 0.362 (45 deg) and 0.488 to 0.443 (135 deg),
  because depth contributes sin(azimuth) of itself to SCREEN width and ~24 cm
  of extra calf ate ~17 cm of the gap between the legs. `buildShin` already
  documents this exchange rate in the other direction; the leg has no spare
  screen width, so mass must come OUT of X as it goes into Z. Whoever takes
  this on needs to rebalance the whole limb with the arm/thigh clearance check
  in hand — do not just add another block.
- 2026-09-01 [tools] The silhouette `widths` profile is NORMALISED BY THE
  BOUNDING BOX, so it is not comparable across iterations that change the
  mech's extent. Adding depth grew the box and made bands that had not changed
  appear to shrink, which read as the thigh getting narrower when it had not
  moved at all. Compare `widths` WITHIN one frame (is the thigh band wider than
  the shin band?), never band-by-band between two runs.
- 2026-09-01 [ui/render] `Pipeline.params.dof` IS AN OBJECT OF TUNABLES, NOT A
  SCALAR, and the pass switch is `pipeline.q.dof` (a boolean set by
  `setQuality`). `Garage.open()` was testing `typeof params.dof === 'number'`,
  which can never be true, so depth of field was never disabled for the
  assembly preview and it has been rendering defocused — the same class of bug
  as the `restFocus` mismatch that quietly corrupted every hero review. Fixed
  in Garage to save/restore `q.dof`. There is no `setPassEnabled` on the
  pipeline despite `Debug.setPass` calling one; that debug affordance is
  partially inert for any pass whose params entry is not a bare boolean.
- 2026-09-01 [perf] DRAW CALLS SCALE AT ~130 PER MECH AND THE BUDGET IS ALREADY
  BLOWN. Measured across three poses in one session: hero (0 enemies) 328 calls
  / 2.63 M tris; gameplay (4 enemies) 837 / 3.71 M; hud (5 enemies) 996 /
  4.13 M. That is 127-134 draw calls per additional enemy, and REVIEW.md's
  budget is under 400 calls and under 4 M triangles — both are exceeded at five
  enemies, which is an ordinary wave, not a stress case.
  What IS measured: the player mech is 66 meshes (counted directly by
  `debug.silhouette()`, which enumerates chassis meshes). Roughly 15
  independently animated parts times four material buckets accounts for that,
  so the parts are probably already merged per-part-per-bucket and there is no
  easy win there.
  What is NOT measured, and should be before anyone acts on it: 66 meshes does
  not explain 130 calls, so something is drawing each mech about twice. The
  obvious suspect is the CSM cascades — every shadow caster is redrawn per
  cascade — but that is a HYPOTHESIS, not a measurement. Check
  `renderer.info.render.calls` with shadows disabled before optimising
  anything; do not assume the cascades are the cause because it sounds right.
- 2026-09-01 [tools] TWO POSE PRIMITIVES, AND THE MISTAKE THEY EXIST TO STOP.
  `debug.placePlayerInOpenGround({arc, rays, range})` scores every level spawn
  by how far a fan of rays reaches across a forward arc — keeping the WORST ray,
  never the average, because one clear lane will otherwise hide a wall filling
  the rest of the view — and returns the yaw it chose so a pose can spawn
  enemies down it. `debug.visibleCount(entities)` raycasts from the camera to
  each entity as well as frustum-testing it.
  Both exist because the rewritten gameplay pose reported "4 of 4 enemies in
  frame" for a shot in which all four were behind a warehouse. The mech had
  been placed at a fixed coordinate that put it nose-first against a wall: it
  reported 0.1 m/s while holding forward, and everything ahead of it was
  occluded. BEING INSIDE THE FRUSTUM AND BEING VISIBLE ARE DIFFERENT QUESTIONS
  — the same distinction that made the first hero framing scorer shoot the
  inside of a wall. Any pose that needs to see something must check the second.
- 2026-09-01 [tools] POSES CAN REPORT INTO report.json. Set `window.__POSE_NOTE__`
  and `capture.mjs` folds it into that pose's entry; a `warning` field is also
  printed to stderr. Use it for whatever the pose was supposed to establish —
  enemies visible, speed reached, whether the mech is grounded. A "gameplay"
  frame with no enemies, or a "boost" frame at 0 m/s, is WORSE than a failed
  shot: it looks fine and gets graded as though it showed the thing it was
  meant to show, and both of those had already happened here.
- 2026-09-01 [player/tools] ROOT ROTATION IS NOT THE AIM, AND A POSE THAT SETS
  ONLY THE ROOT WILL BE UNDONE. The authority chain is: CameraRig owns `yaw`
  and writes `player.aimYaw = this.yaw` every lateUpdate; PlayerController reads
  that entity field back (`if (typeof p?.aimYaw === 'number') this.yaw =
  p.aimYaw`) and damps `bodyYaw` toward it every frame. So writing
  `player.root.rotation.y` alone survives about a second: the mech swings back
  to whatever aim the rig holds, which in a headless capture is 0.
  This was NOT a hypothesis about the combat poses, it was their actual defect.
  `placePlayerInOpenGround` was choosing a genuinely open bearing — measured
  140 m of clearance with a flat approach — and the mech then turned off it
  before anything was captured, walked into whatever was now in front (the pose
  reported 0 m/s while holding forward) and left its enemies out to one side,
  where the frustum test still counted all four. Two earlier "fixes" aimed at
  the ray scoring and at enemy spawn heights were aimed at the wrong thing.
  `debug.placePlayer()` now sets rig yaw, entity aimYaw, controller yaw and
  bodyYaw together, then resets the rig smoothing and the TAA history. Any new
  code that repositions the player must do the same or it will drift.
- 2026-09-01 [combat/tools] THE THRUSTER PLUMES RENDER. Before touching the
  flame layer again, know that all of this was checked and is CORRECT: the
  meshes are in the scene under the "VFX" group, visible, `frustumCulled` is
  false with a 1e7 bounding sphere, `instanceCount` reaches 4, the mesh layer
  mask and the camera layer mask both read 1, the material is additive and
  transparent with `depthWrite` false, the geometry is a real
  `InstancedBufferGeometry` whose contract (position.xy a unit circle,
  position.z the 0..1 axial parameter) matches `flameVert` exactly, and the
  12-float interleaved layout written by `_updateFlames` matches the
  aOrigin/aAxis/aParams offsets. The soft-depth fade was also ruled out by A/B:
  handing VFX a null depth texture (`uSoftParams.x = 0`, so `softDepthFade()`
  returns 1.0) changed the frame by nothing.
  The frames that showed no plume were CAMERA-SIDE. `cameraRelativeToPlayer()`
  offsets in WORLD space, so which side of the mech it lands on depends on the
  yaw the placement chose; the thruster close-up was looking at the mech's
  front while the exhaust blew out of its back. Use `cameraBehindPlayer()`,
  which frames in the mech's own basis, for anything that needs a known side.
  Cost of this one: two full diagnostic probes and an A/B capture.
- 2026-09-01 [tools] `debug.setPass(name, on)` NOW WORKS — it drives
  `pipeline.q[name]`, the per-quality booleans set by `setQuality()`. It used to
  write `pipeline.params[name]` and call a `setPassEnabled` that does not exist,
  so for every pass whose params entry is an object of tunables rather than a
  bare boolean (dof, bloom, taa, vignette — most of them) it silently did
  nothing and reported success. Any A/B run through it before 2026-09-01 was
  comparing two identical frames. `debug.passes()` lists the switches that
  actually exist.
- 2026-09-01 [mech/combat] THE `mech.thrusters` ANCHORS POINTED THE WRONG WAY,
  WHICH IS WHY THE PLAYER HAD NO VISIBLE PLUME. Scope, corrected: this affects
  the `thrusters` array only, which is what `Game._wirePlayerThrusters` uses.
  `ai/Brain.js` anchors its plume to `hardpoints.core`, and hardpoints are
  authored "-Z forward" (MechFactory), so their +Z already runs out the back
  and enemy plume DIRECTION was always correct.
  `FlameHandle` fires along the anchor's local +Z (it reads the third basis
  vector of `matrixWorld`). `MechFactory.addThruster` built every anchor with
  `rotation.x = Math.PI * 0.5`, which maps local +Z to world DOWN; the comment
  beside it ("-Z points down the exhaust") describes the opposite convention to
  the one VFX uses. Measured on the player: direction (0, -0.98, 0.20) from an
  anchor 6.05 m above the mech origin, plume length 3.6 m — i.e. a column fired
  straight down through its own torso and legs, where the depth test removed
  all of it. Mechs face -Z, so an UNROTATED anchor already points out the back,
  which is what a main nozzle wants; the verniers keep the downward pitch.
  Everything else about the flame layer was correct the whole time, and was
  verified so at length before this was found — see the previous amendment.
  A second, softer trap on top of it: a cone aimed straight at the lens
  projects as a small disc, and `flameFrag` weights alpha by fresnel, so
  head-on is a plume's DIMMEST view. Photograph plumes from a three-quarter
  rear angle, never from directly behind.
- 2026-09-01 [tools] `debug.visibleCount()` must aim at the CHEST, not the
  entity root. Mech roots are authored at the feet, so a ray to `root.position`
  runs along the ground and is blocked by any rise between camera and target —
  it reported all four enemies occluded in an arena where they were standing in
  the open, which sent two iterations chasing the arena scoring instead.
- 2026-09-01 [tools] THE HARNESS RENDERS THE CAPTURED FRAME ~1.1 s OF REAL TIME
  AFTER THE POSE SCRIPT RETURNS, AND THIS TRAP HAS NOW BITTEN THREE TIMES.
  `debug.step()` advances the simulation but does NOT render; `capture.mjs`
  waits `--settle` (default 1100 ms) and screenshots whatever the live rAF loop
  has drawn by then. So anything a pose sets at the end of its script is
  subject to another second of simulation before it is photographed:
    1. boost.js released its keys at the end and captured 56 m/s instead of 95,
       because the deceleration model owned that window (already recorded).
    2. plume_forced.js set `handle.intensity = 6` to test whether the flame
       layer draws at all; `Game._updatePlayerThrusters` runs every frame and
       reset the target to 0.62 long before the shutter. The test measured
       nothing and looked like a negative result. Detach the driver
       (`game._plumes = null`) before forcing anything it owns.
    3. Any pose that leaves the mech airborne will have it LAND in that window,
       which drops the thruster level to the 0.07 idle — so a plume shot can be
       correct at pose end and legitimately empty in the frame.
  Rule: a pose must leave the game in a state that SUSTAINS what it wants
  photographed for at least the settle window, or hold it with a
  `setTimeout(..., 3000)` release like boost.js does. Reading state at the end
  of the script tells you what was true 1.1 s before the picture.
  **SUPERSEDED 2026-09-05 — the 1.1 s figure is wrong and the `setTimeout`
  release is the opposite of the fix. See the amendment of that date.**
- 2026-09-01 [combat] THE INSTANCED PARTICLE PATH WORKS — hypothesis tested and
  REFUTED, recorded so nobody spends a day on it again. Because the flame layer
  produced no pixels under every possible forcing, the natural suspicion was
  that `InstancedBufferGeometry` + `InstancedInterleavedBuffer` + offset
  `InterleavedBufferAttribute` simply does not work under this container's
  SwiftShader, which would have meant no explosion, spark, smoke puff or plume
  had ever been visible in any capture. `tools/poses/particles.js` settles it:
  shots/iter24/particles.png shows the explosion shockwave ring, long bright
  arcing streaks, scattered debris and a muzzle flash. The technique is fine.
  So the FLAME LAYER SPECIFICALLY is broken while the quad-particle and
  ring/shell paths built the same way are not. Narrowing left to do is in the
  plume geometry, `flameVert`, or how `flameInner`/`flameOuter` differ from the
  particle mesh — note that `flameGeo` shares its `position` BufferAttribute
  object with `_plumeGeo` and shares one geometry between the two flame meshes,
  neither of which the particle path does.
  The symptom to explain: a draw that IS submitted (instanceCount 4, mesh
  visible, layers matching, material forced to opaque NormalBlending with
  depthTest false and renderOrder 9999) and rasterises zero pixels. `flameVert`
  early-outs to `gl_Position = vec4(0,0,2,1)` — clipped — when `aParams.y`
  reads 0, which fits, but the particle shaders read their attributes fine.
- 2026-09-01 [tools] THE GLSL LINT HAD A FALSE NEGATIVE AND LET THE BACKTICK BUG
  LAND A THIRD TIME. The first version only inspected template literals carrying
  a `/* glsl */` tag, and skipped any file containing no such tag. `Terrain.js`
  injects its shader through `onBeforeCompile` with plain UNTAGGED literals, so
  the file was never examined at all: the lint printed "clean (48 files
  scanned)" while the build was broken by ``(`acFlat`)`` in a GLSL comment.
  A guard that only checks the cases you remembered to label is not a guard.
  It now scans every file properly — tracking line comments, block comments,
  quoted strings and dollar-brace nesting — finds EVERY template literal, and
  checks the ones whose body looks like GLSL. Verified by reintroducing the
  exact bug and confirming it is caught, then removing it and confirming clean.
  Also deliberately NOT added: a second "any backtick in a GLSL-looking comment"
  sweep. It was tried and flagged three ordinary JavaScript comments in
  Level.js nowhere near a shader. A lint that cries wolf gets ignored, which is
  how a guard stops guarding.
- 2026-09-01 [audit] THE NEVER-CALLED-SETTER SWEEP IS CLEAN, and it is worth
  re-running after any big wiring change because it has found seven real bugs:
  projectiles unable to damage anything, the loadout reaching neither weapons
  nor movement, soft particles without a depth buffer, the player's thrusters
  never lit, the rig never given a ground sampler, damage smoke attached to
  nothing, and explosion distortion rings hidden outright.
    for f in $(find src -name '*.js'); do
      grep -oP '^\s{2}(set|attach|register|bind|enable)[A-Z]\w*(?=\()' "$f" \
      | tr -d ' ' | sort -u | while read m; do
        n=$(grep -rE "\.${m}(\?\.)?\(" src tools --include=*.js | grep -v "^${f}:" | wc -l)
        [ "$n" -eq 0 ] && echo "UNCALLED $m <- $f"
      done
    done
  Use `grep -E` and allow for `?.` — a first attempt used basic-regex escapes,
  matched nothing, and reported two dozen false positives including setters that
  are demonstrably called from Game.js.
  What survives the sweep today is all benign: `VFX.setAxis` (optional, and the
  thruster anchors now carry the right orientation so nothing needs it),
  `MechRig.setStiffness` (tuning), and `Lighting.setShadowQuality` (reachable
  via the `render:quality` bus event, so not really uncalled).
  ONE REAL GAP REMAINS, out of scope for the visual bar but worth knowing:
  `AudioDirector.setMuted` and `setVolume` have no caller anywhere, so the game
  ships with no way to mute or change volume. That is a settings-UI feature,
  not a rendering defect.
- 2026-09-02 [combat] **THE PLUMES WERE NEVER A PIPELINE PROBLEM — smoothstep
  ran backwards.** `flameFrag` ended with `a *= smoothstep(1.0, 0.55, v)` to
  fade the tip. GLSL ES leaves `smoothstep` UNDEFINED when edge0 >= edge1, and
  the usual driver implementation short-circuits "if x is below edge0, return
  0" — which for edges (1.0, 0.55) and v in [0,1] returns ZERO FOR EVERY
  FRAGMENT, so all of them hit the `discard` two lines later. Draw submitted,
  vertex stage correct, instance data correct, nothing rasterised. Three
  separate investigations chased that symptom into the render pipeline.
  The same bug was in `ringFrag`'s mode-1 dome shockwave, so explosion domes
  never drew either — only the mode-0 ring, which is why particles.png looked
  like the particle path was healthy and led me to declare it "refuted".
  And a third in `MechMaterials`, `smoothstep(0.62, 0.40, metalnessFactor)`,
  the term meant to let grime bury metal: if that was silently 0 on this driver
  then grime has never done anything, and the alloy/grime balance may want
  re-measuring now that it works.
  ALWAYS write `1.0 - smoothstep(lo, hi, x)` for a falling edge. Never
  `smoothstep(hi, lo, x)`. `tools/lint-glsl.mjs` now fails on any smoothstep
  inside a GLSL literal whose two edges are numeric literals and not strictly
  increasing.
- 2026-09-02 [game/render] THE SOFT-PARTICLE DEPTH FADE IS DELIBERATELY OFF.
  `Game._wireVfxDepth` used to hand the particle system
  `pipeline.rtScene.depthTexture` — the depth attachment of the very target the
  VFX draws into. MEASURED: the renderer logs GL_INVALID_OPERATION on EVERY
  FRAME while the pipeline is attached, and none while it is detached. With no
  texture, `uSoftParams.x` stays 0, `softDepthFade()` returns 1.0, and
  particles intersect geometry with a hard edge — a small visual cost, and
  strictly better than a per-frame GL error plus an undefined sample.
  To restore it properly the pipeline must COPY depth into a texture the scene
  pass is not writing (or expose the previous frame's), and only then can this
  pass it. Do not "fix" this by passing the obvious texture again.
- 2026-09-02 [tools/physics] A NaN `maxDist` MAKES `Physics.raycast` REPORT A
  PHANTOM HIT, and that is what "4 enemies in frustum, 0 visible" was — not the
  arena scorer, which three iterations were spent on.
  The mechanism: `raycast` starts with `best = maxDist` and detects a miss with
  `if (best >= maxDist) return null`. That comparison is FALSE when maxDist is
  NaN, so the function falls through to `res.hit = true; res.distance = best`
  and returns a hit at a NaN distance. `JSON.stringify` renders that as `null`,
  which is how it first showed up as four nulls in a pose note.
  The NaN came from `debug.visibleCount`: `aim.y += (e.collider?.height ?? 8)`
  — `??` catches undefined but NOT NaN. One NaN aim point makes the direction
  NaN, the length NaN, and the range NaN, and then EVERY target reports as
  occluded no matter where it is.
  Guarded on the caller side with `Number.isFinite`. WORTH DOING AT SOURCE TOO,
  and it is not just a harness concern: `TargetingSystem` uses the same raycast
  for line-of-sight lock breaking, so any caller that ever passes a NaN range
  would drop the player's lock permanently and look like scenery occlusion. A
  two-line guard at the top of `Physics.raycast` (`if (!(maxDist > 0)) return
  null;`) would close the class. src/world is another agent's file, so it is
  flagged here rather than edited.
- 2026-09-02 [physics] `Physics.raycast` RETURNS A SHARED MUTABLE SCRATCH
  OBJECT, and the NEXT raycast invalidates the previous result. Measured: cast
  down (hits at 5.02 m from a 5 m origin — correct), then cast up (misses,
  returns null); re-reading the FIRST result afterwards now shows `hit === false`,
  because the second call reset `this._rayOut` at its top before returning null.
  Never hold a raycast result across another raycast. Read what you need out of
  it immediately, or pass your own `out` object as the fourth argument.
  Confirmed in the same probe that the raycast itself is CORRECT with finite
  inputs — up misses, down hits at exactly the expected distance, a 120 m
  forward ray across scored-clear ground misses, a 2 m ray misses. The only
  defect is the NaN-range path recorded above.
- 2026-09-02 [ai/tools] `debug.spawnEnemy` TRANSPOSED TIER AND POSITION, so
  EVERY ENEMY IN EVERY REVIEW FRAME WAS AT NaN AND RENDERED NOWHERE. This is
  the actual cause of "NO ENEMIES VISIBLE", and it outlived two other
  diagnoses that were each real bugs in their own right (the phantom raycast
  hit, the arena scorer) but were never this one.
  The manager's signature is `spawn(archetypeId, TIER, POSITION, opts)`. Debug
  called `spawn(archetype, new Vector3(x,y,z), tier)`. Nothing threw:
  `root.position.copy(2)` reads `2.x`, gets `undefined`, and writes NaN into
  all three components, while `tierScale(someVector3)` runs
  `clamp(vector3 || 1, 1, 6)` and turns every stat NaN alongside it.
  WHY IT WAS INVISIBLE FOR SO LONG: the entity reports `alive: true` and its
  root reports `visible: true`, and a NaN transform makes the GPU drop the
  draw with NO error and NO warning — there is nothing in a console log, a
  draw-call count, or an entity count that differs from a working enemy. The
  frame just has no enemies in it. `enemies: 4` in the capture stats was true
  and meaningless.
  DIAGNOSED BY PRINTING THE COORDINATES (tools/probes/frustum.js) after two
  rounds of reasoning about occlusion and framing had failed. When something
  is not on screen, print where it is BEFORE theorising about what is in
  front of it.
  Fixed at the call site, and `EnemyManager.spawn` now rejects a non-finite
  tier or a non-finite position with a console.error instead of building a
  live-but-nowhere entity.
  THE GENERAL RULE, now three for three in this project (loadout units, NaN
  raycast range, this): a numeric contract violated at a JS call boundary
  does not throw, it produces NaN, and NaN propagates into a state that
  reads as "working but empty". Validate at the boundary of anything that
  takes an ordered pair of same-shaped arguments.
- 2026-09-02 [tools] EVERY POSE READ `player.root.rotation.y` AS "FORWARD",
  AND IT IS 180 DEG FROM THE AIM THE CAMERA FOLLOWS. Measured immediately
  after an arena placement that asked for yaw = PI: `root.rotation.y` was 0
  while `aimYaw` was PI. So every pose that spawned "34 m ahead" put its
  enemies 34 m BEHIND THE LENS — alive, finite, on open ground, and out of
  shot.
  This is the same lesson as the existing "ROOT ROTATION IS NOT THE AIM"
  amendment, only half-learned: that one fixed WRITING the yaw (placePlayer
  now sets the rig, the entity and the controller), and nobody went back to
  fix the four poses and two probes that READ it back off the root. A
  correction that lands on the write path and not the read path leaves the
  bug live in a form that looks like someone already handled it.
  Use `debug.forward()`, `debug.right()`, `debug.aheadOfPlayer(ahead, side)`
  and `debug.yaw()`. They resolve `aimYaw` first (CameraRig writes it and the
  camera follows it) and fall back to the live camera basis. Never rebuild
  the basis from `root.rotation.y` in a tool again, and never feed
  `root.rotation.y` back into `placePlayer` — that rotates the mech by
  however far the two have drifted.
- 2026-09-02 [tools] THE ARENA SCORER ONLY VETTED GROUND OUT TO 40 m WHILE
  THE POSE SPAWNED TO 58 m, so a 49 m cliff starting at 46 m scored a perfect
  "140 m clear, zero relief". The two enemies past the edge sat 32-37 deg
  below the camera axis against a 29 deg half-FOV. `placePlayerInOpenGround`
  now takes `{ ahead, behind, step, maxRelief }`, walks in 3 m strides rather
  than 5 (a 5 m stride can straddle a ledge narrower than itself), defaults
  `ahead` to 65, and reports `vettedTo` so a pose note shows whether the
  arena was checked over the ground it actually used. A caller that places
  anything past `ahead` must raise it. Tightening from 40 to 70 m cut the
  candidate pool from 95 to 22, so the flat ground is genuinely scarce on
  this map — expect that, and do not read a small pool as a bug.
- 2026-09-03 [player/camera] THE CHASE BOOM WAS AT 13 m AND THE MECH ATE 0.63
  OF THE FRAME. Measured by projecting the mech's bounding box through the
  live camera (tools/probes/framing.js), not by eye: the mesh is 8.71 m tall
  (NOT the collider height — shoulders, weapons and boosters sit outside the
  capsule), and at 13 m with a 58 deg FOV the visible height at the pivot is
  14.4 m. An AC6 gameplay screenshot frames the player AC nearer 0.30 of frame
  height with the arena and its targets around it; at 0.63 the player mech
  simply buries the fight it is in.
  The sweep, kept here so nobody re-derives it: at 58 deg FOV, 13 m gives
  0.63, 16 m 0.51, 19 m 0.43, 22 m 0.37, 25 m 0.33, 26 m 0.31, 30 m 0.27,
  36 m 0.22. Widening the FOV moves the same curve down (66 deg reaches 0.31
  by 22 m). `distance` is now 25.0 — top of the AC6 band, and past about 30 m
  the mech is small enough that the panel and grime work stops reading at all.
  FOV was deliberately NOT changed: mech coverage is measurable, but lens
  distortion and how wide-angle sells speed are not, and `fovAssault` already
  adds 18 deg on top of the base.
  THIS ONLY BECAME VISIBLE ONCE THE COMBAT FRAME HAD A FIGHT IN IT. Two
  separate bugs (enemies spawned at NaN, then enemies spawned 180 deg behind
  the camera) had kept every gameplay capture empty, and an empty frame hides
  every composition problem in the game — there is nothing to be composed
  against. Fix what makes a frame representative BEFORE grading anything in it.
- 2026-09-03 [combat/vfx] PROJECTILES DRAW OPAQUE WITH A NEAR-BLACK TRAIL —
  a blend-state bug, not a brightness tuning problem. Each in-flight round is
  a flat opaque salmon lozenge trailed by a solid near-black tapered streak
  (shots/iter32/gameplay.png, `node tools/crop.mjs --png <it> --rect
  150,470,520,140 --zoom 2`).
  THE DIAGNOSTIC IS THE DARKNESS: additive blending computes dst + src*a and
  can only ever brighten, so an additive tracer is mathematically incapable of
  being darker than what is behind it. A black trail therefore proves the
  material is drawing with normal/opaque blending, or additive with a colour
  multiplied to ~0. No amount of brightness tuning fixes it until the blend
  state is right. Worth checking the smoothstep trap in that path too — a
  falling-edge `smoothstep(hi, lo, t)` along the trail's length parameter
  would return 0 for every fragment and zero the colour exactly this way.
  A GENERAL TEST WORTH REUSING: for any effect that is supposed to be
  additive, ask whether it is ever DARKER than its background. If it is, the
  blend mode is wrong, and that single observation skips the whole tuning
  search.
- 2026-09-03 [world] THE CLIFF STRATA ARE PRESENT AND VISIBLE — the defect is
  that they are PERIODIC. An earlier round framed this as "absent, sub-pixel,
  or present-but-unlit" and set out to measure which; with the camera pulled
  back the beds read plainly as distinct dark grooves, so it is a fourth
  thing none of those options covered.
  What is actually wrong: the bands are perfectly parallel, uniformly spaced
  and continuous across the whole ridge, curving in lockstep as it turns, so
  they read as topographic contour lines rather than rock. Hard and soft
  courses share one flat brown, so nothing but the groove distinguishes them.
  There is no vertical erosion anywhere — no gullies, talus or chutes cutting
  down across the bedding — and essentially no surface texture between
  grooves. The fix is not "add strata" but "stop the strata being a periodic
  function": vary thickness, colour and recess depth bed to bed, pinch beds
  out, and cut the horizontal banding with vertical drainage.
  METHOD NOTE: this was settled by cropping the capture at 2x
  (`tools/crop.mjs`), not by a probe. The contract already says to believe the
  image when an image and a metric disagree — the corollary is that a
  measurement run is the wrong first move when LOOKING at the right region
  answers the question outright.
- 2026-09-03 [tools] A GREEN `vite build` DOES NOT MEAN THE GAME BOOTS, and
  the standing gate has been treated as if it did. Measured: a tree whose
  `Level.build()` threw `ReferenceError: bedTint is not defined` on the first
  frame built cleanly and reported success. Vite resolves imports and parses
  syntax; it never executes a function body, so every runtime error inside one
  sails straight through.
  This matters more here than in a normal repo because several agents share
  one branch. A commit that builds but does not boot blocks everyone at once,
  and it surfaces at the END of whoever's next 100-second capture, attributed
  to whatever they happened to be editing.
  `node tools/smoke.mjs` boots the page and asserts `__ACNTR_READY__` in about
  20-30 s, printing `__ACNTR_ERROR__` and the real stack on failure; it also
  fails a scene that reaches ready with almost nothing in it, which has
  happened here too. Exit 0 booted, 1 failed, 3 server would not start, so it
  chains: `node tools/lint-glsl.mjs && node tools/smoke.mjs && git commit`.
  Use that as the gate from now on, not `vite build` alone.
  ITS OWN FAILURE PATH IS TESTED, by breaking a file on purpose and confirming
  a non-zero exit — worth doing for any checker, since a checker that silently
  passes everything is indistinguishable from a working one right up until it
  matters.
- 2026-09-03 [loot] PICKING UP ANY DROP CRASHED THE FRAME LOOP, because
  `p.body` was read in three places and never assigned anywhere. The pickup
  record is built in `_create` as
  `{root, cage, core, bandA, bandB, shards, beam, decal, halo}` — no `body` —
  while update()'s `collect` and `fade` branches both call
  `p.body.scale.setScalar(...)`. So the instant a drop was collected or timed
  out, "Cannot read properties of undefined (reading 'scale')" took the whole
  update loop down. The LOOTER half of this looter shooter did not work at
  all, and no amount of visual polish was ever going to reach it.
  `_animate`'s own doc comment had described the missing node the whole time:
  "body is the only scaled node; the beam, decal and halo hang off the
  unscaled root so their world sizes stay purely rarity-driven and the
  ground-anchoring maths stays in world units." The group was designed,
  documented, and never built.
  It cost a SECOND bug too. `spawnPart` compensated by scaling the ROOT, and
  the beam and decal are positioned in world units off `groundY`
  (`beam.position.y = groundY - root.position.y + beamH*0.5`), so on a scaled
  root every rarity except `rare` (scale 1.0) anchored its light shaft and
  scan ring off the ground — 0.82x for common, 1.42x for prototype. Building
  `body` and scaling that instead fixes both at once.
  MEASURED AFTER: 12 kills -> 12 drop events -> pickups spawn -> 3 collected
  -> inventory 4 to 7 -> equip moves 10 derived stats, with no update error.
- 2026-09-03 [method] DO NOT CONCLUDE A DROP IS BROKEN FROM ONE KILL. `mt`
  drops on a 0.48 chance roll, so a single kill yields nothing about half the
  time; a one-sample probe reported "0 pickups" and very nearly got a healthy
  drop table written up as a bug. Any system with a probability gate needs
  either a population (12 kills makes a total miss a 0.03% event) or a
  chance-free entry point — `LootSystem.dropAt` skips the roll entirely, so it
  isolates "materialising a pickup is broken" from "you were unlucky". Test
  both, and report them as separate lines.
- 2026-09-03 [combat] **`ProjectileManager._acquireTrail` WAS CALLED AND NEVER
  DEFINED**, so no missile in this project has ever flown with a trail. The
  call sits at the end of `spawn()`'s `if (def.trail)` block with no try/catch,
  which means the round threw `this._acquireTrail is not a function` BEFORE
  `this.live[this.liveCount++] = p` — its pool slot was already taken and
  never returned, and the exception unwound out through the weapon's fire
  path. That is all four missile types in `Weapons.js` plus both shells, and
  `acMissile` / `bossSwarm` / every arcing shell in `ai/Archetypes.js`.
  WHY IT SURVIVED SO LONG: review poses fire with `debug.fireAll()`, and the
  player's shoulder racks are `requiresLock`, so the player half never
  reached the line; the enemy half did, but a thrown spawn just means one
  fewer projectile and there is nothing in a frame, a draw-call count or a
  console log that says a missile is missing. Diagnosed in one probe by
  calling `spawn` twice with defs identical apart from the `trail` block and
  printing the exception (`tools/probes/tracer.js`).
  Generalises the "validate at the boundary" rule this file already carries:
  A METHOD THAT DOES NOT EXIST IS NOT A SYNTAX ERROR IN JS. It is a runtime
  throw on a path that may be rare, and if that path is inside a system whose
  failure mode is "slightly less happens", nobody notices. Worth a sweep of
  the same shape as the NEVER-CALLED-SETTER one, in the other direction:
      grep -ohP 'this\._[a-zA-Z]\w*(?=\()' src/**/*.js | sort -u
  and check each has a definition in its own class.
- 2026-09-03 [combat/ai] **A HEX COLOUR CANNOT BLOOM.** `Color.setHex` decodes
  sRGB into the LINEAR working space under ColorManagement, so its brightest
  channel is exactly 1.0 by construction — and `Pipeline.params.bloom.threshold`
  is 1.90 SCENE-LINEAR. Anything whose colour arrives as a hex is therefore
  below the prefilter and physically cannot spill light, whatever it looks
  like in the source. Measured on the live scene: an enemy tracer's instance
  colour read (1.00, 0.45, 0.10) and moved the frame by 24 code values, while
  a player motor flare (an HDR array in `Weapons.js`, x1.6) moved it by 198.
  EVERY weapon in `ai/Archetypes.js` and EVERY telegraph colour is a hex, so
  the entire enemy half of a firefight was un-bloomable LDR paint — which is
  most of what "no bloom or halo on any emissive" was in the review frames.
  `ProjectileManager.spawn` now treats "peak channel <= 1" as *this is a hue,
  not a radiance* and lifts it to `HDR_HUE_GAIN` (3.2) before the per-material
  gain; `Telegraphs` applies its gain in the shader. If you author a colour
  for anything additive, write it as an HDR array — a hex is a hue.
- 2026-09-03 [combat/ai] **THE RED ARCS IN THE COMBAT FRAME ARE NOT TRACERS.**
  Two review passes attributed them to `ProjectileManager`; they are
  `Telegraphs` (aim lasers and ballistic-arc warnings), which lives in
  `src/ai/EnemyManager.js`. Established by A/B rather than by argument: hiding
  each projectile InstancedMesh in turn accounted for every other bright
  element in the frame and left the arcs untouched.
  While you are in there: the same A/B named the OTHER two things in that
  frame. The "flat salmon lozenge" is `_im.flare` (the motor glow) and the
  "solid near-black tapered streak" is `_im.missile` — a lit PBR body which,
  because every enemy weapon def omits `width` and `length` and the fallbacks
  were a tracer's (0.1 x 3), drew as a 3 m 30:1 dark splinter reading 6,8,24
  against a 239,195,161 sky. Body dimensions now derive from the round's own
  `radius`.
  THE LESSON IS THE ONE ABOUT PRINTING COORDINATES, one level up: when a
  frame contains an element you cannot name, do not reason about which system
  "probably" draws it — hide the candidates one at a time and read the
  framebuffer. `tools/probes/tracer.js` does this and reports changed-pixel
  counts, whether the mesh brightens or DARKENS the frame, and the before/after
  colour at the biggest delta. "Darkens" is by itself a complete diagnosis for
  anything claiming to be additive: `dst + src*a` cannot go down.
- 2026-09-03 [combat] SOLID GEOMETRY WEARING A `MeshBasicMaterial` IS THE
  DEFAULT-THREE.JS LOOK, and it was on every projectile, every beam and every
  telegraph. One flat colour across a hard silhouette has no cross-section, no
  falloff and no core, so it reads as vector art no matter how bright it is.
  The fix that works for tubes and blobs alike is `|N·V|`: it is 1 where the
  surface faces the lens and 0 at the silhouette, so `pow(|N·V|, k)` dissolves
  the edge and concentrates the middle. TWO exponents on that one term give
  the tight-hot-core / wide-soft-skirt shape REVIEW.md demands, from a single
  draw. `projectileVert`/`projectileFrag` (instanced, with a head-bright axial
  profile and a vertex-stage tail pinch so a tracer is a wedge, not a bar) and
  `telegraphVert`/`telegraphFrag` (non-instanced, +Y axis, marching dashes) in
  `vfxShaders.js`. Note the axis conventions differ and are load-bearing:
  projectile tubes are built about +Z because `_draw` aims them with
  `setFromUnitVectors(UNIT_Z, dir)`; telegraph lines are about +Y because
  `Telegraphs.line` uses `setFromUnitVectors(UP, dir)`.
  Also: a 6-sided cylinder quantises a per-fragment `|N·V|` into visible
  facets. Everything on this path is now 12-sided, and the flare/plasma
  icosahedron went to detail 2 — its normals were already analytic, but a glow
  that runs blown-out shows its POLYGON where the clipped core ends.
- 2026-09-03 [combat] `ProjectileManager._fxTrail` DELETED — it had no caller
  anywhere in `src` or `tools`, and called two VFX methods with the wrong
  signatures: `v.trail(pos, dir, color, width)` against `trail(target, opts)`,
  so the direction vector arrived as the options object and every weapon's
  authored trail colour and width were silently replaced by the default
  preset; and `v.smoke(pos, number)` against `smoke(pos, opts)`. Dead code
  that looks like the working path is worse than no code: it is where the next
  person goes to find out why trail colours do not apply.
- 2026-09-03 [loot/ui] THE LOOT CHAIN IS INTACT END TO END — verified, so
  nobody re-derives it. Enemies die -> LOOT_DROP fires -> pickups spawn ->
  walking over one collects it -> it reaches `loadout.inventory` -> the garage
  lists all ten slots with their equipped parts -> `_equip` moves 17 derived
  stats -> the slot reflects the new part -> close returns to 'playing'. The
  only thing that was ever broken in it was the missing `body` node recorded
  above, and that is fixed.
  ONE TRAP FOR ANYONE PROBING THE UI: the garage renders `div.g-slot`
  carrying `data-slot`, NOT `.part` / `.item` / `li` / `button`. A probe
  guessing those selectors matched nothing and reported "0 clickable rows"
  for a screen that was drawing all ten slots correctly. A selector that
  matches nothing is indistinguishable from a UI that renders nothing — dump
  the DOM before believing a zero.
  Also: `candidatesFor('head')` returning 0 is CORRECT when the starter
  inventory holds no spare head. An empty candidate list is not evidence of a
  broken garage.
- 2026-09-03 [render/world] THE SKY'S CLOUDS ARE CORRECT AND DELIBERATELY
  MASKED NEAR THE HORIZON. Do not "fix" them. The gameplay frame's sky is a
  near-uniform pink-grey with no cloud structure, which reads as a broken
  cloud layer; the live uniforms say cover 0.52, opacity 0.86, palette
  separated 0.062 -> 0.42, and every smoothstep in sky.js has ascending
  edges. `tools/poses/sky.js` points the camera up 34 deg and the deck is
  plainly there.
  It is held out of the low sky on purpose. `cp = V / (0.85*up + 0.22)` makes
  cp.x and cp.z run away as a sight line flattens while cp.y barely moves —
  8:1 anisotropy by up = 0.25 — so the deck drew as vertical CURTAINS in any
  near-horizontal framing. `cl *= smoothstep(0.03, 0.40, up)` is the fix for
  that, and the near-horizon sky is carried by the stratified dust bands
  instead. Lowering that edge reintroduces the curtains. If the low sky needs
  more structure, the bands are the thing to work on, not the cloud deck.
- 2026-09-03 [render] THE AERIAL IN-SCATTER HUE IS NOT WHY THE DISTANT BUTTES
  READ AS CUT-OUTS. Recorded as a MEASURED DEAD END so it is not tried again.
  The hypothesis was reasonable: `_aerialColor` is (0.16, 0.17, 0.19), cool
  and dark, while the sky's horizon is (0.285, 0.262, 0.23), warm — and a
  landform at 1.5 km is ~95% veiled, so the in-scatter IS its colour.
  Converging distant terrain to a cool grey against a warm sky should make it
  diverge from its own background. So the term was split into horizon and
  zenith colours blended by the view ray's elevation, keeping the
  cool-with-height depth cue while matching the warm sky at the horizon.
  MEASURED RESULT: about one code value. On the gameplay frame the left butte
  went rgb(143,139,136) -> rgb(143,138,135); the near ridge and the deck did
  not move at all. Reverted.
  The reason the hypothesis failed is in the numbers that motivated it: the
  sky01 sample that showed a neutral butte against a warm sky was taken at
  roughly 45 deg elevation, in a pose pitched up 34 deg — not where the
  buttes actually sit. In the gameplay frame the buttes are already within 4
  luma and 3 chroma of the sky beside them (butte 143,139,136 vs sky
  147,142,136). They are not diverging in hue OR value.
  SO THE "FLAT PALE CUT-OUT" READ IS ABOUT INTERNAL DETAIL AND SILHOUETTE,
  not aerial colour. At that veil there are only a few code values to work
  with, so what is left has to be spent on shape: crest-to-toe ramp, a turned
  anisotropic plan, and overlapping silhouettes at different ranges. Level.js
  `_distantButtes` already argues exactly this; believe it.
  METHOD: sample the pixels before believing a hue story, and sample them in
  the frame the complaint is actually about.
- 2026-09-03 [physics] THE TWO PHYSICS BUGS FLAGGED FROM OTHER MODULES ARE
  ALREADY FIXED — do not re-fix them. `Physics.raycast` rejects a non-finite
  or non-positive `maxDist`, a null/NaN origin and a NaN direction at the top
  and returns null (commit aa24bf3), and `Physics.floorHeight(x, z, fromY,
  opts)` exists and casts DOWN from a height the caller supplies, with
  `groundHeight`'s doc comment now saying loudly that it returns the TOP of the
  column and pointing at the new method. Both were still listed as open in a
  briefing written after they landed. WORTH GENERALISING: a defect recorded in
  a shared file outlives its own fix unless the fix is recorded next to it, and
  the cost of the stale entry is a whole agent-session spent re-deriving
  something that is already true.
- 2026-09-03 [world] THE DISTANT BUTTES ARE 19 LUMA **DARKER** THAN THE SKY,
  NOT BRIGHTER, AND THEY STILL READ AS PALE CUT-OUTS. Measured on
  `shots/L42/cliff.png` over a 120x90 patch of the big butte and the sky either
  side of it:
      butte  rgb(139,136,137)  luma 136.4  sd 2.05  range 133..140
      sky    rgb(168,154,139)  luma 155.8  sd 4.14
  Two things follow and they are both worth having.
  (1) THE EYE IS WRONG ABOUT THE VALUE. In the frame the buttes look like pale
  paper laid over a darker sky; they are in fact the darker of the two. What
  makes them read pale is CHROMA: butte R-B is 2, sky R-B is 29, so a neutral
  cool patch sits inside a warm field and simultaneous contrast does the rest.
  Anyone about to "bring the buttes down" is about to make the frame worse.
  (2) THE FLATNESS IS NOT A FIGURE OF SPEECH. sd 2.05 with a seven-code-value
  total range across the whole visible face, against sd 7.29 on the cliff ring
  face at half the distance and sd 16.3 on its crest. The vertex ramp
  `_distantButtes` builds (0.44..0.9 of shade, plus beds, scree and a
  crest-to-toe term) is real in the buffer and arrives as ~2 code values after
  a 92-95% veil. NOTHING PAINTED ON THAT SURFACE CAN SURVIVE. The silhouette is
  the only channel left with full contrast, because an edge between the butte
  and the sky carries the whole 19 luma however veiled the interior is.
  So the work goes into the OUTLINE and into OVERLAP, not into interior value.
- 2026-09-03 [tools] `debug.holdKeys` CANNOT TEST ANY `input.hit()` BINDING,
  and that is why discrete actions have gone unverified. `holdKeys` adds to
  `input.keys`, which is what `input.down()` reads. Every one-shot binding in
  this game — mute, the garage toggle, every discrete action — is written
  against `input.hit()`, which reads `input.pressed`, a different set that
  `endFrame()` clears every frame. A test that "pressed" a key with
  `holdKeys` therefore reported nothing happening for a binding that was
  entirely correct, and nearly got a working feature rewritten.
  Use `debug.tapKeys(codes)`. It injects the keydown EDGE, runs exactly one
  frame, and cleans up. One frame is deliberate: holding `pressed` across
  several frames fires a one-shot action repeatedly and tests something the
  real input layer can never produce.
- 2026-09-03 [audio] THE AUDIO SYSTEM WORKS AND NOTHING COULD REACH IT. Four
  thousand lines across AudioDirector, Sfx, Synth and Music, with
  `setVolume`, `setMuted`, `toggleMute` and a `_saveSettings` that persists
  them — and `setVolume` had NO caller anywhere in src/, `setMuted` had
  exactly one (`toggleMute`), and `toggleMute` had none. There was no way for
  a player to mute the game or change its volume.
  The implementation being fine is what made it invisible: a probe
  (tools/probes/audio.js) confirms the AudioContext is running at 44.1 kHz,
  every bus is connected with sane gains, and a mute round-trips correctly.
  Only the binding was missing, and no screenshot can show that a key does
  nothing.
  Now bound in `Game._audioKeys`: M toggles mute, Minus and Equal move the
  master volume in 0.1 steps, each with a mission-log line, and a volume-up
  un-mutes so "louder" never returns silence.
  HANDLED AT THE TOP OF `addUpdate`, BEFORE THE STATE BRANCHES — not in
  lateUpdate. The garage and non-playing branches each call
  `input.endFrame()` and return, which clears `pressed`, so a lateUpdate
  check would never see the key in those states; and the garage is exactly
  where someone reaches for the mute. Verified by tapping M while in the
  garage state.
  NOTE ON THE PROBE: `_voices` is a fixed 48-slot pool, so its length is the
  same before and after firing sound events. That measurement is
  INCONCLUSIVE about voice activity, not negative — do not read it as "audio
  events do nothing".
- 2026-09-03 [render/tools] **THE GAMEPLAY FRAME'S PROBLEM IS ITS WHITE POINT,
  NOT ITS BLACK POINT** — measured, because "global contrast is low" had been
  restated four times without anyone saying which end was missing.
  `tools/retransfer.mjs` now takes `--rect name:x,y,w,h` (repeatable) and
  reports the same statistics over a screen rectangle as over the whole frame,
  plus a HIGH line (>160 / >192 / >224, mean RGB, p1-p99 range) next to the
  existing TOE line. The rect is a MEASUREMENT MASK, not a crop: the grade is
  still inverted from each pixel's true screen position, because the vignette
  and the damage rim are functions of that position and cropping first would
  undo them at the wrong radius.
  THE FIRST THING IT FOUND IS THAT THE HUD WAS IN EVERY NUMBER. The capture is
  a page screenshot, so the DOM HUD is composited into the PNG, and it is the
  only thing in the shot that reaches code 255 — the whole-frame `at-255` and
  `SHOULDER` figures every previous grade decision was argued from are the HUD,
  not the render. Use `--rect noHUD:0,120,1920,760` for anything about tone.
  MEASURED on shots/iter34/gameplay.png, luma percentiles p1/p5/p50/p95/p99:
      whole frame   15 / 24 / 104 / 145 / 156
      3D only       20 / 29 / 108 / 145 / 155
      sky patch    120 /124 / 134 / 146 / 151   (internal p1-p99 range: 31)
      near ridge    79 / 88 / 111 / 128 / 133
      deck          10 / 14 /  33 /  74 / 104
  So the 3D frame spans 135 code values and 0.42% of it is above 160, 0.05%
  above 192. The BLACK POINT IS FINE — the deck runs a quarter of its pixels
  under 24 — and the frame has no highlight at all.
  The transfer curve is not what is holding it down. `tools/grade-model.mjs`
  says the shipped grade puts scene-linear 0.18 at code 132, 0.36 at 174, 0.72
  at 213, and does not clip until 3.2 — a healthy 4.1 EV shoulder that nothing
  in the frame is using. Inverting the measured pixels: the horizon sky is only
  0.19 scene-linear and the near ridge 0.13, i.e. THE BRIGHTEST LARGE SURFACE IN
  THE FRAME SITS AT MIDDLE GREY and the whole visible scene lives in the two
  stops below it. That is a scene/exposure placement problem, not a curve shape
  problem, and it is why every previous attempt to buy contrast with `contrast`
  moved the frame by single code values.
- 2026-09-03 [render] **THE RED EDGE IS THE DAMAGE RIM AT NEARLY FULL STRENGTH,
  NOT THE VIGNETTE.** Three review passes have called for the vignette to be
  softened. `params.vignette` is a NEUTRAL multiply (amount 0.26) and cannot
  tint anything; the red belongs to `uDamage`, which FINAL_FRAG screen-blends
  with `uDamageColor` (0.85, 0.06, 0.05).
  MEASURED by sampling the sky along the top of shots/iter34/gameplay.png in
  200x90 rects: R-G is 18.0 at the left edge and 13.2 at the right, against 1.6
  to 4.7 anywhere in the middle third. Solved for the strength by undoing the
  rim offline at a range of assumed values (`--dmg X --map 'damage=0'`): the
  edge hue matches the middle only at `uDamage` ~0.85-0.95, i.e. the term was
  PINNED AT ITS CEILING when the shot was taken.
  It gets there legitimately, which is the actual defect. `_dyn.hit` takes +0.6
  per `EV.PLAYER_HIT` up to a 1.2 cap and decays at 2.6/s, and `uDamage =
  crit*0.55 + hit*0.65`, so two hits inside half a second pin the rim at 0.78
  and four engaged enemies hold it there indefinitely. What is supposed to be a
  hit FLASH is a red filter for the whole firefight — and every gameplay
  capture this project has graded was shot through it.
  `EV.QUICK_BOOST` also bumps the same `hit` accumulator (+0.16), so BOOSTING
  paints a damage-coloured rim as well.
- 2026-09-03 [tools/ui] EVERY KEY BINDING IN THE GAME IS VERIFIED WORKING —
  13 of 13, `tools/probes/bindings.js`, re-runnable. KeyG opens the garage
  from play (the one that matters most: this is a LOOTER shooter, and if that
  key is dead every part the player collects is unreachable), Escape closes
  it, ArrowUp/Down move the selection, Enter equips it, Tab filters, KeyF
  sorts, and M / Minus / Equal drive audio in BOTH the playing and garage
  states.
  Note KeyG is bound in `HUD.update`, not in Game — its own comment says
  "Game may also map G", which Game does not. Nothing is wrong with it, but
  that is not where anyone would look.
  THE SWEEP PRODUCED THREE FALSE ALARMS BEFORE IT PRODUCED A RESULT, all the
  same mistake in different clothes — asserting on a proxy instead of on the
  thing:
    * `KeyF` reported inert because the snapshot compared TEXT LENGTH, and
      the sort label cycles "SORT: TIER" -> "SORT: NAME", which is the same
      length. Hash the content, never its length.
    * The arrow keys reported unjudgeable because the cursor field guess list
      omitted `selIndex`, the actual field.
    * `Enter` reported inert because it ran AFTER Tab had moved the filter to
      a category holding none of the starter parts, so `_rows` was empty and
      the test was measuring its own setup. It now runs first and asserts on
      `loadout.slots[slot]`, not on the rendered panel.
  Same family as the garage probe that guessed `.part` / `.item` selectors and
  reported "0 clickable rows" for a screen drawing all ten slots. THE RULE: a
  guessed selector, field name, or length proxy is a HYPOTHESIS. When a probe
  says a feature is dead, verify the probe before believing it — three times
  now the probe was wrong and the feature was fine.
- 2026-09-03 [ai] THE MISSION LOOP WORKS END TO END — measured, so nobody
  re-derives it. `tools/probes/waves.js` starts the encounter, kills each wave
  through the damage system (the same path a player's shots take, so the death
  bookkeeping the director depends on actually runs) and watches the phase
  machine. Result: idle -> spawning -> fighting -> breather across all five
  waves, reaching `complete` in 44.8 simulated seconds and 17 kills, with no
  step errors. The HUD's "WAVE 01" really can become 05.
  The probe is bounded in SIMULATED time and reports a stuck director as
  stuck rather than hanging, so it is safe to re-run as a regression check
  after any change to Encounters, EnemyManager or DamageSystem.
- 2026-09-03 [loot/game] THE BUILD AND SALVAGE NOW PERSIST. `Loadout.toJSON`
  and `fromJSON` existed from the start — the latter carefully written to drop
  unknown parts rather than throw — and NOTHING CALLED EITHER. Every part
  collected and every garage swap was discarded on reload. In a LOOTER that is
  not a missing convenience, it is the progression: the drop tables, the
  rarity tiers and the whole garage exist to accumulate something, and nothing
  accumulated past a refresh.
  Third instance of the same shape today, after the loot pickup's missing
  `body` node and the audio bindings: THE HARD PART WAS WRITTEN AND THE ONE
  LINE THAT REACHES IT WAS NOT. When a subsystem looks finished, check who
  calls it before checking whether it works.
  Wired in `Game`: `_restoreLoadout()` runs BEFORE `buildPlayer` so the parts
  the player is wearing are the ones fabricated; `_wireSave()` coalesces
  BUILD_CHANGED and LOOT_PICKUP onto a 400 ms timer (both fire several times
  in a frame — a wave's drops collected together, or a swap that recomputes)
  and also saves on visibilitychange and pagehide so a tab closed mid-mission
  keeps its salvage. Key `acntr.save.v1`, version-checked on load so a payload
  from a different part schema is ignored rather than half-applied.
  Every path is defensive: `localStorage` THROWS outright in a private context
  or with site data blocked, and a half-written value parses to garbage.
  Neither is a reason to refuse to start — a failed restore just leaves the
  starter build.
  VERIFIED ACROSS A REAL RELOAD, not in memory: equip a part through the
  garage (rArm SCUDDER -> HAMMERHEAD), reload the page, and the slot still
  reads HAMMERHEAD with the inventory count intact. An in-memory round trip
  would have proven nothing, since the defect was that nothing ever wrote.
- 2026-09-03 [process] AGENTS SHARING A BRANCH RUN `git add -A` AND WILL SWEEP
  UP YOUR UNCOMMITTED WORK. The save wiring above was written here and landed
  inside an agent's commit about a capture pose, under a message that does not
  mention it. Nothing was lost, but the history now misdescribes itself.
  Commit your own files by explicit path (`git add src/game/Game.js ...`) and
  commit them PROMPTLY — on this branch an unstaged file is not private, it is
  just unattributed.
- 2026-09-03 [combat/vfx] CORRECTION TO A DIAGNOSIS I GAVE THE VFX AGENT: THE
  EXPLOSION CORE IS NOT CLIPPED. I described it as "fully clipped to white
  across a large disc" from looking at the frame. Measured on
  shots/iter36/gameplay.png: ZERO pixels have all three channels >= 250, and
  only 0.45% of the frame reaches >= 235. iter35 was 0.22%, iter33 0.00%. So
  the highlight is bright and growing but it is not blowing out, and tuning
  the core down is the WRONG fix.
  What is actually wrong is COMPOSITION, not exposure. The flash is centred on
  the player mech and its bloom skirt is wide, so a small unclipped core hides
  the subject behind a large soft veil. The levers are the skirt's RADIUS and
  its falloff, and where the effect sits relative to the mech — not the core's
  brightness.
  THE METHOD ERROR IS THE POINT: "it looks blown out" and "it is blown out"
  are different claims, and only one of them is checkable. A histogram or a
  clipped-pixel count answers it in seconds. This is the same trap as the
  butte hue story earlier today — an impression from a full-size frame, stated
  as a measurement, that the numbers then refuted. Count the pixels before
  telling anyone what to change.
- 2026-09-03 [render/tools] **`tools/skysim.mjs` — SKY_FRAG EVALUATED ON THE
  CPU, so a sky question costs eight seconds instead of a Chromium capture.**
  Same argument `tools/grade-model.mjs` makes for the transfer curve, one layer
  up: the sky is a closed-form function of the view ray and ~20 uniforms, and
  on this box a capture is 60-100 s and has killed the container when two ran
  at once. The uniforms are PARSED out of `src/render/Sky.js` and the vignette
  out of `Pipeline.js`, so the palette cannot silently drift; the shader body is
  transcribed by hand and CAN, which is what `--compare` is for.
      node tools/skysim.mjs --pose vista --out /tmp/sky.png \
        --compare shots/iter36/vista.png --rect skyUpMid:760,60,400,110
  VALIDATED against shots/iter36/vista.png, sim vs capture, mean display luma
  over pure-sky rects: 159.9 / 157.9 mid-frame, 109.5 / 108.6 upper left,
  205.1 / 211.0 upper right near the sun (the sim reads low there because bloom
  is the one term it does not model). Standard deviations agree to ~1.
  `--term cloud|band|veil` renders one term of the shader as a mask, which is
  how you find out where a term is actually reaching. Rect coordinates are
  always full-frame 1920x1080 whatever `--width` is, so a half-res sim (3 s)
  compares directly against a full-res capture.
  WHAT IT CANNOT DO: match the noise PHASE. `hash13` is a `fract()` of a
  product, so float32-with-FMA on the GPU and doubles in JS put an individual
  wisp in a different place. Everything statistical — orientation, spatial
  frequency, contrast, footprint — does match. Do not read it for "is that
  specific streak at x=180".
- 2026-09-03 [render/world] THE FAINT CURVED STREAKS IN THE VISTA'S LEFT SKY
  ARE NOT IN THE SKY, AND ARE NOT REPRODUCIBLE. Four things are now measured
  about them, so the next person starts from here.
  (1) NOT THE SKY SHADER. `tools/skysim.mjs` evaluates SKY_FRAG over the vista
  frustum and agrees with the capture to 1-6 code values on pure sky, and it
  shows only horizontal strata in that region — no fan, at any uTime tried.
  (2) NOT THE CLOUD DECK, so nobody needs to touch the 0.03/0.40 elevation
  fade the amendment above protects. `--term cloud` is exactly 0 below
  up = 0.03 and smooth blobs above it; the deck contributes nothing where the
  streaks are.
  (3) THE REGION IS GEOMETRY, NOT SKY. Sim vs capture over rect 60,340,220,110:
  the sim (bare sky) says luma 143.4, the capture says 94.1. Forty-nine code
  values of something opaque — the distant landform, seen at ~98% veil.
  (4) NOT THE ARENA CURTAIN, which was the obvious suspect: a raycast through
  the streak pixels (`tools/probes/fanstreak.js`) reports Level's
  `ContainmentField` at ~600 m on 25 of 26 rays. Hiding it changes NOTHING —
  `tools/poses/fan_base.js` vs `fan_nofield.js`, differenced, is grain and
  nothing else in that rect.
  AND THE STREAKS ARE NOT IN `fan_base` EITHER, which is the vista pose byte
  for byte. Contrast-stretched they resolve into a regular DIAGONAL LATTICE
  WITH BRIGHT NODES AT THE CROSSINGS, ~18-25 px apart, over the distant
  landform — the signature of a triangulated heightfield at grazing incidence,
  not of anything in post. Two things differ between the iter36 run and the
  clean one: the working tree's Level.js/Structures.js have moved since
  (2.57 M triangles then, 2.95 M now), and iter36's vista ran straight after a
  93-second `gameplay` pose. If it returns, it is a TERRAIN TESSELLATION
  question and belongs to the level agent — start by checking whether it
  survives a capture of `vista` alone.
  METHOD NOTE: the useful discriminator was not any of the theories, it was
  the CPU sim. "Is this pixel sky?" is answerable exactly and offline, and it
  turned a sky bug into a terrain bug before a single frame was captured.
- 2026-09-03 [combat/vfx] THE EXPLOSION IS NOT A FLAT WHITE SPHERE, AND
  DELAYING ITS SMOKE MAKES IT WORSE. Two wrong readings and one reverted
  change, all recorded so nobody repeats them.
  `tools/poses/explosion.js` is the tool that settled it: six detonations
  fired at staggered times and frozen together, so one capture shows ages
  0.05 / 0.15 / 0.30 / 0.50 / 0.80 / 1.20 s side by side. On a box that
  renders at ~10 fps, no sequence of single-age captures can do this.
  WRONG READING 1: "the explosion is a featureless white sphere." That frame
  was the FLASH. `VFX.explosion` gives it a life of 0.06 and 0.105 s and one
  frame here IS 100 ms, so the gameplay pose photographed the first tenth of
  a 500 ms effect. The flash is white-hot by design. Same trap muzzle.js
  documents; it has now cost two rounds.
  WRONG READING 2: "the fire dies too fast and dark smoke buries it." The
  rolling smoke does reach 0.78 alpha within 0.1-0.2 s (fadeIn 0.07 of a
  1.4-3.0 s life) while the fireball is still hot, which reads like an
  obvious occlusion bug. It is not. That smoke's `color0` is (0.34, 0.155,
  0.065) — warm brown, "fire-lit at birth, cold soot at death" as its own
  comment says — and IT IS WHAT CARRIES THE EXPLOSION'S COLOUR.
  MEASURED, on warm-and-bright pixel counts per detonation box: raising
  `fadeIn` to 0.30 (rolling) and 0.22 (lingering) took t=0.05 s from 3484 hot
  pixels to 209, and t=0.15 s from 2799 to 12. A ~95% loss of the fire read.
  Reverted.
  SO: the fire you see in an explosion here is mostly LIT SMOKE, not the
  additive core. Anything that delays, dims or thins the early smoke removes
  the explosion. If the fireball phase needs to read longer, lengthen the
  warm phase of the smoke's own colour ramp — do not get the smoke out of the
  way.
  METHOD: count warm-bright pixels in a box per age. Eyeballing the filmstrip
  said the change had helped; the count said it had destroyed the effect.
- 2026-09-03 [world] CORRECTION: CUTTING `uDetail.w` DID NOT FIX THE BIMODAL
  GROUND. The reasoning behind it is sound arithmetic — 0.62 of relief, times
  the near boost and tap weights, reaches 1.13 of xz offset, which is 48
  degrees of flank, and at a 13.5 degree sun that swings a fragment from
  self-shadowed to three times base. It was committed with that arithmetic
  written up as the cause. The follow-up measurement says otherwise: cutting
  the near-field relief by 4.8x moved the statistic by HALF A CODE VALUE, and
  zeroing EVERY term that perturbs the normal — base triplanar strength, both
  detail relief taps, both ripple trains — moves it five percentage points out
  of forty-six.
  So the lit ground's bimodality is NOT a lighting or normal term. That leaves
  the dust map's own albedo, which is directly readable: the forge writes to a
  canvas, so the bytes can be measured without rendering anything
  (`tools/probes/dustmap.js`), and `tools/probes/groundterms.js` hides the
  candidates one at a time and reads the framebuffer.
  The change itself is kept — 48 degrees of flank on flat sand is wrong on its
  own terms, and 0.13 still breaks the shading terminator off the 5 m quads,
  which is all that layer needs to do. But it is NOT the fix for the crocodile
  skin, and the next person must not assume that problem is solved.
  THE PATTERN, now four for four today: correct-looking arithmetic about a
  term is a HYPOTHESIS about the image. Measure the image before and after,
  not just the term.
- 2026-09-03 [world] **THE "UNTEXTURED GREY DOMES" ARE `S.tank` ROOFS, NOT
  `S.sphereTank`.** sphereTank was fixed for this complaint once already and
  carries its own writeup, so the next person to read "the storage domes are
  featureless" goes and looks at the wrong function. The shapes in the gameplay
  frame's left third are cylinder-plus-hemisphere: `phi: PI/2` at the shell's
  own radius, which on the tank farm's 12-16 m radii gives a smooth ball of
  height `r` on a cylinder of height `h` and hands a third to a half of the
  whole silhouette to one surface with exactly one shading gradient across it.
  THE PLATE MAP IS ON IT. "It has no texture" and "the texture is applied" were
  both true: 30 m of low-contrast mottle under a 90% veil is nothing.
  A welded storage tank has a SHALLOW dished roof — plate pressed to about
  1.55x the shell radius, so the rise is 0.37 r rather than 1.0 r, meeting the
  shell at a compression ring. That turns the dome from half the shape into a
  lid, and the detail then lands where it can be read: a wind girder and a
  compression ring (two hard horizontals at the eaves), twelve chorded radial
  plate seams converging on a railed crown, roof nozzles, a stair-head landing,
  and one vertical downcomer on a shell that was otherwise all horizontals.
  `tools/poses/tanks.js` frames the district (D_TANKS, 210 m standoff,
  cross-lit); shots/L46/tanks.png is the after. GENERALISES: when a shape reads
  as untextured, ask whether the SHAPE is one unbroken surface before you go
  looking for the map, and confirm which builder drew it before editing one.
- 2026-09-03 [world] **THE TERRAIN'S BASE `normalStrength` WAS THE CROCODILE
  SKIN — 1.35, now 0.45.** MEASURED on shots/L48/ground.png, a 360x220 patch of
  SUNLIT dune at 20-40 m: mean 70.9, sd 49.2, p1/p10/p50/p90/p99 =
  5/14/65/139/165, 41.7% under code 40. Its tenth percentile (14) is BELOW the
  tenth percentile of the deep-shadow ground beside it (15) — that is not
  texture, it is holes. After: sd 30.4, p1 13, p10 24, under-40 22.9%, mean
  essentially unchanged at 67.8.
  **THE METHOD MATTERS MORE THAN THE NUMBER. Every relief argument in
  Terrain.js reasons in "degrees of flank" from a coefficient, and the
  magnitude that coefficient multiplies had never been measured.** Assuming
  |xy| = 1 made the near-field detail term look like 48 degrees, so it was cut
  4.8x first — and a fresh capture moved the dune's sd by 0.6 of a code value.
  NEGATIVE RESULT. `tools/probes/dustmap.js` reads the forge's canvas directly:
      dust normal |xy|  mean 0.224  p90 0.338  p99 0.416
      dust albedo       sRGB p1..p99 = 46..62, sd 4.4  (albedo cannot be it)
  So the detail term was 9-10 degrees and the BASE triplanar term was 17
  typical / 29 at p99. At a 13.5 degree sun N.L on level ground is sin(13.5) =
  0.233, and 17 degrees is the difference between self-shadowed and twice base.
  IF YOU TOUCH ANY RELIEF COEFFICIENT ON ANY SURFACE IN THIS PROJECT, measure
  the map's |xy| first — the same reasoning applies to every normalScale in
  Level._makeMaterials and on the mech.
- 2026-09-03 [tools] `tools/probes/groundterms.js` A/Bs each perturbation term
  in the terrain shader by zeroing its uniform and reading the framebuffer.
  ITS OWN FIRST RUN IS THE LESSON: it placed the camera with
  `debug.placePlayerInOpenGround`, which SCORES SPAWN POINTS and therefore
  prefers megastructure decks (already recorded under the ground-pose
  amendment), so it pointed the lens at a roof and reported all nine cases
  identical to five significant figures — which reads exactly like "none of
  these terms does anything". **A control case that cannot move is a broken
  probe, not a finding.** Any A/B of this shape needs an `everything=0` case
  and must fail loudly when it matches the baseline.
- 2026-09-03 [world] THE PLATEAU HAD NO NATURAL SCATTER AT ALL. Every prop in
  `_buildProps` was man-made and rectilinear and clustered on district pads, so
  a 30 m patch of ground contained one uniform stipple and nothing else — no
  silhouette, no contact shadow, nothing at the 0.3-3 m scale that says how big
  the mech is. `S.boulderGeo` (a displaced, flat-shaded polyhedron) now feeds
  two scatters: 1 900 boulders that cast, 22 000 pebbles that do not, placed in
  DRIFTS by a two-sinusoid mask for the same reason the butte ring is
  clustered — a constant-density scatter has no read of wind having put it
  there. Two things worth carrying:
  (1) THE DISPLACEMENT MUST BE A FUNCTION OF VERTEX POSITION, NOT INDEX.
  `PolyhedronGeometry` is non-indexed and duplicates every shared corner once
  per face; a per-index displacement tears the hull into loose triangles, a
  per-position one moves the duplicates identically. `computeVertexNormals` on
  the non-indexed result then gives per-face normals for free, which is the
  faceting a fractured rock wants.
  (2) **THE TRIANGLE BUDGET OF A SCATTER IS SET BY THE SHADOW CASCADES.**
  Measured: 620 casting boulders at 80 triangles each added 393 k triangles to
  the ground pose, not the 50 k the geometry implies — a caster is re-submitted
  once per cascade, about 5x its own mesh. Dropping the boulder to a 20-face
  icosahedron bought back 480 k and paid for four times as many pebbles. Ground
  pose: 2.90 M -> 3.24 M triangles, 346 -> 352 draw calls.
- 2026-09-03 [world] THE BUTTE CAP TILT WAS ALREADY IMPLEMENTED WHEN A BRIEFING
  SAID IT WAS NOT — it landed in 2d2c22a at 10:44 and iter36 was shot at 16:05,
  so the frame has it. Third instance today of a defect outliving its own fix in
  a shared document. What the frame lacked was a tilt you could SEE: two
  independent uniforms on [-a, a] put the JOINT magnitude near zero far more
  often than either axis is near zero, so about a fifth of the ring came out
  under 1.5 degrees of lean, and a group where some caps lean and some do not
  reads as a mistake rather than as geology. Now sampled as a dip AZIMUTH plus a
  magnitude with a floor. The magnitude is budgeted against the existing "no cap
  below the vista camera" height floor rather than fighting it: a dip drops one
  side of the rim by about `dip * 0.95 r`, a butte that cannot afford that out of
  its own relief gets less dip, and the floor rises by whatever drop is left.
  ANY future "make it more random" change to a two-axis quantity should be
  sampled as direction + magnitude for the same reason.
- 2026-09-04 [render] **THE NEAR-HORIZON SKY WAS FLAT BECAUSE OF A GAP BETWEEN
  TWO CORRECT DECISIONS, AND THE NUMBER IS 0.85 CODE VALUES.** "Flat" had been
  restated for several passes without anyone saying how flat; the metric that
  answers it is the standard deviation of the sky's stratification — a vertical
  high-pass, because strata are horizontal and a 2-D blur wide enough to pass a
  50 px band also averages along it and reports a flat sky for one that is not.
  MEASURED with tools/skysim.mjs on the vista frustum: 0.85 code values, against
  a grain floor of 2.0 that the pipeline adds on purpose. The layers were half a
  code value UNDER the noise.
  The transfer curve is innocent, and that is checkable rather than arguable:
  tools/grade-model.mjs says a 9% radiance swing buys 5 code values anywhere in
  the sky's range (105, 140, 175 and 208 all cost 8.4-10.7%).
  THE GAP. `exp( -up * 7.5 )` e-folds at 7.6 degrees and is at 0.10 by 17, and a
  hero framing's sky STARTS around 10 degrees because terrain covers everything
  below. The cloud deck above is held out below 24 degrees for the curtain
  reason recorded earlier. Between them sat the entire visible sky with nothing
  in it. Both decisions are right; neither owned 10-24 degrees.
  FIXED by giving the SAME 26x stratum field a second, much slower altitude
  profile (`highDeck` in sky.js), faded in above the dense deck so the first 3.5
  degrees stay exactly as tuned and out before the clouds arrive. Threshold pair
  0.40/0.74 -> 0.44/0.72: tighter and still above the fbm's 0.5 mean, so the
  layers get SPARSER and each one stronger — clear air between strata, and the
  contrast is bought without lifting the whole sky.
  RESULT, predicted offline then confirmed in the renderer: stratification s.d.
  2.17 -> 3.11 in the captured frame (sim predicted 0.85 -> 2.49, which in
  quadrature with the 2.0 grain floor is 3.19), with the region's mean up 3.0
  code values (138.1 -> 141.1). shots/fan/fan_base.png is the before,
  shots/iter37/vista.png the after.
  MEASURED DEAD END, recorded so it is not tried: using the sun veil's 16x field
  as a SECOND, coarser deck. At 17-21 degrees of elevation one band of that
  field is 120-200 px tall in a 1080-line frame, so one or two of them fill the
  whole visible sky and arrive as a smooth GRADIENT — traced down a single
  column it moved the display value 10 codes monotonically over 120 px. Two
  thicknesses of stratum is a good idea at the horizon and a brightness control
  higher up. The scale that reads as a LAYER at those elevations is the 26x
  field, at 40-60 px, so the fix had to be reach and not a second field.
  SECOND MEASURED DEAD END: extending the sun-side extinction `veil` to the
  whole sky by giving `sunSide` a floor. Swept 0 -> 0.45 in the sim and it moved
  the frame by under one code value — because the vista's frame CENTRE is only
  39 degrees off the sun, so `pow(mu,1.4)` is already 0.71 there and the floor
  has almost nothing left to add. The knob survives in skysim as `veilFloor`.
- 2026-09-04 [render] **GLOBAL CONTRAST RE-MEASURED, AND THE OLD COMPLAINT IS
  STALE FOR THE VISTA.** The standing figure — "the far butte 139, the sky 143,
  the near ridge 101, the whole background inside 40 code values" — no longer
  describes the frame. On shots/fan/fan_base.png (`tools/retransfer.mjs`, luma
  percentiles p1/p50/p99 unless noted):
      whole frame     29 / 109 / 231
      sky, sun side  194 / 208 / 223
      sky, anti-sun   98 / 105 / 118
      mountain, left  92 / 102 / 113
      far plain       96 / 112 / 133
      sunlit sand     17 / 134 / 190   (p95 174)
      shadowed sand   33 /  42 / 124
  That is a 202-code span with the sand's lit/shadow pair at 134 vs 42. The
  frame is not low contrast. What IS still true is narrower and already
  assigned: sky, mountain and plain sit inside 26 code values of each other,
  which is aerial perspective doing its job, and the amendment above already
  established that the remedy there is SILHOUETTE AND OVERLAP, not value.
  Note the gameplay frame is not the place to judge this — iter36's is
  dominated by an explosion, and 2.1% of it is above 224 for that reason alone.
- 2026-09-04 [render] **THE RED EDGE, MEASURED PROPERLY AND HALF FIXED.** The
  earlier amendment named the damage rim rather than the vignette and fixed the
  quick-boost bleed, the ceiling (1.2 -> 0.85) and the decay (2.6 -> 5.5/s).
  It was not enough, and the reason is structural. Mean R-G by screen radius on
  shots/iter36/gameplay.png, 8 bands centre to corner:
      11.9  11.1  8.9  6.3  5.1  7.8  16.5  26.9
  That frame is at 60% AP, so `crit` is EXACTLY ZERO and all 26.9 of it is the
  hit term. The control matters as much: the same measurement on an undamaged
  vista falls 15.9 -> 7.3 from mid-frame to corner, i.e. no red edge at all, so
  the vignette really is neutral and this really is `uDamage`.
  AN ACCUMULATOR WITH A CEILING CONVERGES. At hit rate r, bump b and decay k it
  settles at b*r/k and then holds a CONSTANT — the decay only sets how fast it
  gets there. `hit` is now `max(hit, 0.85)`, a re-strike: identical peak for a
  single hit, but a second hit restarts the same flash instead of summing. At
  four hits a second it is a sawtooth that reaches zero 38% of the time and
  averages 0.26 where the accumulator sat rock-steady at 0.44.
  WHAT IS LEFT, for whoever picks this up. The rim is still a radially
  SYMMETRIC screen blend, and both halves of that are why it reads as a filter.
  Symmetric, because a warning that appears equally on all four sides carries no
  information — biasing it toward the incoming hit's screen direction would make
  it diegetic, and `EV.PLAYER_HIT` already carries the source. And a screen
  blend lifts DARK pixels hardest (`disp + c*dv*(1-disp)`), which is why the
  measured tint is worst exactly where the frame is darkest: at the corner the
  luma is 83 and the tint is 27. Weighting `dv` by the pixel's own luma would
  stop it washing the shadows, but it would also damp the low-AP warning in a
  dark scene, so that trade needs a frame in front of it before it is made.
- 2026-09-04 [render/world] **THE AERIAL IN-SCATTER HUE *IS* WHY THE DISTANT
  BUTTES READ AS CUT-OUTS, AND THE EARLIER "MEASURED DEAD END" WAS MEASURED IN
  THE WRONG FRAME.** This amends the 2026-09-03 entry above; do not act on that
  one without reading this.
  That entry sampled the GAMEPLAY frame and reported the buttes "within 4 luma
  and 3 chroma of the sky beside them". `tools/poses/cliff.js` exists precisely
  because the vista and gameplay cameras hide distant-landform defects — it is
  the ground-level pose the buttes are actually judged from. MEASURED on
  shots/L52/cliff.png, each patch against the sky IMMEDIATELY BESIDE IT at the
  same elevation:
      butte L body        rgb(136,131,132)  R-B  4.0  luma 132.4  sd 3.02
      sky beside butte L  rgb(156,143,130)  R-B 25.9  luma 144.9
      butte R body        rgb(128,125,128)  R-B  0.2  luma 126.6  sd 3.89
      sky beside butte R  rgb(153,144,134)  R-B 18.8  luma 145.5
      far plain / ring    rgb(104, 99, 99)  R-B  4.9  luma 100.5
  So the gap is 12-19 luma and 19-26 CHROMA, not 4 and 3 — five and eight times
  what the earlier sample said. And the far plain is neutral too, so this is the
  whole distant layer, not the buttes. A neutral patch inside a warm field reads
  as pale paper whatever its luma is; that is the entire "flat pale cut-out".
  WHERE IT COMES FROM, and it is one line: `Sky.js` builds `aerialColor` as
  `zenith.lerp(horizon, 0.60)` and then multiplies **b by 1.30** with r by 0.94.
  At 92-95% veil the in-scatter IS the landform's colour, so that deliberate
  blue push is painting every distant surface neutral-cool inside a sky whose
  own R-B is 19-26. The comment defending it ("warm near, cool far is what the
  eye reads as distance") is right about the PRINCIPLE and wrong about the
  MAGNITUDE at this sun: the sky against which the cue is read is itself the
  warm end, so the veil only has to be cooler than the ROCK, not cooler than
  the sky.
  **AND HERE IS WHY THE PREVIOUS EXPERIMENT MOVED ONE CODE VALUE.**
  `Pipeline.js:321` sets `this._aerialColor = new THREE.Color(0.16, 0.17, 0.19)`
  and `Pipeline.js:630` copies Sky's emitted `aerialColor` over it on every
  `sky:params` event. THE CONSTRUCTOR VALUE IS DEAD. Anything that changes the
  aerial hue anywhere downstream of Sky's `b * 1.30` gets the blue back on the
  next emit. Same family as the `debug.setPass` no-op and the groundterms probe
  that pointed at a roof: an A/B whose control cannot move reads exactly like
  "this term does not matter".
  OWNER: `src/render/Sky.js` — this agent owns `src/world/` and did not touch
  it. The prescription is measurable rather than aesthetic: sample the butte and
  the sky beside it in `shots/<n>/cliff.png` and bring the veil's R-B to within
  a few code values of the SKY's at that elevation, currently 19-26. Nothing in
  `src/world/` can do it — at a 93% veil the mesh's own vertex colour would need
  an R-B of about 157 code values, i.e. bright orange rock, to move the
  composite by 11.
- 2026-09-04 [render] AERIAL HUE FIXED AT SOURCE, AND THE REMAINING CUT-OUT
  READ IS LUMA, NOT HUE. Acts on the amendment above, which correctly caught
  that my 2026-09-03 "dead end" was measured in the wrong frame AND had a
  control that could not move.
  `Sky.js` now builds `aerialColor` as `lerp(zenith, horizon, 0.88)` with a
  mild `b * 1.03` instead of `lerp(..., 0.60)` with `b * 1.30`. The old value
  sat at R-B -0.059 LINEAR — actually blue — inside a sky at +0.055, and at a
  92-95% veil that in-scatter IS every distant surface's colour.
  MEASURED, shots/aer_base -> shots/aer_fix on `tools/poses/cliff.js`, each
  patch against the sky immediately beside it:
      butte L cap    R-B  8.0 -> 23.5      butte L body  R-B  3.6 -> 22.8
      butte R cap    R-B  4.4 -> 20.2      butte R body  R-B -0.2 -> 19.9
      far ridge      R-B  4.2 -> 17.1      sky beside L  R-B 20.7 (unchanged)
  An 18-22 chroma gap closed to 0-3. The far ridge moved too, confirming this
  was the whole distant layer. Depth separation survives: the veil is still
  cooler than the horizon (+0.034 vs +0.055 linear) and far cooler than
  sunlit sand.
  **THE BUTTES STILL READ AS CUT-OUTS, AND THE NUMBERS NOW SAY WHY.** After
  the fix, butte L measures cap 140.7 / upper face 139.7 / lower body 143.0
  luma against sky 137.5. Two things, both geometry and both for the owner of
  `src/world/`:
    1. THE LANDFORM IS BRIGHTER THAN THE SKY BEHIND IT — 140.7 vs 137.5. A
       distant backlit form should sit at or just under its background.
    2. THE INTERIOR RAMP IS FLAT AND SLIGHTLY INVERTED — 3.3 luma across the
       whole shape, with the CREST BRIGHTER than the toe. `_distantButtes`'s
       own comment says "the crest is darker than the toe so every shape has
       an interior ramp"; measured, it does not.
  A shape with no interior gradient, brighter than its background, reads as
  pasted paper whatever its hue. The hue half is done; this half is not, and
  it cannot be fixed from `src/render/`.
  METHOD NOTE: the first sample I took after the fix showed 22.8 against
  20.7 and I nearly called the whole defect closed — but the image still
  showed cut-outs. The contract's own rule settled it: when a measurement and
  an image disagree, believe the image and go fix the metric. The metric was
  measuring hue when the residual was luma.
- 2026-09-05 [tools] `frameHeroShot` VALIDATED THE CAMERA AGAINST THE PHYSICS
  WORLD AND THE PICTURE IS MADE OF THE RENDER WORLD. Every `mech_detail` and
  `hero` frame this project has taken from a deck had a HANDRAIL across it,
  and the framing code looked thorough: minimum-ray clearance over 12
  bearings, underground rejection, an explicit lens-to-mech occlusion test.
  All of it used `Physics.raycast`. Railings, gantries, catwalk frames, pipes
  and cables carry NO COLLIDER, so a physics ray passes straight through them
  and the test reports a clear line to a shot that is half fence.
  Now: the physics pass is a cheap filter that produces ranked candidates, and
  a `THREE.Raycaster` against the live scene is the authority, run only on the
  survivors. Transparent and invisible materials are ignored (sky, VFX
  sprites, the loot beam hide nothing) and the player's own hierarchy is the
  subject, not an obstruction.
  **AND IT HAS TO BE A FAN, NOT A RAY.** The first version cast one ray from
  the lens to the mech's centre, passed, and produced the IDENTICAL
  railing-filled frame — a centre ray threads straight between two horizontal
  handrail bars. Occlusion is about the FRAME. It now samples nine points over
  the mech's projected extent (+/-2.6 m wide, +/-4.0 m tall) and rejects on
  the FRACTION blocked; 2 of 9 is a strut clipping a corner, more is a fence.
  `_lastHeroFraming.blockedRays` reports it. If no bearing is clean it keeps
  the LEAST obstructed rather than the highest-scoring, and never fails the
  pose outright.
  GENERAL FORM, worth remembering: a validity test must run in the same world
  as the thing it validates. This is the same family as the aerial A/B whose
  control was overwritten by `sky:params`, and the `debug.setPass` no-op —
  a check that cannot see the failure reads exactly like a passing check.
- 2026-09-05 [mech] THE MECH IS NOT FLAT OR UNDERLIT — measured, so it does
  not get "fixed". On the first honest `mech_detail` frame
  (shots/mech02/mech_detail.png) the hull spans lit side luma 62.1, torso
  centre 37.1, arm 31.7 — about 30 luma of key-to-fill separation — against a
  background wall at 49.4 and deck at 53.2. The frame reads dark because the
  LOCATION is a shadowed deck at a 13.5 deg sun, not because the mech lacks
  modelling. My own first impression was "very dark and low contrast" and the
  numbers refuted it.
  What is genuinely open on the hull is STRUCTURE, not tone: the greeble is
  distributed at one scale, so it reads as noise rather than as armour plate,
  panel line and fitting in a hierarchy. That is a modelling question for
  `src/mech/`, not a lighting one.
- 2026-09-05 [combat/vfx] **EVERY PARTICLE IN THIS SYSTEM FADES TWICE, AND IT
  HALVES THE USEFUL LIFE OF EVERY FLASH.** `particleVert` computes
  `alpha = mix(aCol0.a, aCol1.a, t) * fadeIn * tail` where
  `tail = pow(1 - t, alphaCurve)`. So anything authored `alpha0 = 1,
  alpha1 = 0` — which is nearly every hot layer in `VFX.js` — runs at
  **(1-t)^(1+alphaCurve)**, not at (1-t).
  Worked through for the explosion flash core (life 0.06, alphaCurve 1.6, so
  (1-t)^2.6): 44% alpha at a THIRD of its life, 16% at half, 1% at 83%. The
  `explosion` filmstrip's youngest sample is age 0.05 s and its comment claims
  it "catches the flash at peak"; arithmetically it catches a flash that is
  99% gone. Same for the muzzle core (life 0.042, curve 1.4 -> (1-t)^2.4):
  `muzzle.js` fires and steps 30 ms, which is 71% of the life, i.e. 5% alpha.
  Both diagnostics were shooting the corpse.
  THE FIX IS THE SHAPE, NOT THE LENGTH. Lengthening `life` makes a flash
  linger dimly; what an AC6 flash does is hold flat for two or three frames
  and then stop. Hold `alpha1` well above zero (0.4-0.5) and drop
  `alphaCurve` to ~1.0, and the product becomes flat-topped. Applied to the
  explosion's core and flare here.
  Whenever you reason about how long an effect reads, use (1-t)^(1+curve).
- 2026-09-05 [combat/vfx] **THE EXPLOSION IS NOT A LIGHT SOURCE — MEASURED.**
  On shots/boom05/explosion.png, per-detonation peak luma across the six ages
  is 156 / 150 / 146 / 144 / 143 / 137, and the SKY BEHIND THEM peaks at 149.
  The brightest pixel in a fresh 18 m detonation is five per cent brighter
  than the background it is drawn over, and **zero pixels anywhere in the
  frame exceed L=200**. That is the real defect behind "the explosion has no
  structure": not composition, not clipping (the earlier correction that the
  core is NOT clipped is right and still stands), but that the fire never gets
  bright enough to separate from the sky or to cross the bloom threshold.
  Cross-checked against the arithmetic: a mid-heat fireball puff emitted at
  1.8 linear composites to ~1.1 after alpha, which AgX puts just above the sky
  and just under bloom. The measurement and the maths agree.
  The lever is the ALPHA puffs' radiance, and it is safe to raise precisely
  because they are alpha and not additive — alpha compositing does not
  accumulate into the featureless slab that got the additive fireball removed.
  Section 2's puff radiance went 2.6*heat+0.5 -> 6.2*heat+0.7 and the additive
  core sprites 7 -> 12.
  NOTE THE ORDER OF WORK: the rolling smoke (section 3) was left alone. The
  earlier amendment showing that delaying it destroys the explosion is about
  the SMOKE; the fireball's own radiance is a separate lever and is the one to
  reach for first.
- 2026-09-05 [combat] TWO WIRING BUGS ON THE IMPACT PATH, both the same shape
  as the deleted `_fxTrail`. (1) `ProjectileManager._fxImpact` emits
  `EV.IMPACT` **and** calls `vfx.impact` directly. Only the bus handler
  consulted `VFX`'s de-duplication ring, so both paths ran and **every round
  that hit anything spawned the entire impact twice** — two spark bursts, two
  scorch decals, two flash lights, double additive energy at one point. The
  guard now lives in `VFX.impact` itself, where the ring's own comment says it
  belongs, so it holds whichever path arrives first. (2) The same call site
  passed the scale as a bare number into `impact(pos, normal, type, opts)`,
  whose fourth argument is an OPTIONS OBJECT, so `(opts && opts.scale) || 1`
  read `undefined` and every impact ran at scale 1 — the authored 1.4 splash,
  1.8 charged and 2.2 beam multipliers were computed and thrown away.
  (3) Related: `_fxExplosion` emits `EV.IMPACT` with `type: 'explosion'`, and
  `VFX._impactKind` has no case for it, so it fell through to its 'concrete'
  default and **every detonation also spawned a full concrete impact** at
  scale clamp(radius,..,4) — ~55 grey dust puffs, ~35 chunks and a 3-6 m CRACK
  DECAL over the fireball, hanging in mid-air for an airburst. That is exactly
  the floating-decal bug `_fxExplosion` raycasts the ground to avoid, arriving
  through the other door. The EV.IMPACT handler now ignores blast payloads.
  Note the grey dust was also DESATURATING every in-game explosion; the
  `explosion` filmstrip never showed it because `debug.vfx` calls
  `VFX.explosion` directly and bypasses `_fxExplosion` entirely. A diagnostic
  that skips the caller cannot see a bug in the caller.
- 2026-09-05 [tools] BOTH VFX FILMSTRIP POSES WERE PHOTOGRAPHING THE DEFOCUS.
  `explosion.js` reported its own `passes` as `dof: true` and put the row 98 m
  from the lens; `muzzlestrip.js` run 1 put a 2 m muzzle flash 44 m away with
  the mech occluding the middle of the row, and came back as faint smudges
  plus two hot pixels that were the mech's own lamps. Both now call
  `debug.setPass('dof', false)` and frame at combat range. A diagnostic exists
  to show what an effect CONTAINS; lens blur belongs in the review poses.
- 2026-09-05 [world] `BUTTE_ALBEDO` IS VERIFIED NEAR-INERT, AND THAT CLOSES
  OFF "TUNE THE BUTTE'S SHADING" FOR GOOD. Its comment promised "Calibrated
  by capture; see the amendment" and no such amendment ever existed, so here
  it is. The constant is real and reachable — `Level.js:1427`,
  `sh = (0.60 + (sh - 0.60) * con) * BUTTE_ALBEDO` — but driving it from 0.0
  (shading fully OFF) to 1.0 (fully ON) moves the cliff pose by a MEAN of
  0.334 display code values, a MAX of 1.2, with 2.08% of pixels differing by
  more than one code and NONE by more than three. Butte and sky patches
  measure identical to the digit either way.
  Committed at 1.0, the non-degenerate value: 0.0 zeroes the term outright
  and is indistinguishable, so the natural form is the one to keep.
  WHY, and it generalises: at a 92-95% veil the in-scatter IS the surface's
  colour and the mesh's own shading is swamped. A previous amendment put the
  same point as a bound — the vertex colour would need an R-B of about 157
  code values to move the composite by 11 — and this measures the luma side
  of it directly.
  SO THE REMAINING BUTTE DEFECTS CANNOT BE FIXED FROM THE MESH'S SHADING.
  They are: the landform sits at 140.7 luma against a sky at 137.5 (brighter
  than its own background), and its interior ramp is 3.3 luma across the whole
  shape with the crest BRIGHTER than the toe, where `_distantButtes` intends
  the opposite. The only levers that can still move those are the VEIL's own
  luma at that depth (`src/render/`) or the buttes' RANGE and silhouette
  (`src/world/`) — not their albedo, and not their shading coefficient.
  METHOD: this was an A/B left half-run by an agent that was cut off. Before
  committing an in-flight experiment, MEASURE BOTH ARMS. Both arms being
  identical is itself the finding.
- 2026-09-05 [mech] **RETRACTED: "THE MECH'S GREEBLE SITS AT ONE SCALE AND
  READS AS NOISE RATHER THAN A HIERARCHY."** I wrote that yesterday off the
  first honest `mech_detail` frame and it does not survive measurement.
  `tools/detail.mjs` decomposes a rect into disjoint Burt-Adelson octaves and
  reports RMS code values per band, which is exactly the right instrument:
  noise concentrates in b1-b2 and falls away, while designed structure carries
  energy at the plate and panel-line scales too. Measured on
  shots/mech02/mech_detail.png (b1 ~2 px .. b64 ~64 px wavelength):
      mech torso     4.24 3.41 3.61 3.87 4.12 4.51 5.10   total 39.0
      mech shoulder  5.01 3.94 4.04 4.31 4.71 5.32 5.92   total 48.3
      level wall     3.38 1.16 0.83 0.68 0.73 1.05 1.62   total 33.3
  The hull's spectrum is FLAT-TO-RISING across six octaves — the opposite of
  noise — and it carries more multi-scale energy than the level's own panelled
  surfaces. Roughly equal energy per octave is also what natural imagery
  looks like. There is no supported criticism of the mech's detail structure
  here, and nobody should spend a session restructuring it on this basis.
  A SECOND READING FROM THE SAME RUN ALSO FAILED. A third rect measured 27.6
  total against the torso's 39.0, which looks like "the legs are
  under-detailed" — but cropping the rect at 2x shows it is about 40%
  BACKGROUND, so the deficit is dilution, not the mech. Same trap as the
  butte-cap sample: a rect chosen from an opinion measures the opinion.
  ALWAYS CROP THE RECT AND LOOK AT IT BEFORE BELIEVING WHAT IT MEASURED.
  METHOD, now five for five this week: an impression about an image is a
  hypothesis about numbers. `tools/detail.mjs` for "is there detail and at
  what scale", `tools/png.mjs` + a ten-line script for brightness, warmth or
  clipping, `tools/crop.mjs` for "what is actually in this region".
- 2026-09-05 [world/render] **THE BUTTE LAYER'S WHOLE PROBLEM IS ONE NUMBER —
  THE VEIL AT ITS RANGE — AND THE VEIL IS A FUNCTION OF DISTANCE ONLY.**
  Solved numerically instead of argued, `tools/probes/veil.js` (which
  reproduces `tools/poses/cliff.js`'s camera exactly and evaluates
  COMPOSITE_FRAG's fog maths on the CPU from the LIVE uniforms) plus
  `tools/grade-model.mjs --invert` to put display codes and scene radiance in
  the same units. Numbers, on the shipped build:

      sample            mesh          dist   veil f   display   scene-linear
      butteR mid        BoundaryFar   1128   0.783    ~138      0.201
      butteL cap        BoundaryFar   1405   0.895    ~140      0.205
      butteL far        BoundaryFar   1588   0.936    ~141      0.207
      mesa ring (plain) Boundary       698   0.436    ~105      0.115
      mesa ring (dune)  Boundary       581   0.300     ~95      0.096
      pure in-scatter    —              —    1.000    ~149      0.2470

  `wAir` is 0.99 on every distant sample, so `inscat` at this range IS
  `aerialColor` and the deck/band media contribute nothing to a butte.
  The composite is exactly `C = f*0.247 + (1-f)*S`, and the two ring samples
  (same rock, two ranges) solve for the rock: **S = 0.03..0.05 scene-linear,
  i.e. the landform's own surface is SIX TIMES DARKER THAN THE FOG IN FRONT
  OF IT.** Substituting the ring's S back at the other range predicts display
  94 against 95 measured, so the model is good to a code value.

  THAT ARITHMETIC EXPLAINS EVERY OBSERVATION AT ONCE:
  - Why the buttes read pale: at f = 0.78-0.94 they are 78-94% fog, and fog
    here is display ~149 against a sky at 139-146 at the same elevation.
  - Why `BUTTE_ALBEDO` measured inert: the whole surface term is 6-11% of the
    pixel, and it is a 0.04 term inside a 0.25 one. Blacking it out is worth
    about one display code. The prior amendment's finding is CORRECT; what it
    could not know is that the coefficient is not small, the WEIGHT is.
  - Why the interior ramp is 3.3 luma: the ramp lives in the same 6-11%.
  - Why the mesa ring reads as rock at the identical albedo: f = 0.30-0.44.
  **`BUTTE_ALBEDO` IS NOT INERT AS A CONSTANT — IT IS INERT AT 1.4 km.** Its
  authority scales as (1-f), so the same edit is worth 6x more at 900 m. Do not
  quote the old measurement at a range it was not taken at.

  THE LEVER, quantified, at the cliff pose (camera 125 m BEHIND the origin
  along its own view bearing, so camera distance = ring radius + 125):

      ring radius   camera dist   veil f   predicted display   vs sky ~142
          760           885        0.61          128              -14
          900          1025        0.72          136               -6
         1400          1525        0.92          147               +5
         1900          2025        0.97          149               +7

  So `_distantButtes`' band of 950-1900 m puts its NEAREST possible member at
  f = 0.75 and everything else above 0.85 — the layer was authored entirely
  inside the range where its own geometry cannot be seen. Nothing about its
  shape, shading or albedo could have fixed that.
  THE FLOOR ON THIS FROM `src/world/` IS THE MESA RING'S BACK SLOPE, which
  runs from the face at r = 430-522 out to r = 906 (`BACK`'s last entry, 430 m
  of radial offset past `R_NOM` 476). A butte centred inside ~760 m either
  buries itself in that slope or pushes its plan into the cliff face the arena
  is bounded by, so f = 0.6 / display -14 is the best this layer can do from
  the world side. Going below that needs the VEIL's luma at 1 km, which is
  `src/render/` (see the REQUEST below).
- 2026-09-05 [render] **THE VEIL WAS 19% BRIGHTER THAN THE SKY IT IS SEEN
  AGAINST, AND IT IS A CONSTANT WHERE THE SKY IS A RAMP.** Acts on the request
  above ("the veil's own luma at that depth"), and answers it with a ratio
  rather than a feeling.
  `tools/probes/veil.js` (new) reproduces the cliff pose's camera, raycasts the
  pixels the butte patches are measured at, and evaluates COMPOSITE_FRAG's fog
  maths ON THE CPU from the LIVE uniforms — tau per medium, the veil fraction,
  the in-scatter colour. `tools/skysim.mjs` grows a `cliff` pose so it can say
  what the SKY is along those same rays. Together they close the loop offline:
      butte crest, 1405 m   veil f 0.895   in-scatter 0.2500 linear
      the sky along that very ray                     0.2094 linear
  The in-scatter was 19% BRIGHTER than the whole atmospheric column in the same
  direction, which no finite path can be. That is the luma half of the pale
  cut-out, and it is why a landform measured 139.9-141.1 against a sky at
  135-139.
  THE AERIAL TERM IS THE ONLY LEVER OUT THERE, measured: at 1.4 km `tDeck` is
  **exactly zero** (from a camera 80 m up the deck's exponential profile is at
  e^-9 of its base) and `tBand` is 0.5%, so `wAir` = 0.995. `aerialColor` moves
  a distant pixel very nearly 1:1 and `deckColor`/`bandColor` do not reach it
  at all — do not try to tune the far distance with them.
  FIXED: `Sky.js` multiplies `aerialColor` by 0.90 (10% of radiance is ~6
  display codes here, per `tools/grade-model.mjs`).
  PREDICTED THEN CONFIRMED, and the prediction method is the reusable part:
  composite = (1-f)*surface + f*inscat, so a change of in-scatter moves the
  linear composite by exactly f*(I' - I) and THE SURFACE CANCELS. Invert the
  measured display through grade-model, add f*(I'-I), grade forward. On the two
  patches no other agent touched between the two captures it landed on the
  digit: far plain predicted 104.7, measured 104.8; near dune predicted 82.7,
  measured 83.0. The sky did not move (0.0 over both control patches), which
  also confirms the sky pass is not fogged.
  CROSS-BUILD WARNING, live this session: the butte patches moved 4-6 codes
  MORE than predicted, and the reason is not the model — `src/world/` landed a
  butte-range change in the same minute, so those patches are not the same
  geometry in the two frames. Two of the four measured patches were still clean
  and they are the ones quoted above. **When three agents are running, pick
  control patches in parts of the frame the other agents are not editing.**
  AND THE NUMBER `src/world/` IS QUOTING HAS CHANGED: the in-scatter constant
  in `_distantButtes`' comment (`C = f * 0.247 + (1-f) * S`) is now **0.2251**.
  The f -> display table there shifts down ~5 codes at f = 0.9, ~3 at f = 0.61.
- 2026-09-05 [render] **WHAT IS LEFT OF THE CUT-OUT IS THAT THE VEIL HAS NO
  DIRECTION AND NO TEXTURE.** Measured on the same rays, and this is the next
  lever for whoever picks it up.
  (1) NO VERTICAL RAMP. Along the cliff bearing the sky runs 0.3807 linear at
  2 deg of elevation to 0.2094 at 9 deg — the horizon glow, a factor of 1.8.
  The veil is 0.2450-0.2506 at EVERY one of those rays, because `uAerialColor`
  is one constant with no dependence on the view direction. So the distant
  layer is under the sky at the horizon and over it higher up, and it is FLAT
  across a landform that spans both. The interior ramp `_distantButtes` wants
  (crest darker than toe) is exactly what a sky-following veil would produce
  for free — and, being 90% of those pixels, it is the only thing that can.
  The shape of the fix is `exp( -max(dir.y, 0) * k )` with the base rescaled so
  the 6-9 deg value is preserved (a horizon gain that is not renormalised is a
  brightness change, not a gradient). NOT SHIPPED HERE, and the reason is
  measurable rather than cautious: at 0.3 deg the far plain is only f = 0.44,
  so a 37% horizon gain would lift it ~9 display codes, and re-milking the
  lower frame is the exact failure this pass was built to avoid. It needs its
  own capture, and ideally the gain applied through `f` so it cannot reach the
  half-veiled midground.
  (2) NO SPATIAL TEXTURE. `dustGain` deliberately modulates the deck and band
  only, so past ~1 km — where those two are 0.5% of the blend — the air has no
  structure at all. Measured on the cliff frame: butte interior s.d. 3.6 code
  values against a sky at 7.2, and 3.6 IS the grain floor. Whatever the mesh
  does, the pixels are 90% a perfectly uniform sheet.
  (3) THE HONEST FIX FOR BOTH IS THE ENVIRONMENT MAP. `Sky.environment` is a
  PMREM of the very sky these rays terminate into; sampling it along `dir` at
  high roughness gives an in-scatter that is correct in elevation AND azimuth
  and carries the sky's own structure, instead of one hand-tuned constant. That
  is a real wiring job (cube UV + decode inside COMPOSITE_FRAG) and wants a
  session of its own.
- 2026-09-05 [world] **THE PALE CUT-OUT IS FIXED, AND IT WAS THE BAND'S RANGE.**
  Acting on the veil solve above. `_distantButtes`' band went 950-1900 m ->
  760-1400 m, its plan radius is now clamped by centre distance so a near member
  cannot push into the cliff face (`rCap = (rad - 560) / 1.31`), and heights went
  150-300 -> 170-360 so a closer butte still clears the ring's crest.
  MEASURED on `tools/poses/cliff.js`, shots/aer_fix -> shots/btg2, column 1235,
  a vertical strip down one butte with the sky in the same column just above it:

      row     440(sky)  480    520    560    600    640
      before    127.8  138.3  141.1  146.5  137.2  137.1
      after     125.3  117.9  117.0  119.5  123.7  123.8

  So the landform against the sky IMMEDIATELY ABOVE IT went from **+10.5..+18.7
  to -7.4..-1.5**, and the interior ramp from non-monotonic +-4 to a monotonic
  **5.9 luma with the crest darker than the toe**, which is what the function's
  own comment always claimed and never did. Across the frame the whole layer now
  sits in a correct ladder — mesa ring 86-106, buttes 118-134, sky 136-158 —
  where before the buttes were 139-141 inside a sky of 128-156 and read as
  pasted paper because they were in the sky's own value family.
  Costs, all checked: no new draw call (same merged `BoundaryFar` mesh), no
  console errors, and `vista` does not regress — the group reads as background
  landform behind the ridge, not as a wall (shots/btvista/vista.png).
- 2026-09-05 [world] **THE BUTTE GULLIES BOUGHT SILHOUETTE, NOT INTERIOR, AND
  THAT IS THE WHOLE POINT OF MEASURING BOTH ARMS.** A rectified drainage field
  was added to the butte plan (relief 0.14 of radius, plus a 0.17 occlusion term
  on the vertex colour, both enveloped off the toe and out from under the
  caprock). Isolated A/B, shots/btrange -> shots/btg2:

      interior sd, butte L   3.43 -> 3.60      butte R   7.99 -> 7.90
      pixels differing > 3 code values over the sky/butte band: 35.75%, max 69

  i.e. it moved a THIRD of the layer's pixels and changed its interior standard
  deviation by nothing. Both facts are true and they are not in tension: the
  channels cut the OUTLINE, and at a 0.6-0.9 veil an occlusion term of 0.17 on a
  surface worth 0.04 scene-linear is a couple of code values. Keep it for the
  silhouette; do not reach for it again expecting interior contrast, and do not
  raise its occlusion coefficient hoping to get some — that is the same
  arithmetic `BUTTE_ALBEDO` already lost to.
  METHOD, and it cost a capture: the first version drew `H_GULLY` from the
  shared `rng`, which consumed four numbers per butte and walked the stream, so
  every radius, height, squash and tilt in the group came out different and the
  A/B could not be attributed to anything. It now has its own generator, the
  discipline `_mesaRing`'s `FACE` already keeps. **A parameter you intend to A/B
  must not move the seed of everything beside it.**
- 2026-09-05 [render] REQUEST, and it is the last thing standing between this
  layer and a clean pass. `Sky.js` builds `aerialColor` as
  `lerp(zenith, horizon, 0.88)`, which the veil solve above measures at 0.247
  scene-linear — display ~149. The SKY it is composited against renders 136-146
  at the elevations a distant landform actually occupies (5-12 deg), so the fog
  is BRIGHTER THAN THE SKY BEHIND IT and every surface at a high veil is pushed
  up through its own background. `src/world/` can only dodge that by staying out
  of the high-veil range, which is what the band move above does and why the
  band cannot now be widened back out past ~1.4 km. The fix on your side is to
  make the in-scatter track the sky's radiance in the VIEW DIRECTION rather than
  a single horizon-weighted constant — at minimum, weight `aerialColor` toward
  the zenith end far enough that it lands at or just under the sky at 5-12 deg
  instead of 3-13 codes over it.
- 2026-09-05 [tools] **THE SHUTTER IS TENS OF SECONDS AFTER THE POSE RETURNS,
  NOT 1.1 s — AND EVERY POSE THAT TORE DOWN ITS OWN STATE ON A `setTimeout` WAS
  PHOTOGRAPHING A SIMULATION IT HAD ALREADY RELEASED.** This supersedes the
  2026-09-01 "~1.1 s settle" amendment, whose closing rule ("hold it with a
  `setTimeout(..., 3000)` release like boost.js does") was exactly backwards.

  `capture.mjs` waits `SETTLE` (1100 ms) and THEN calls `page.screenshot`. The
  screenshot is not instantaneous on this box. Measured `shotMs`, every report
  on disk: 24.1, 30.3, 31.9, 46.1, 54.6, 57.3, 60.4, 60.7, 67.1, 73.3, 88.0,
  88.4, 102.3, 113.6, 129.7 seconds. The page keeps ticking throughout — badly,
  about 0.15 fps, but it ticks. So a cleanup timer set for 3000 or 6000 ms
  fires **before** the frame is captured, every time, on every pose.

  Confirmed in `shots/muz01` on three independent readings that agree:
    1. `timeScaleTraps` (a property trap on `engine.timeScale`) recorded exactly
       one 0 -> 1 transition, at frame 5, with the stack pointing at
       `debug.freeze(false)` on the pose's own 6 s timer.
    2. `atRenderTime`, sampled from `addLateUpdate` and therefore read after the
       screenshot: `timeScale: 1`, and `ps.time` had advanced 0.518 s past the
       value at pose end.
    3. The pixels. The two control sprites authored `life: 30` read display luma
       241 and 252; the four short-lived spots read 88, 96, 97, 71 against a
       background of 55-63 — i.e. nothing. Their `alive` counts at render time
       were 0, 0, 0, 0.

  WHAT THIS INVALIDATES. Anything concluded from a frozen pose whose subject
  lived less than about half a second, because 0.5 s of sim ran between the
  freeze and the shutter:
    * **The muzzle flash is not broken.** `muzzlestrip` reported a peak of 105
      where a raw sprite reached 181, and that was read as a defect between
      `VFX.muzzleFlash` and the batch. There is no such defect: at pose time the
      batch holds the real flash at `maxEff` 13.2 against the raw control's 17,
      emitting at full authored radiance. The pose photographed an empty volume.
      Whether the flash READS at gameplay frame rates is still open — it is now
      testable for the first time.
    * **"`debug.setCamera` + `debug.freeze(true)` does not reach the render"** —
      the open question recorded in `explosion.js` and in this file. RESOLVED,
      and there was never a second camera: the pose's 6 s timer called
      `releaseCamera()` before the shutter, so the chase camera composed the
      frame, and the sample that "proved the override was still set" was taken
      at 1000 ms, five seconds before the release.
    * `landing.js` timed a sub-second dust sheet to land "just before the
      shutter" and then let the sim run for the length of the capture.
    * `particles.js` replenished for 1.1 s; `bloomsrc.js` held its volley for
      3.2 s; `combat_vfx.js` for 6 s.

  THE RULE, and it is now enforced by the harness rather than by memory:
    * A pose puts its teardown in `window.__POSE_CLEANUP__`. `capture.mjs` calls
      it after the screenshot and after `__POSE_NOTE__` is read. **No pose may
      contain a `setTimeout` that restores state.** A keep-alive `setInterval`
      is fine and should run until cleanup, never to a timer or a count.
    * A pose that wants to report what the SHUTTER saw rewrites
      `__POSE_NOTE__` from `engine.addLateUpdate`. A note sampled on a timer
      describes a frame tens of seconds older than the picture beside it.
    * Prefer holding the moment over timing it. `landing.js` now freezes 0.18 s
      after the real `EV.LANDED` instead of racing the shutter.
- 2026-09-05 [tools] **`Debug.step` ADVANCED `clock.elapsed` AFTER THE UPDATERS,
  SO EMISSIONS BETWEEN TWO `step()` CALLS WERE AGED BY THE PREVIOUS CALL'S
  `stepDt`.** `Engine._frame` increments `clock.elapsed` and then dispatches
  (Engine.js:148 before :151); `Debug.step` dispatched and then incremented.
  Subsystems that key off the `elapsed` ARGUMENT rather than their `dt` — the
  particle system does, `ps.time = elapsed`, and stamps every particle's birth
  from it — therefore ended each `step()` trailing `clock.elapsed` by exactly
  one `stepDt`. The lag discharged as a jump on the first substep of the next
  call.

  Measured in `muzzleanat`: after `step(0.3, 1/60)`, a `step(0.004, 1/960)`
  aged the particles 19.8 ms — 16.7 (the stale 1/60) plus 3.1 — when the pose
  had asked for 4. A 42 ms muzzle-flash core was photographed at t=0.47,
  alpha 0.29, by a pose that believed it was at t=0.10. Fixed to match the
  engine. If you have a pose whose timing was tuned against the old behaviour,
  it is now getting what it asked for and may need its numbers re-read.
- 2026-09-05 [tools] **THE SHUTTER IS TENS OF SECONDS OF REAL TIME LATER BUT
  ONLY ~0.2-0.5 s OF SIMULATION TIME LATER.** This refines the amendment above,
  which got the real-time half right and left the other half implicit — and the
  other half is where the remaining pose bugs live.

  Measured, same run (shots/rehab1): `landing` places the mech 6.75 m up and
  returns; at the shutter it is 6.26 m up, a fall of 0.49 m, which under this
  game's 24 m/s^2 is 0.20 s of simulated time. `muzzleanat` before the freeze
  fix advanced the particle clock 0.518 s. The engine clamps dt to 0.1 s and
  only a handful of frames run during a 24-130 s screenshot, so:

    * REAL-time timers fire HUNDREDS of times into a nearly static simulation.
      A `setInterval(blast, 300)` running to cleanup is ~100 detonations
      deposited into half a second of sim time, and they cannot expire because
      the clock is barely moving. Measured: `particles` reported 17,658 live
      particles at the shutter, and `combat_vfx` — same pattern, plus weapons
      every 140 ms — became so expensive that `page.screenshot` blew its 180 s
      timeout and the pose FAILED outright. A real-time keep-alive is not a
      keep-alive; it is an unbounded deposit.
    * SIM-time reasoning is what a pose should use, and it flips the premise
      several poses were built on. "The shutter opens 1.1 s later so an effect
      fired in-script is gone" is FALSE: an explosion with a 1.2 s life fired at
      pose end is still alive at the shutter, because only ~0.3 s of sim has
      passed. Only sub-0.5 s effects — muzzle flashes, impact flashes, the
      explosion's own white-hot flash — need a freeze at all.

  THE RULES, superseding the "hold it with a timer" advice everywhere:
    1. Build and stage everything with `debug.step`, which advances sim time
       deterministically and does not care about frame rate.
    2. Freeze only for effects shorter than ~0.5 s. Longer ones survive to the
       shutter on their own.
    3. Never use `setInterval` to keep an effect alive. Stage repeats with
       `debug.step`, or drive them from `engine.addLateUpdate` off accumulated
       `dt` so the rate is in sim time and the population stays bounded.
    4. Never use `setTimeout` to restore state — that is `__POSE_CLEANUP__`.
- 2026-09-05 [combat] **THE MUZZLE FLASH IS CORRECT AND THE "IT IS INVISIBLE"
  FINDING IS RETRACTED.** `muzzlestrip`'s old headline — "peak luma 60-86 across
  all five ages, ZERO pixels over L=200" — was measured on a frame whose flashes
  had been dead for tens of seconds. Re-shot on the fixed harness, same pose,
  same geometry, same `flashScale` 0.7, same ~20 m from the lens, against a
  control patch 110 px above each box at 48-63:

      age    peak L   px > 200   px > 240
        4 ms    248       1154        595
       14 ms    254       1125        718
       30 ms    253        813        199
       50 ms    247        335         43
       80 ms    225          1          0

  3,428 pixels over L=200 across the row, against "zero". The flash clips, and
  it decays monotonically to nothing by 80 ms — which at 60 fps is five frames
  with the energy in the first three. That is a correct, snappy muzzle flash and
  it needs no change. The batch dump agrees: at 4 ms the authored core sprite
  (tile 1, radiance 17) is the top contributor at alpha 0.81.

  Do not re-open this without a capture taken after 65ec71e.
- 2026-09-05 [render] **THE AERIAL VEIL NOW FOLLOWS THE SKY'S NEAR-HORIZON RAMP,
  AND THE "LANDFORM BRIGHTER THAN ITS SKY" DEFECT IS CLOSED AT THE CREST.**
  Verified with `tools/probes/veil.js`, which evaluates COMPOSITE_FRAG's fog
  maths on the CPU from the LIVE uniforms — not from a restatement of them.

  The complaint, from the note above `aerialColor.multiplyScalar(0.90)`: the
  in-scatter was one constant, measured at 0.2450-0.2506 linear on every ray
  from 2 to 9 degrees of elevation, while the sky along the same bearing ran
  0.38 down to 0.21. At the butte crest the veil terminated into 0.2500 where
  the sky was 0.2094 — 19% BRIGHTER than the sky it was drawn in front of.

  COMPOSITE_FRAG now evaluates SKY_FRAG's own base gradient along the view ray
  and applies it as a per-channel ratio against a 7.5 degree reference, so at
  that elevation the gain is exactly 1 and every calibration already measured
  into `aerialColor` (the hue trim, the 0.90) is untouched. Measured gains, one
  probe run, in elevation order:

      -7.9 deg  1.478      4.9 deg  1.128
       0.3      1.449      6.1      1.066
       2.1      1.313      6.5      1.044
       3.0      1.250      8.8      0.947
       3.3      1.225      9.1      0.935
                          11.7      0.845

  Crossing 1.0 at 7.5 as designed. The in-scatter's own luminance now runs
  0.2946 at 2.1 deg to 0.2125 at 9.1 — a span of 1.386 against the 1.40
  predicted from the palette before the change, and against the FLAT
  0.2450-0.2506 it replaced.

  The defect itself: butte crest veil 0.2500 -> 0.2125 against a sky at 0.2094.
  From 19% over to 1.5% over. At the toe (3.0 deg) the veil is 0.280 against a
  sky near 0.355 — still under, which is correct: an in-scatter integrated over
  a finite path should not reach the whole atmospheric column.

  STILL OPEN, and it is the ~43% of the ramp this does not recover: SKY_FRAG
  weights its Mie lobe by (0.22 + 1.15*hz), piling brightness into the first few
  degrees, and that term is deliberately excluded here because the composite
  applies its own forward-scattering lobe. Giving that lobe the same elevation
  weighting is the next step. Do NOT close the remaining gap by fitting an
  exponent to the gain — that is curve-fitting to two measured points, not a
  source function. `params.atmosphere.aerialViewDep` is a live control (0
  restores the constant exactly) so the A/B has an arm that can actually move.
- 2026-09-05 [tools] **A POSE THAT INSTALLS AN `addLateUpdate` SAMPLER AND DROPS
  THE UNSUBSCRIBE REWRITES THE NEXT POSE'S NOTE.** `Engine.addUpdate` and
  `addLateUpdate` both RETURN an unsubscribe function; three poses were calling
  them and throwing it away. The sampler then runs for the rest of the browser
  session and overwrites `window.__POSE_NOTE__` every frame.

  Measured in shots/rehab2: the `cliff` shot's report carried
  `{landings: 1, impactSpeed: 17.4, grounded: true, frozenAtImpact: true}` — the
  landing pose's numbers, beside a photograph of a cliff. This is the worst
  failure mode this harness has, because the report looks COMPLETE and describes
  a different picture; it is the same class as the "gameplay frame with no
  enemies in it" that `__POSE_NOTE__` was introduced to catch.

  Fixed in `landing`, `explosion` and `muzzleanat`, and capture.mjs now counts
  `engine._updaters` / `_lateUpdaters` before each pose and after its cleanup
  and reports any growth as `leakedHooks` in report.json plus a console error.
  Nothing but a count catches this generically — the leak is invisible in the
  picture and plausible in the note.
- 2026-09-05 [render] The aerial ramp is confirmed IN PIXELS as well as in the
  probe. shots/veil1/cliff.png (before) against shots/rehab2/cliff.png (after),
  at `tools/probes/veil.js`'s own sample coordinates, sorted by the elevation
  the probe reports for each ray:

      butteL cap   9.1 deg  gain 0.935   -3.7 codes
      butteL far   8.8      gain 0.947   -3.0
      butteR cap   6.5      gain 1.044   +2.2
      butteL mid   6.1      gain 1.066   +3.5
      butteR mid   4.9      gain 1.128   +7.1
      butteR toe   3.3      gain 1.225  +12.1
      dune right   3.1      gain 1.241   +9.4
      butteL toe   3.0      gain 1.250  +12.6
      butteL low   2.1      gain 1.313  +13.9
      plain mid    0.3      gain 1.449  +19.3
      ground near -7.9      gain 1.478   +4.8   (wAir only 0.26, so damped)

  Monotonic in the gain, negative above the 7.5 deg anchor and positive below,
  and `ground near` is damped exactly as its low aerial SHARE predicts rather
  than by its gain. The two rays the probe classifies as true SKY moved -2.4 and
  +2.0 codes — the sky pass is not fogged, so that is the run-to-run noise floor
  (TAA and dust drift between two separate captures), the same ~1-2 codes the
  rim A/B measured.
- 2026-09-05 [tools] `tools/poses/landing.js` HAS NOW PHOTOGRAPHED A LANDING.
  It never had before: every previous run reported `landings: 0`. With the fall
  stepped in sim time the note reads `landings: 1, impactSpeed: 17.4 m/s,
  grounded: true, heightAboveGround: 0.02, frozenAtImpact: true, timeScale: 0`
  with 551 live particles, and the frame's bottom two row-bands measure mean
  luma 87.8 and 100.2 at a standard deviation of 18.1 and 14.9 — a bright,
  smooth sheet against the structured terrain's sd of ~33 above it. That is the
  dust wash. Grade the landing from this pose now; it is the first capture of it
  that contains one.
- 2026-09-05 [tools] **EVERY HERO AND MECH_DETAIL FRAME THIS PROJECT HAS EVER
  GRADED SHOWED THE MECH'S BACK.** `Debug.frameHeroShot` had the sign of its
  facing yaw inverted (fixed in 407c70b), and both poses get their camera AND
  the mech's yaw from it. The convention is `forward(Y) = (-sin Y, 0, -cos Y)`,
  so facing a target needs the mech-minus-camera difference; it was written
  camera-minus-mech, which is exactly 180 degrees.

  Measured with `tools/probes/chestdisc.js`, which reports the camera in
  MECH-LOCAL coordinates. Before: [0, 5.89, 16.99]. The x of EXACTLY 0 is what
  identified it — the lens was not merely behind the mech, it was dead on its
  back axis, which is a sign flip and not drift. After the fix and a 0.45 rad
  three-quarter turn: [7.39, 5.89, -15.30], i.e. 25.8 degrees off the front axis.

  WHAT TO RE-EXAMINE. Every recorded judgement about how the MECH LOOKS was made
  against its backpack. That does not automatically make them wrong — an octave
  spectrum or an AO mean is a real measurement of whatever was in the rect — but
  the SUBJECT was not the one the entry names. In particular:
    * "lighten the mech's paint" / the MECH_PALETTES darkness argument, which
      this file records as having cost two passes of oscillation.
    * "add negative space to the mech", the "only one true sky-gap" entry, and
      THE LEG'S FLAT PROFILE — a rear three-quarter reads a leg's width/depth
      budget differently from a front one.
    * The single-radius AO result ("the mech torso lost 8.6% of its mean and
      6.5% of its standard deviation") — the torso rect was the spine housing.
    * My own retracted "mech greeble reads as noise", and its retraction.
  Re-shoot before re-arguing any of them. The front carries the visor, the chest
  vents, the shoulder cannon and the arm optic; the back carries the boosters and
  the radiator stack, and they are not interchangeable subjects.

  It also explains a thing that has confused three passes: the two large pale
  discs that read as a PAIR OF EYES in shots/rev01/hero.png. They are not chest
  optics and they are not a defect — they are the main booster nozzles, correct
  hardware, seen from the one angle a key render never uses.
- 2026-09-05 [render] The 2026-09-03 "the brightest large surface sits at middle
  grey" finding REPRODUCES on the corrected front-view hero frame, independently
  measured. shots/rev02/hero.png luma percentiles p1/p5/p50/p95/p99:
      whole frame   12 / 20 /  68 / 115 / 172     2.74% under 16, 0.05% over 235
      mech only     10 / 16 /  55 / 158 / 212     4.74% under 16, 0.21% over 235
      sky band      49 / 57 /  70 /  94 / 129
  The BLACK POINT IS FINE — 2.7% of the frame is genuinely in the toe. The top
  of the scale is what is unused: 1% of the frame exceeds code 172, and the
  brightest large surface in a sunlit desert exterior is the sky at a median of
  70. This is the same scene/exposure placement problem already recorded, now
  confirmed on the frame that is supposed to be the key render, and it is the
  single largest remaining gap between these captures and an AC6 key art
  reference. It is NOT a curve problem: `tools/grade-model.mjs` says the shipped
  grade does not clip until scene-linear 3.2.
  Note for whoever takes it: the hero frame's own numbers were unusable until
  today, because the subject was facing away. The mech's p50 went 43 -> 55 and
  its p95 102 -> 158 purely from turning it around into the key.
