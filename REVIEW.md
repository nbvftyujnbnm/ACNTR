# ACNTR — Visual Review Rubric

The reviewer's job is to fail things. A frame passes only when a reviewer who
knows Armored Core VI well would not immediately be able to tell which of the two
images is the hobby project.

## How a review runs

```bash
node tools/capture.mjs --out shots/iterNN
```

Then `Read` each PNG in `shots/iterNN/` **as an image** and grade it. Read
`shots/iterNN/report.json` for draw calls / triangles / fps / console errors.

A boot failure (exit code 2) is an automatic FAIL for every category — fix the
crash before grading anything.

## The reference standard

We cannot download Armored Core VI screenshots in this sandbox (the network
policy blocks image hosts), so the comparison is made against the reviewer's own
knowledge of the game. To keep that rigorous, here is what an AC6 frame actually
looks like — grade against these specifics, not a vague impression:

**Colour and light.** Heavily desaturated. The palette is steel grey, oxidised
ochre, dust beige, with saturation concentrated *only* in emissives — cyan/white
thruster plumes, orange muzzle flashes, red warning lamps, the amber HUD. The sun
is low, harsh and hazy; contrast is high but highlights roll off filmically rather
than clipping to white. Shadows are deep but never crushed to pure black — there
is always bounce/ambient fill in them.

**Atmosphere.** Aerial perspective is strong and *layered* — distant geometry
progressively desaturates and lifts in value, and there are visible bands of haze
and dust at different depths. It is never a uniform fog wash. Dust and particulate
drift through the air near the ground.

**Surfaces.** No surface is flat. Every panel has: seam lines, bevelled/chamfered
edges catching a specular highlight, rivets or fasteners, stencilled markings,
grime accumulated in the recesses, and paint chipped to bare metal on the corners.
Metal reads as metal — it has a bright, tight specular response and picks up the
environment. Concrete reads as concrete — matte, aggregate-textured, water-stained.

**The mech.** Hard-surface industrial design, not organic. Small head, heavy
overlapping chest plating, exposed hydraulics and cabling at the joints, big
splayed feet. It reads as a *machine that weighs 60 tonnes*. Silhouette is
asymmetric and busy at the edges. Texel density is consistent across every part.

**Scale.** There is always something enormous in frame for the mech to be small
against. Foreground, midground and background all have content.

**VFX.** Fast and violent, then gone. Muzzle flashes are 2–3 frames of an
anisotropic star-shaped flash with a white-hot core. Explosions start as a white
flash, become a turbulent orange fireball, and leave black smoke that lingers far
longer than the fire did. Everything bright blooms with a *tight hot core and a
wide soft halo* — never a uniform glow.

**Motion.** Motion blur and FOV change do the work of communicating 90 m/s.

**HUD.** Thin 1px vector lines, monospaced numerals, wide letter-spacing, mostly
empty screen. Bracketed reticle, boxed targets. Cyan/amber/red on near-black.
Nothing is a filled rounded rectangle.

## Categories and the pass bar

Grade each **0–10**. Anything below **8** is a FAIL and generates a specific,
actionable defect list. 8+ in every category on every pose ends the loop.

| # | Category | What is being judged | Poses |
|---|---|---|---|
| 1 | Mech design & modelling | Silhouette, chamfers, greebles, proportions, joints | `hero`, `mech_detail` |
| 2 | Materials & texturing | Panel lines, wear, texel density, metal response, no flat colour | `hero`, `mech_detail`, `vista` |
| 3 | Lighting & shadows | Key/fill balance, shadow softness & contact, no acne/peter-pan | all |
| 4 | Atmosphere & sky | Haze layering, aerial perspective, sky believability, no banding | `vista`, `gameplay` |
| 5 | Level art & scale | Composition, landmark, greebling, repetition, sense of size | `vista`, `gameplay` |
| 6 | Post-processing | Tonemap, bloom quality, AA, motion blur, grade — filmic not gamey | all |
| 7 | VFX | Flash/fireball/smoke structure, HDR cores, timing, tracers | `combat_vfx` |
| 8 | HUD & UI | Line weight, typography, layout, density, readability | `hud`, `gameplay`, `garage` |
| 9 | Motion & speed | Does the boost frame read as fast | `boost` |
| 10 | Performance | ≥50 fps target, <400 draw calls, <4M tris, zero console errors | `report.json` |

### Category 1 has a measured half

Silhouette is the one part of this rubric that does not have to be argued from
a lit screenshot, and it should not be. Run:

```bash
node tools/silhouette.mjs --out shots/silNN
```

It renders the mech as a black shape on white with the post stack bypassed and
scores the result. Grade category 1 against these numbers *as well as* the
images, and quote them in the verdict:

**Judge the 45° and 135° yaws.** Not the mean, and not the 0/90 extremes. A
biped backfills its own negative space at the cardinal angles — dead side-on,
the far leg sits exactly behind the near one and plugs every gap in it; dead
front-on, the arms hang over the torso. Those two views score badly no matter
how good the design is, so scoring them punishes geometry that is fine. The
3/4 views are also the ones the hero and gameplay cameras actually use.

| Metric | Bar | What it catches |
|---|---|---|
| `openRows` | ≥ 0.35 at 45°/135° | fraction of rows you can see sky through. The negative-space measure — an AC reads as struts and armour because of its holes. |
| `holeCount` | ≥ 2 at 45°/135° | fully enclosed sky: through a shoulder gantry, a knee linkage. Rarer and stronger than `openRows`. |
| `complexity` | ≥ 2.2 | outline busyness vs. a disc of equal area. A smooth capsule scores low. |
| `widths` | thigh band ≥ shin band | 12-band head-to-foot profile. On an AC the thigh is the widest part of the leg; if band 8 is under band 10 the proportion is inverted and the mech reads spindly. Read it per-yaw: a leg can taper correctly head-on and still be a featureless slab in profile. |
| `fill` | *trend only* | mech pixels / bbox pixels. Compare the SAME yaw across iterations; do not grade it against an absolute band. The bbox rotates with the camera, so the denominator is not comparable between yaws, and no honest absolute band for it has been established here. |

These bars come from the shape language described above, **not** from measuring
the real game — AC6 frames cannot be downloaded in this sandbox. Clearing them
is necessary for an 8, not sufficient: a shape can hit every number and still be
ugly. Where a number and the image disagree, believe the image and go fix the
metric — two of these were wrong on their first outing.

## Required verdict format

```
POSE: <name>
SCORE: <n>/10 per category (only the categories that pose covers)
VERDICT: PASS | FAIL
BLIND TEST: Placed next to a real AC6 frame, I would identify ours as the
            non-AC6 image in <1s | 1-3s | I would have to look carefully |
            I could not reliably tell.
TOP DEFECTS (ranked, specific, actionable):
  1. <what is wrong> → <which module owns it> → <what to change>
  2. ...
```

"Looks good" is not a review. Every FAIL must name the file/system to change.

## Automatic failures

- Any console error in `report.json`'s `consoleErrors`. Its separate
  `benignErrors` list is the blocked Google Fonts fetch — this sandbox's network
  policy blocks that host, it has nothing to do with the render, and it is not a
  failure. It does mean the HUD in every captured frame is in its FALLBACK type
  stack rather than the Rajdhani / Share Tech Mono it ships with, so weigh
  category 8 on layout, line weight, density and hierarchy rather than on the
  letterforms themselves.
- Any untextured / flat-shaded surface visible in frame.
- Visible hard polygon silhouette on anything meant to be curved.
- Bloom with no hot core, or bloom that washes the frame.
- Banding in the sky or in any gradient.
- Aliased crawling edges on metal.
- A HUD element in a default sans-serif or with a filled gradient background.
- Anything that reads as "a Three.js demo".
