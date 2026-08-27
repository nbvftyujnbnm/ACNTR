import * as THREE from 'three';
import { clamp } from '../core/MathUtils.js';

/**
 * MechMaterials — shared PBR material construction for every mech in the game.
 *
 * The expensive part (procedural armour panelling, ORM packing, normal derivation)
 * happens ONCE in `bake()`. After that, spawning a mech only allocates a handful of
 * MeshStandardMaterials that share those GPU textures.
 *
 * Recolouring is done in-shader from a per-vertex one-hot `aMask` attribute rather
 * than with separate materials, so painted armour, an accent stripe, dark structure
 * and bare steel actuators all live in a single draw call. `aMask` is written by
 * MechParts.GeoBuilder.
 */

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/**
 * Colour schemes. `base`/`accent`/`trim`/`steel` map to mask slots 0..3;
 * `glow` drives optics and vents, `glowHot` drives thruster cores.
 *
 * Values are the colour of the PAINT, not the colour of the rendered pixel.
 * Painted armour is a dielectric, so almost all of what you see is the diffuse
 * term — a base darker than ~0.09 linear (roughly #4a4f55 in sRGB) has no
 * headroom left and collapses to black the moment the key light softens.
 *
 * Every `base` now sits at **0.10..0.46 linear, most of them near 0.19**. The
 * previous set bottomed out at 0.06 (vespers) and averaged 0.15, which survived
 * direct sun but went to pure black on the shadow side — all the panel work,
 * chipping and stencilling this file exists to produce was simply not there on
 * half of every frame. Grime, seam AO and the tonemap still take the look back
 * down; what they can no longer do is take it to zero.
 *
 * `base` is the albedo of an AVERAGE texel, and the average is dragged down by
 * grime and seams, so a CLEAN plate renders about 1.25x this (the baked map's
 * 75th-90th percentile sits at ratio 1.14-1.35 against `armorMean`; re-measure
 * that if you retune the forge parameters). 0.19 here therefore paints a
 * clean plate at ~0.24 linear, which is real battleship grey. An earlier pass at
 * 0.235 put clean plates at 0.29 and the sunlit side of the arms went to a white
 * slab that read as unpainted metal.
 *
 * Chroma matters as much as value. Every base has since been pushed away from
 * its own luminance (which leaves `dot(luminanceWeights, rgb)` exactly unchanged)
 * until it carries real hue: raven went from 0.115 to 0.197 saturation at an
 * identical 0.189 linear. A near-neutral paint has nothing to hold on to when a
 * warm key hits it, so the lit side of every part collapsed to the colour of the
 * sun and read as bare plastic while the shadow side, lit by the blue sky term,
 * stayed blue. Paint with chroma keeps its identity in both.
 */
export const MECH_PALETTES = {
  raven: {
    label: 'RAVEN', base: '#6e7989', accent: '#9b4235', trim: '#484e58',
    steel: '#a4aab2', glow: '#ff7a2a', glowHot: '#ffab5e', soot: '#111214',
  },
  balteus: {
    label: 'BALTEUS', base: '#546372', accent: '#3d6f8f', trim: '#39424f',
    steel: '#9ea4ab', glow: '#5fdcff', glowHot: '#a6ecff', soot: '#0c0e11',
  },
  baws: {
    label: 'BAWS', base: '#8e7c41', accent: '#5b5e64', trim: '#4b4e54',
    steel: '#a5aab0', glow: '#ffb833', glowHot: '#ffd97a', soot: '#15130f',
  },
  rad: {
    label: 'RaD', base: '#beb59c', accent: '#b6702f', trim: '#4f4e4a',
    steel: '#a5aab0', glow: '#ff9a2e', glowHot: '#ffc06a', soot: '#1a1815',
  },
  arquebus: {
    label: 'ARQUEBUS', base: '#536488', accent: '#9d8a5c', trim: '#3d4959',
    steel: '#a0a6af', glow: '#8fd2ff', glowHot: '#c6e8ff', soot: '#0e1015',
  },
  schneider: {
    label: 'SCHNEIDER', base: '#6d7b87', accent: '#5f97a4', trim: '#474f56',
    steel: '#a4aab1', glow: '#9df4ff', glowHot: '#d6faff', soot: '#171a1d',
  },
  vespers: {
    label: 'VESPERS', base: '#625372', accent: '#715090', trim: '#473a52',
    steel: '#9b94a4', glow: '#c98cff', glowHot: '#e4bcff', soot: '#0f0b12',
  },
  elcano: {
    label: 'ELCANO', base: '#627e60', accent: '#77914f', trim: '#424f43',
    steel: '#9ea49f', glow: '#a8f26a', glowHot: '#cfff96', soot: '#0f120f',
  },
};

export const PALETTE_KEYS = Object.keys(MECH_PALETTES);

// ---------------------------------------------------------------------------
// Texel density — ONE number for the whole mech
// ---------------------------------------------------------------------------

/**
 * Texels per metre of mech surface. Every armour map is baked so that
 * `size / MECH_TILE_METRES` lands on exactly this, and MechFactory derives every
 * part's UV scale from `MECH_TILE_METRES` alone. Nothing else is allowed to pick
 * its own tiling — inconsistent texel density is the single most legible
 * "this is a hobby project" tell in a side-by-side.
 */
export const MECH_TEXELS_PER_M = 320;

/**
 * World size of one texture tile, in metres.
 *
 * Holding texels/m constant is only HALF of consistency. The forge's plate
 * splitter is depth-capped, so a tile contains roughly the same 30-60 plates no
 * matter what `panelScale` says, and its noise fields are specified in cycles
 * PER TILE. That means the world size of a plate, a grime blotch and a chip is
 * set by the tile's world size, not by its resolution. The previous bake ran
 * three sets at 3.2 m / 2.4 m / 1.6 m per tile — all at 320 texels/m, but with
 * grime blobs at 40 cm on the chest, 30 cm on the arms and 20 cm on the joints.
 * That is why the accent pauldron read visibly coarser and blotchier than the
 * plates around it. Every set is now baked at 1024² on the SAME 3.2 m tile.
 */
export const MECH_TILE_METRES = 3.2;

/** Resolution every mech map is baked at: 3.2 m * 320 texels/m. */
const MECH_TEX_SIZE = Math.round(MECH_TILE_METRES * MECH_TEXELS_PER_M); // 1024

/**
 * Speckle guard (see RECOLOR). `SPECKLE_LOD` is the mip bias of the reference
 * tap: 2.6 is a ~6-texel neighbourhood, i.e. ~2 cm of hull at this density —
 * comfortably above the forge's 4-texel scratch noise and comfortably below its
 * chip cells (~54 texels) and rivets (~6 texels across, which survive because
 * their residual is only partly removed at 0.8 strength).
 */
const SPECKLE_CUT = 0.80;
const SPECKLE_LOD = 2.6;

/**
 * Mip bias of the chip gate's PLATE-SCALE reference tap (see RECOLOR). 5.5 is a
 * ~45-texel neighbourhood — 14 cm of hull at MECH_TEXELS_PER_M, which sits
 * between a chip cell (9-20 texels) and a plate (100-300), so a chip stands out
 * against it while a whole tinted plate does not.
 */
const CHIP_LOD = 5.5;

/**
 * Detail layer (see RECOLOR). `DETAIL_SCALE` is how many times per macro tile
 * the second tap repeats, so its tile is 3.2 / 3.11 = 1.03 m and its plates land
 * at ~0.19 m — small enough that a 0.5 m pauldron face crosses two or three of
 * them instead of sitting inside one 0.58 m macro plate. It is deliberately not
 * a round number: 3.2 would put the two layers back in phase every 5 tiles.
 *
 * This is the ONLY sanctioned way to add feature scales to the mech. It is
 * applied identically to every part, so metres-per-feature — the invariant the
 * tile unification exists to protect — still holds; there are simply two scales
 * of it everywhere instead of one.
 */
const DETAIL_SCALE = 3.11;
const DETAIL_MIX = 0.58;
/** Tangent-space tilt the detail layer adds on top of the macro normal. */
const DETAIL_NORMAL = 0.55;

// ---------------------------------------------------------------------------
// Shader injection
// ---------------------------------------------------------------------------

const PARS_VERT = /* glsl */`
attribute vec4 aMask;
varying vec4 vMask;
`;

const PARS_FRAG = /* glsl */`
varying vec4 vMask;
uniform vec3 uSlots[4];
uniform vec4 uSlotRough;
uniform vec4 uSlotMetal;
uniform float uTexMean;
uniform float uDamage;
uniform vec3 uSoot;
uniform vec3 uDamageGlow;
uniform float uSeamDark;
uniform float uSpeckle;
uniform float uSpeckleLod;
uniform float uDetail;
uniform float uDetailScale;
uniform float uDetailNormal;
uniform float uChipLod;
// Written by the recolour chunk, read again by roughness/metalness further down
// the chunk order: 1 where the paint has been abraded off to bare metal.
float acChipG = 0.0;
// Detail-layer luminance ratio, also written by the recolour chunk and read by
// the roughness chunk so sub-panel structure breaks up the specular too.
float acDetail = 1.0;
// Luminance of a PLATE-SCALE tap of the albedo map. 0 means "no map bound", in
// which case the chip gate's locality test is skipped rather than failed.
float acPlateLum = 0.0;
`;

// Recolour: preserve the baked texture's luminance structure (panel seams, grime,
// weld beads) and drive its hue from the palette. Pixels far brighter than the
// texture mean are chipped paint showing bare metal — those desaturate instead of
// taking the tint, which is what stops dark palettes eating all the wear detail.
//
// The tint is applied around the texture's MEASURED mean (see MechMaterials.bake),
// so `uSlots[n]` is literally the albedo of an AVERAGE texel of that paint.
// Authoring the palette then means picking real paint values instead of guessing
// what survives an unknown texture gain — bearing in mind that the average is
// pulled down by grime and seams, so a clean plate lands ~1.25x the palette value.
const RECOLOR = /* glsl */`
#include <map_fragment>
{
  vec3 acTex = diffuseColor.rgb;
#ifdef USE_MAP
  // --- speckle guard ------------------------------------------------------
  // The forge lays its scratch field down at ~220 cycles per tile, i.e. about
  // FOUR TEXELS per feature. At any sane texel density that is not wear, it is
  // white noise: a few percent of texels sit far above their neighbours, the
  // recolour below promotes each isolated one to polished bare alloy, and the
  // armour ends up looking like a photograph taken at ISO 25600 rather than
  // like chipped paint.
  //
  // Fix it by frequency rather than by amplitude, because amplitude is shared
  // with the chipping we want to keep. Take a second tap several mips up and
  // subtract only the POSITIVE residual: isolated bright specks flatten toward
  // their neighbourhood, while dark seam lines (a negative residual) and the
  // large chip/grime fields (present in both taps) are untouched. The clamp
  // bounds the correction to real speckle amplitude so that a distant fragment,
  // whose base tap is already several mips up, cannot have its plate tinting
  // subtracted away.
  vec3 acLo = texture2D( map, vMapUv, uSpeckleLod ).rgb;
  acTex -= clamp( acTex - acLo, vec3( 0.0 ), vec3( 0.10 ) ) * uSpeckle;

  // --- detail layer -------------------------------------------------------
  // One armour tile covers MECH_TILE_METRES (3.2 m) and the forge's splitter is
  // depth-capped at ~30 plates inside it, so a plate is ~0.58 m ACROSS EVERY
  // PART. That is correct for a chest, which spans a full tile and crosses six
  // seams, and useless for a pauldron or a forearm shell: a 0.5 m face lands
  // inside a SINGLE plate and renders as one flat colour with a couple of bolts.
  // Measured: the core's armour spans 1.01 x 1.10 tiles over 30 plates, the
  // forearm's 0.30 x 0.57 over 9 — and any one FACE of it sits inside one.
  //
  // Rescaling small parts' UVs would fix the coverage by breaking texel density,
  // which is the defect the tile unification just removed. So add a SECOND scale
  // of the same map instead, at a fixed fraction of the tile — constant in
  // metres per feature, on every part, exactly like the macro layer. Big parts
  // gain sub-panel plating; small parts, which see only a flat patch of the
  // macro layer, take their entire read from it.
  //
  // Only the detail tap's LUMINANCE RATIO is used, so it MODULATES the macro
  // layer rather than replacing it, and the ratio is clamped asymmetrically:
  // it may darken to 0.31 (sub-panel seams, grime in recesses, which is what
  // sub-panel detail actually looks like) but brighten only to 1.38. That
  // asymmetry is also what stops the detail tap — the one sample the speckle
  // guard above does not cover — from reintroducing bright speckle at a new
  // frequency. It does NOT keep the detail layer clear of the chip gate: 1.38 is
  // a MULTIPLIER on acRatio, not a value compared against the gate, so the gate
  // reads acMacro instead (see below).
  vec3 acDet = texture2D( map, vMapUv * uDetailScale ).rgb;
  float acDetLum = max( dot( acDet, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
  acDetail = clamp( acDetLum / uTexMean, 0.31, 1.38 );
  acTex *= mix( 1.0, acDetail, uDetail );

  // --- plate-scale reference tap ------------------------------------------
  // Deliberately far coarser than the speckle guard's: ~45 texels, i.e. 14 cm of
  // hull, which sits between a chip cell (9-20 texels) and a plate (100-300).
  // The chip gate uses it to ask "is this texel brighter than the PLATE it is
  // on", which is a question the map mean cannot answer. See the gate below.
  acPlateLum = max( dot( texture2D( map, vMapUv, uChipLod ).rgb,
    vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
#endif
  float acLum = max( dot( acTex, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
  vec3 acSlot = uSlots[0] * vMask.x + uSlots[1] * vMask.y + uSlots[2] * vMask.z + uSlots[3] * vMask.w;
  // MACRO ratio: the same measurement with the detail layer's modulation taken
  // back out. Only the chip gate below reads this — see the note there.
  float acMacro = clamp( acLum / ( uTexMean * mix( 1.0, acDetail, uDetail ) ), 0.22, 2.6 );
  // Ratio is soft-limited: without it a bright chip multiplies a light palette
  // straight past 1.0 and blows out, and a dark seam crushes to absolute black.
  // The floor is 0.22 rather than 0.16 because 0.16 * uSeamDark took the deepest
  // seams to ~3% of the paint's albedo — a black hole, not a shadowed groove.
  float acRatio = clamp( acLum / uTexMean, 0.22, 2.6 );
  vec3 acTint = acSlot * acRatio;
  // Chip onset, expressed against the baked map's MEASURED distribution rather
  // than guessed. The old 1.32 -> 2.05 window looked conservative and was not:
  // 10% of every armour texel sits above ratio 1.32, and the map's maximum is
  // only ~2.1, so a tenth of the surface got a low-grade dose of neutral alloy
  // and no chip ever reached even half strength. The result was armour whose
  // hue quietly drained out on the lit side — pale, plasticky, and nothing
  // anywhere that read as an actual chip. 1.44 -> 1.80 puts the onset at the
  // 97.6th percentile and full strength at the 99.9th: ~2.4% of the map takes
  // any alloy at all, and the texels that do are the real chip cells.
  //
  // Gated on the MACRO ratio, deliberately, not on the detail-modulated one.
  // The detail layer multiplies acRatio by up to 1.22, and a multiplier does not
  // respect a threshold: an ordinary bright-but-clean plate at macro 1.40 lands
  // at 1.71 and comes out as polished alloy. Measured against the real baked
  // map, feeding acRatio here took the gate from 2.0% of texels tinted at all
  // and 0.40% past half strength to 5.9% and 2.28% — nearly 6x the fully
  // alloyed area, which is why whole small parts (the pelvis skirt worst of all)
  // drained to neutral grey under a brighter environment. Reading the macro
  // ratio also means DETAIL_MIX and DETAIL_SCALE can be retuned freely without
  // silently repainting the mech in bare metal.
  //
  // SECOND GATE — locality. A single threshold against the map MEAN cannot tell
  // a chip from a plate that is simply bright: the forge tints every plate
  // independently by up to +16%, so a plate sitting at the top of that spread
  // clears 1.44 across its WHOLE area and comes out as one hue-free slab of
  // alloy. That is not hypothetical — it is what the pelvis skirt was doing,
  // measured at saturation 0.019 in the hero frame while every other lit surface
  // on the mech read 0.23-0.44. The alloy colour below is the only neutral in
  // this shader, so a neutral surface under a warm sun can only have come from
  // here. Asking instead whether the texel is brighter than ITS OWN PLATE makes
  // the test scale-invariant: a uniformly bright plate scores ~1.0 and stays
  // paint, while a chip scores ~1.6 against the plate it has been knocked off
  // and still passes. Multiplying the two gates can only ever REMOVE chip
  // coverage relative to the macro gate alone, never add it.
  float acLocal = acPlateLum > 0.0
    ? ( acLum / mix( 1.0, acDetail, uDetail ) ) / acPlateLum
    : 2.0;
  acChipG = smoothstep( 1.44, 1.80, acMacro ) * smoothstep( 1.12, 1.42, acLocal );
  // Chipped paint reveals bare alloy: hue drops out, value tracks the texture.
  diffuseColor.rgb = mix( acTint, vec3( 0.26, 0.265, 0.275 ) * min( acRatio, 1.5 ), acChipG * 0.70 );
  // Panel seams are the single most important read on a mech. The baked map
  // already darkens them; this pushes the contrast further in linear space so
  // they survive tonemapping and distance. The curve is anchored so an AVERAGE
  // texel is untouched — an earlier version dimmed the whole mech by 8% just to
  // sharpen lines that occupy 3% of the surface.
  float acSeam = clamp( ( 0.86 - acRatio ) * 1.35, 0.0, 1.0 );
  diffuseColor.rgb *= 1.0 - acSeam * uSeamDark;
  diffuseColor.rgb = mix( diffuseColor.rgb, uSoot, uDamage * 0.55 );
}
`;

const ROUGH = /* glsl */`
#include <roughnessmap_fragment>
roughnessFactor *= dot( uSlotRough, vMask );
// abraded metal is burnished smoother than the paint that used to cover it
roughnessFactor *= mix( 1.0, 0.66, acChipG );
// The detail layer moves the specular as well as the albedo. Without this it is
// a pattern PRINTED on the plate; with it, sub-panel seams and grime dull the
// highlight and sub-panel plating catches it, which is what makes the extra
// scale read as surface rather than as decal. Inverted and gentle: dark detail
// (recess, dirt) is rougher, bright detail (proud plating) is tighter.
roughnessFactor *= mix( 1.0, clamp( 2.05 - acDetail, 0.80, 1.22 ), uDetail );
roughnessFactor = clamp( mix( roughnessFactor, 0.93, uDamage * 0.55 ), 0.045, 1.0 );
`;

// Per-slot metalness keeps every surface at a physical 1.0 or 0.0. Painted armour
// is a DIELECTRIC — treating it as metal is what turned a dark palette into black
// plastic, because a metal has no diffuse term to carry its albedo. The only
// in-between values are the physically real transitions: chipped paint exposing
// bare alloy, and caked grime burying metal under a dielectric layer.
const METAL = /* glsl */`
#include <metalnessmap_fragment>
float acPaintMetal = dot( uSlotMetal, vMask );
float acGrime = smoothstep( 0.62, 0.40, metalnessFactor );
metalnessFactor = mix( acPaintMetal, 1.0, acChipG ) * ( 1.0 - acGrime );
`;

// Battle damage reads as heat glowing out of the panel gaps. The ORM map's red
// channel is AO, so (1 - ao) is a free seam/recess mask.
const DAMAGE_GLOW = /* glsl */`
#include <emissivemap_fragment>
#ifdef USE_ROUGHNESSMAP
  float acSeam = 1.0 - texture2D( roughnessMap, vRoughnessMapUv ).r;
#else
  float acSeam = 0.5;
#endif
totalEmissiveRadiance += uDamageGlow * ( uDamage * uDamage ) * smoothstep( 0.28, 0.95, acSeam ) * 3.0;
`;

// Detail RELIEF, the other half of the detail layer.
//
// The albedo half above rescues a small part's texture content, and on a
// midtone surface that is enough. On a surface taking the key light head-on it
// is not: measured on the sunlit forearm, doubling the albedo detail contrast
// changed the rendered pixels by less than one code value, because the grade's
// shoulder compresses a +/-25% albedo swing into +/-10% display. Relief does not
// have that problem — it moves N dot L, and at high light levels a small tilt
// buys a far larger display swing than a large albedo change does. Without this
// the sunlit arm and pauldron stay flat no matter what the albedo layer says.
//
// Appended AFTER three's own chunk and fenced on the same define, so the macro
// normal has already been resolved and `tbn` / `vNormalMapUv` are guaranteed in
// scope (normal_fragment_begin declares tbn under exactly this condition). The
// detail tap is minified 3.11x, so its one-texel micro noise is mipped away
// before it can alias — which is why this does not undo the speckle work.
const NORMAL_DETAIL = /* glsl */`
#include <normal_fragment_maps>
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 acDetN = texture2D( normalMap, vNormalMapUv * uDetailScale ).xyz * 2.0 - 1.0;
  normal = normalize( normal + tbn * vec3( acDetN.xy * uDetailNormal, 0.0 ) );
#endif
`;

function slotUniforms(palette, rough, metal, texMean = 0.26, seamDark = 0.55, speckle = SPECKLE_CUT) {
  const c = (h) => new THREE.Color(h).convertSRGBToLinear();
  return {
    uSlots: { value: [c(palette.base), c(palette.accent), c(palette.trim), c(palette.steel)] },
    uSlotRough: { value: new THREE.Vector4(rough[0], rough[1], rough[2], rough[3]) },
    uSlotMetal: { value: new THREE.Vector4(metal[0], metal[1], metal[2], metal[3]) },
    uTexMean: { value: texMean },
    uSeamDark: { value: seamDark },
    uSpeckle: { value: speckle },
    uSpeckleLod: { value: SPECKLE_LOD },
    uDetail: { value: DETAIL_MIX },
    uDetailScale: { value: DETAIL_SCALE },
    uDetailNormal: { value: DETAIL_NORMAL },
    uChipLod: { value: CHIP_LOD },
    uDamage: { value: 0 },
    uSoot: { value: c(palette.soot) },
    uDamageGlow: { value: c(palette.glowHot).multiplyScalar(1.4) },
  };
}

/** Wire the mask-remap + damage shader into a MeshStandardMaterial. */
function patch(mat, uniforms, cacheKey) {
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + PARS_VERT)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvMask = aMask;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>' + PARS_FRAG)
      .replace('#include <map_fragment>', RECOLOR)
      .replace('#include <roughnessmap_fragment>', ROUGH)
      .replace('#include <metalnessmap_fragment>', METAL)
      .replace('#include <normal_fragment_maps>', NORMAL_DETAIL)
      .replace('#include <emissivemap_fragment>', DAMAGE_GLOW);
  };
  // Constant key: every mech shares one compiled program regardless of palette.
  mat.customProgramCacheKey = () => cacheKey;
  return mat;
}

// ---------------------------------------------------------------------------
// Small locally-generated textures (the forge owns the big stuff)
// ---------------------------------------------------------------------------

/** Fine bright/dark banding — makes emissive surfaces read as lit elements, not paint. */
function stripeTexture(size = 64, duty = 0.72) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (y % 8) / 8;
      const v = t < duty ? 255 : 74;
      const j = ((x * 37 + y * 17) % 11) * 3;
      const i = (y * size + x) * 4;
      data[i] = clamp(v + j - 15, 0, 255);
      data[i + 1] = clamp(v + j - 15, 0, 255);
      data[i + 2] = clamp(v + j - 10, 0, 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 14);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Mean LINEAR luminance of a baked sRGB canvas texture.
 *
 * The recolour shader expresses the palette as "the albedo of an average texel",
 * so it needs the true mean of whatever the forge produced. Hard-coding it meant
 * that changing grime or wear quietly rescaled the brightness of every mech in
 * the game. Sampled on a stride — a 1024² map does not need a million reads to
 * know its own average.
 *
 * @param {THREE.Texture} tex a CanvasTexture whose image is a 2D canvas
 * @returns {number} mean linear luminance, clamped away from zero
 */
function meanLinearLuminance(tex) {
  const img = tex?.image;
  if (!img || !img.width) return 0.26;
  try {
    const ctx = img.getContext('2d');
    const { width: w, height: h } = img;
    const data = ctx.getImageData(0, 0, w, h).data;
    const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 65536)));
    let sum = 0, n = 0;
    const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        const i = (y * w + x) * 4;
        sum += 0.2126 * toLinear(data[i] / 255)
          + 0.7152 * toLinear(data[i + 1] / 255)
          + 0.0722 * toLinear(data[i + 2] / 255);
        n++;
      }
    }
    return n ? clamp(sum / n, 0.004, 1) : 0.26;
  } catch {
    return 0.26; // tainted/unreadable canvas — fall back to the historical value
  }
}

// ---------------------------------------------------------------------------
// MaterialSet — one per mech instance (so damage and emissive are per-mech)
// ---------------------------------------------------------------------------

export class MaterialSet {
  constructor(materials, emissives) {
    /** @type {{armor:THREE.Material, armorFine:THREE.Material, mech:THREE.Material, glow:THREE.Material, glowHot:THREE.Material}} */
    this.m = materials;
    /** Materials the VFX/HUD layer may modulate. Also mirrored onto `mech.emissives`. */
    this.emissives = emissives;
    // De-duplicated: `armor` and `armorFine` are the same object, and setDamage
    // / dispose must each touch it once.
    this.list = [...new Set(Object.values(materials))];
    this.damage = 0;
    this._emissiveScale = 1;
  }

  /** Pick the armour material appropriate to a part's physical size. */
  armorFor(fine) { return fine ? this.m.armorFine : this.m.armor; }

  /** 0..1 battle damage: soot, roughened paint, heat glow in the panel gaps. */
  setDamage(t) {
    this.damage = clamp(t, 0, 1);
    for (const mat of this.list) {
      const u = mat.userData.uniforms;
      if (u?.uDamage) u.uDamage.value = this.damage;
    }
    // scorched emissives dim and shift hot as the frame cooks
    this.setEmissiveScale(this._emissiveScale);
  }

  /** Global multiplier on every emissive element (charge-up, EMP, death fade). */
  setEmissiveScale(k) {
    this._emissiveScale = k;
    const dim = 1 - this.damage * 0.45;
    for (const mat of this.emissives) {
      mat.emissiveIntensity = (mat.userData.baseEmissive ?? 1) * k * dim;
    }
  }

  dispose() {
    for (const mat of this.list) mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// MechMaterials — the shared bake + per-mech set factory
// ---------------------------------------------------------------------------

export class MechMaterials {
  constructor(forge) {
    this.forge = forge;
    this.tex = null;
    this.stripe = null;
    this._sets = [];
    this._baked = false;
  }

  /**
   * Bake the shared texture sets.
   *
   * BOTH sets are baked at `MECH_TEX_SIZE` and are used on the SAME
   * `MECH_TILE_METRES` tile, so every surface on every mech lands on one
   * texels-per-metre AND one feature-size-per-metre. The second half of that
   * used not to hold: the sets ran at 1024/768/512 on 3.2/2.4/1.6 m tiles, which
   * is the same density but puts the forge's grime blotches at 40 cm on the
   * chest and 20 cm on the joint housings. That mismatch is what made the accent
   * pauldron read coarser and blotchier than the plates bolted next to it.
   *
   * The armour and "fine plating" material slots now SHARE one map set. A second
   * bake at a different seed bought pattern variety, but it cost a third of the
   * mech's texture memory and it could only ever be scale-consistent by being a
   * near-copy of the first. Variety comes from per-part UV offsets instead (see
   * MechFactory._partGeo), which is free.
   */
  async bake(onProgress) {
    if (this._baked) return this;
    const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

    // `emissiveDensity: 0` is load-bearing, not a style choice. When it is
    // non-zero the forge composites the (almost entirely black) emissive canvas
    // over the finished albedo with `multiply` at alpha 0.85, which multiplies
    // EVERY albedo texel by 0.15 — it is meant to darken the light channels to
    // unlit glass and instead darkens the whole plate. That crushed the map into
    // the bottom 20 of 255 sRGB code values, so the mech rendered near-black AND
    // its seams, rivets, stencils and chipped paint were quantised into mush.
    // The mech's light channels are modelled geometry in the `glow` bucket, so
    // nothing is lost by leaving the painted-on strips out.
    onProgress?.(0.15, 'armour panelling');
    // Baked at a neutral mid grey: the shader recolours from luminance, so one
    // texture set serves every palette in the game.
    //
    // `panelScale` is plates-per-tile and a tile is MECH_TILE_METRES of mech, so
    // 9 lands plates at 0.2-0.8 m — dense enough that no armour face is ever a
    // flat rectangle.
    //
    // `wear` gates the forge's chipping through a hard threshold: a texel is
    // chipped where `(1 - worley) * wear + seam * 0.28 * wear` clears 0.6. That
    // threshold is steep, so `wear` is really a coverage dial: 0.58 produced
    // literally zero chipped texels, 0.66 produced 0.2% of the map, 0.70
    // produces 0.4% in the open field plus a broad band along every plate seam
    // (the seam term contributes 0.196, which drags a fifth of each seam's
    // neighbourhood over the line). 0.70 is the setting that reads as EDGE
    // DAMAGE: chips cluster on plate borders where paint actually comes off,
    // rather than dusting the open field.
    //
    // `wear` also scales the forge's `scratch` field, which is a 4-texel white
    // noise and pure speckle at any real density. That is dealt with in the
    // shader by frequency (see RECOLOR) instead of by turning `wear` down here,
    // which is what let the chipping come back up.
    //
    // `grime` is up because dirt biases into the seams too: it keeps the
    // recesses reading dark and loaded next to the brightened paint.
    this.armorTex = this.forge.armorPanel({
      size: MECH_TEX_SIZE, seed: 1207, baseColor: '#9aa1a8', accentColor: '#8e949b',
      panelScale: 9, wear: 0.70, grime: 0.62, rivets: true, stencil: true,
      emissiveDensity: 0, metal: 1.0, baseRough: 0.36,
    });
    // Small parts sample the same plating at the same scale — see the note above.
    this.armorFineTex = this.armorTex;
    await yieldFrame();

    onProgress?.(0.6, 'joint housings');
    // Joint shrouds, cable looms, actuator sleeves: grimier, rougher, no
    // stencils. Baked at the SAME size and used on the SAME tile as the armour
    // (it used to be 512 on a 1.6 m tile, i.e. half-scale panelling on every
    // joint next to full-scale panelling on every plate).
    this.mechTex = this.forge.armorPanel({
      size: MECH_TEX_SIZE, seed: 3307, baseColor: '#8e9298', accentColor: '#83878d',
      panelScale: 10, wear: 0.56, grime: 0.72, rivets: false, stencil: false,
      emissiveDensity: 0, metal: 1.0, baseRough: 0.62,
    });
    await yieldFrame();

    // Measure what was actually baked instead of guessing. The recolour shader
    // divides by this, so a wrong value silently scales every mech's albedo.
    this.armorMean = meanLinearLuminance(this.armorTex.map);
    this.armorFineMean = meanLinearLuminance(this.armorFineTex.map);
    this.mechMean = meanLinearLuminance(this.mechTex.map);

    this.stripe = stripeTexture();
    this._baked = true;
    onProgress?.(1, 'materials ready');
    return this;
  }

  _standard(tex, extra) {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex.map,
      normalMap: tex.normalMap,
      roughnessMap: tex.roughnessMap,
      // The forge packs ORM as R=AO, G=roughness, B=metalness — exactly the
      // channels three samples. Without this every surface reads as bare metal
      // and the accumulated grime loses its dielectric response.
      metalnessMap: tex.metalnessMap,
      aoMap: tex.aoMap,
      roughness: 1,
      metalness: 1,
      envMapIntensity: 1.15,
      aoMapIntensity: 1.0,
      dithering: true,
      ...extra,
    });
    // aoMap samples UV channel 0 in three >= r151; MechParts.applyBoxUV writes
    // `uv` and aliases `uv1` to the same attribute, so both conventions resolve.
    m.aoMap.channel = 0;
    // Seam bevels and rivet domes live entirely in the normal map, so this stays
    // above 1 to keep them alive at hero distance under a soft key. It is no
    // longer 1.75: the forge's `micro` field runs to ~1.3 texels, and amplifying
    // a one-texel normal that hard turned every armour plate into a field of
    // specular sparkle that no amount of albedo work could hide. A seam's slope
    // is roughly 5x the micro field's, so it survives the cut with room to spare.
    m.normalScale.set(1.30, 1.30);
    return m;
  }

  /**
   * Build a per-mech material set. Materials are per-instance (cheap — they share
   * every texture) so damage and emissive pulses do not bleed between mechs.
   *
   * @param {string} paletteKey key into MECH_PALETTES
   * @param {object} [opts] { emissiveBoost, tierTint, roughBias }
   */
  createSet(paletteKey, opts = {}) {
    const pal = MECH_PALETTES[paletteKey] || MECH_PALETTES.raven;
    const boost = opts.emissiveBoost ?? 1;
    const rb = opts.roughBias ?? 0;

    // slot order: base paint, accent paint, dark trim, bare steel.
    // Paint is a DIELECTRIC (0) — only machined steel is a conductor (1). Getting
    // this wrong is what made the armour read as black plastic: a metal surface
    // has no diffuse lobe, so a dark base colour had nothing left to reflect but
    // a tinted environment the scene barely provides.
    const rough = [0.92 + rb, 0.84 + rb, 1.06 + rb, 0.52 + rb];
    const metal = [0, 0, 0, 1];

    // Armour carries NO emissive of its own. Painting glow strips across every
    // plate is what turned the mech into a Christmas tree — the only thing in
    // frame with any value in it was the orange. Light channels are modelled
    // geometry (the `glow` bucket), and battle damage still glows out of the
    // panel gaps through the DAMAGE_GLOW chunk, which adds on top of this.
    const armor = patch(this._standard(this.armorTex, {
      emissive: new THREE.Color(0x000000),
    }), slotUniforms(pal, rough, metal, this.armorMean ?? 0.26, 0.70), 'acntr-mech-armor');

    // `armorFine` is now the SAME material, not merely the same maps. Once both
    // slots were baked on one tile the only thing left separating them was a
    // 0.06 roughness offset, and the result was two adjacent parts of one model
    // rendering to visibly different specular — a second quality bar for no
    // gain. Small parts get their extra scale from the detail layer instead,
    // which is uniform across the whole mech. `armorFor(fine)` keeps working;
    // MaterialSet de-duplicates so damage and dispose still run once.
    const armorFine = armor;

    // Dark mechanical: rubberised booting, cable looms, joint shrouds. Slots 0-2
    // are all dielectric here; slot 3 stays metal so pistons read as bare steel.
    // The structural grey is the trim pushed a little toward steel — pure trim is
    // so dark that every joint became a silhouette hole between the armour plates.
    const struct = '#' + new THREE.Color(pal.trim).lerp(new THREE.Color(pal.steel), 0.22).getHexString();
    const mechPal = { ...pal, base: struct, accent: struct, trim: '#' + new THREE.Color(pal.trim).getHexString() };
    const mech = patch(this._standard(this.mechTex, {}),
      slotUniforms(mechPal, [1.16 + rb, 1.10 + rb, 1.24 + rb, 0.42 + rb], [0, 0, 0, 1],
        this.mechMean ?? 0.24, 0.55),
      'acntr-mech-dark');

    // Emissive elements. Intensity well above 1 so the bloom pass actually catches
    // them after ACES tonemapping — but not so far above that the strips become
    // the only thing in the frame with any value in it.
    const glow = new THREE.MeshStandardMaterial({
      color: 0x0a0d11,
      emissive: new THREE.Color(pal.glow),
      emissiveIntensity: 3.1 * boost,
      emissiveMap: this.stripe,
      roughness: 0.26,
      metalness: 0,
      toneMapped: true,
    });
    glow.userData.baseEmissive = 3.1 * boost;

    const glowHot = new THREE.MeshStandardMaterial({
      color: 0x0b0a0d,
      emissive: new THREE.Color(pal.glowHot),
      emissiveIntensity: 5.0 * boost,
      roughness: 0.34,
      metalness: 0,
      toneMapped: true,
    });
    glowHot.userData.baseEmissive = 5.0 * boost;

    const set = new MaterialSet(
      { armor, armorFine, mech, glow, glowHot },
      [glow, glowHot],
    );
    set.palette = pal;
    set.paletteKey = paletteKey;
    this._sets.push(set);
    return set;
  }

  dispose() {
    for (const s of this._sets) s.dispose();
    this._sets.length = 0;
    this.stripe?.dispose();
    this.stripe = null;
    // The forge owns armorTex/armorFineTex/mechTex and disposes them itself.
    this.armorTex = this.armorFineTex = this.mechTex = null;
    this._baked = false;
  }
}
