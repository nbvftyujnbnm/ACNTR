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
| write or fix a review pose | **THE HARNESS RENDERS THE CAPTURED FRAME ~1.1 s OF REAL TIME AFTER THE POSE SCRIPT RETURNS** — three separate diagnoses died on this |
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
