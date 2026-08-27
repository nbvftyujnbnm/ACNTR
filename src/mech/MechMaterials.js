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
 * headroom left and collapses to black the moment the key light softens. Every
 * `base` here therefore sits in 0.10..0.30 linear; the *look* stays dark because
 * grime, seam AO and the tonemap take it back down, not because the albedo was
 * authored black.
 */
export const MECH_PALETTES = {
  raven: {
    label: 'RAVEN', base: '#666c74', accent: '#8a3a2e', trim: '#3a3e43',
    steel: '#9aa0a7', glow: '#ff7a2a', glowHot: '#ffab5e', soot: '#111214',
  },
  balteus: {
    label: 'BALTEUS', base: '#464e57', accent: '#3d6f8f', trim: '#2c3138',
    steel: '#949aa1', glow: '#5fdcff', glowHot: '#a6ecff', soot: '#0c0e11',
  },
  baws: {
    label: 'BAWS', base: '#8e7c41', accent: '#54575c', trim: '#3c3e41',
    steel: '#9ea3a8', glow: '#ffb833', glowHot: '#ffd97a', soot: '#15130f',
  },
  rad: {
    label: 'RaD', base: '#bab5a8', accent: '#b6702f', trim: '#4a4946',
    steel: '#9ba0a5', glow: '#ff9a2e', glowHot: '#ffc06a', soot: '#1a1815',
  },
  arquebus: {
    label: 'ARQUEBUS', base: '#465066', accent: '#9d8a5c', trim: '#30363f',
    steel: '#969ca4', glow: '#8fd2ff', glowHot: '#c6e8ff', soot: '#0e1015',
  },
  schneider: {
    label: 'SCHNEIDER', base: '#737a81', accent: '#5f97a4', trim: '#40454a',
    steel: '#a0a6ac', glow: '#9df4ff', glowHot: '#d6faff', soot: '#171a1d',
  },
  vespers: {
    label: 'VESPERS', base: '#4c4355', accent: '#6d4d8c', trim: '#332c39',
    steel: '#918b9a', glow: '#c98cff', glowHot: '#e4bcff', soot: '#0f0b12',
  },
  elcano: {
    label: 'ELCANO', base: '#556354', accent: '#77914f', trim: '#333a34',
    steel: '#949a95', glow: '#a8f26a', glowHot: '#cfff96', soot: '#0f120f',
  },
};

export const PALETTE_KEYS = Object.keys(MECH_PALETTES);

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
// Written by the recolour chunk, read again by roughness/metalness further down
// the chunk order: 1 where the paint has been abraded off to bare metal.
float acChipG = 0.0;
`;

// Recolour: preserve the baked texture's luminance structure (panel seams, grime,
// weld beads) and drive its hue from the palette. Pixels far brighter than the
// texture mean are chipped paint showing bare metal — those desaturate instead of
// taking the tint, which is what stops dark palettes eating all the wear detail.
//
// The tint is applied around the texture's MEASURED mean (see MechMaterials.bake),
// so `uSlots[n]` is literally the albedo of a clean, averagely-lit patch of that
// paint. Authoring the palette then means picking real paint colours instead of
// guessing what survives an unknown texture gain.
const RECOLOR = /* glsl */`
#include <map_fragment>
{
  vec3 acTex = diffuseColor.rgb;
  float acLum = max( dot( acTex, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
  vec3 acSlot = uSlots[0] * vMask.x + uSlots[1] * vMask.y + uSlots[2] * vMask.z + uSlots[3] * vMask.w;
  // Ratio is soft-limited: without it a bright chip multiplies a light palette
  // straight past 1.0 and blows out, and a dark seam crushes to absolute black.
  float acRatio = clamp( acLum / uTexMean, 0.16, 2.6 );
  vec3 acTint = acSlot * acRatio;
  acChipG = smoothstep( 1.32, 2.05, acRatio );
  // Chipped paint reveals bare alloy: hue drops out, value tracks the texture.
  // Both the threshold and the alloy's own value are deliberately conservative —
  // let the chip go too bright or too common and the armour reads as if someone
  // shook salt over it rather than as a machine that has been shot at.
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

function slotUniforms(palette, rough, metal, texMean = 0.26, seamDark = 0.55) {
  const c = (h) => new THREE.Color(h).convertSRGBToLinear();
  return {
    uSlots: { value: [c(palette.base), c(palette.accent), c(palette.trim), c(palette.steel)] },
    uSlotRough: { value: new THREE.Vector4(rough[0], rough[1], rough[2], rough[3]) },
    uSlotMetal: { value: new THREE.Vector4(metal[0], metal[1], metal[2], metal[3]) },
    uTexMean: { value: texMean },
    uSeamDark: { value: seamDark },
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
    this.list = Object.values(materials);
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
   * Bake the shared texture sets. Yields between passes so a boot progress bar can
   * paint — each armorPanel call is hundreds of milliseconds of noise generation.
   *
   * Sizes are chosen together with MechFactory's TILES_* constants so all three
   * sets land on the SAME texels-per-metre (see MechFactory). The absolute number
   * matters as much as the consistency: the previous bake ran at ~690 texels/m,
   * which put a whole plate inside 22 cm and meant that at any real viewing
   * distance every seam, rivet and stencil averaged away into flat grey. These
   * cover 3–4 m per tile, so a plate is ~0.5–1.1 m and its seam is a line you can
   * actually see from 20 m.
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
    onProgress?.(0.1, 'armour panelling');
    // Baked at a neutral mid grey: the shader recolours from luminance, so one
    // texture set serves every palette in the game.
    // `panelScale` is plates-per-tile, and a tile is 4 m of mech (see TILES_MAIN).
    // At 4 the recursive splitter produced ~20 plates per 1024 px, i.e. one plate
    // per 1-2 m, so the chest was a single seamless slab. 9 lands plates at
    // 0.2-0.8 m — dense enough that no armour panel is ever a flat rectangle.
    //
    // `wear` has a hard threshold inside the forge: chips only appear where
    // (1 - worley) * wear clears 0.6, so anything under ~0.62 produces literally
    // no chipped paint. The old 0.42 meant the chipping the forge advertises had
    // never once been visible on a mech.
    onProgress?.(0.1, 'armour panelling');
    // Baked at a neutral mid grey: the shader recolours from luminance, so one
    // texture set serves every palette in the game.
    this.armorTex = this.forge.armorPanel({
      size: 1024, seed: 1207, baseColor: '#9aa1a8', accentColor: '#8e949b',
      panelScale: 9, wear: 0.66, grime: 0.52, rivets: true, stencil: true,
      emissiveDensity: 0, metal: 1.0, baseRough: 0.34,
    });
    await yieldFrame();

    onProgress?.(0.5, 'fine plating');
    this.armorFineTex = this.forge.armorPanel({
      size: 768, seed: 6011, baseColor: '#9aa1a8', accentColor: '#8e949b',
      panelScale: 12, wear: 0.62, grime: 0.46, rivets: true, stencil: true,
      emissiveDensity: 0, metal: 1.0, baseRough: 0.30,
    });
    await yieldFrame();

    onProgress?.(0.8, 'joint housings');
    this.mechTex = this.forge.armorPanel({
      size: 512, seed: 3307, baseColor: '#8e9298', accentColor: '#83878d',
      panelScale: 10, wear: 0.50, grime: 0.74, rivets: false, stencil: false,
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
    // Seam bevels and rivet domes live entirely in the normal map — pushing it
    // past 1 is what makes them survive at hero distance under a soft key.
    m.normalScale.set(1.75, 1.75);
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
    }), slotUniforms(pal, rough, metal, this.armorMean ?? 0.26, 0.80), 'acntr-mech-armor');

    const armorFine = patch(this._standard(this.armorFineTex, {
      emissive: new THREE.Color(0x000000),
    }), slotUniforms(pal, rough, metal, this.armorFineMean ?? 0.26, 0.76), 'acntr-mech-armor');

    // Dark mechanical: rubberised booting, cable looms, joint shrouds. Slots 0-2
    // are all dielectric here; slot 3 stays metal so pistons read as bare steel.
    // The structural grey is the trim pushed a little toward steel — pure trim is
    // so dark that every joint became a silhouette hole between the armour plates.
    const struct = '#' + new THREE.Color(pal.trim).lerp(new THREE.Color(pal.steel), 0.22).getHexString();
    const mechPal = { ...pal, base: struct, accent: struct, trim: '#' + new THREE.Color(pal.trim).getHexString() };
    const mech = patch(this._standard(this.mechTex, {}),
      slotUniforms(mechPal, [1.16 + rb, 1.10 + rb, 1.24 + rb, 0.42 + rb], [0, 0, 0, 1],
        this.mechMean ?? 0.24, 0.60),
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
