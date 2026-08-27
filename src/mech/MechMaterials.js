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
 */
export const MECH_PALETTES = {
  raven: {
    label: 'RAVEN', base: '#33373d', accent: '#a8241d', trim: '#16181b',
    steel: '#9aa0a6', glow: '#ff6a2a', glowHot: '#ff8a3c', soot: '#0d0e10',
  },
  balteus: {
    label: 'BALTEUS', base: '#15181c', accent: '#1f6f9e', trim: '#0a0c0e',
    steel: '#8f979e', glow: '#4ad6ff', glowHot: '#78e6ff', soot: '#070809',
  },
  baws: {
    label: 'BAWS', base: '#8d7527', accent: '#2e3033', trim: '#1b1c1e',
    steel: '#a8adb2', glow: '#ffb020', glowHot: '#ffd060', soot: '#100f0c',
  },
  rad: {
    label: 'RaD', base: '#c6c3ba', accent: '#d4661a', trim: '#2a2a2c',
    steel: '#9ea4a9', glow: '#ff8c1a', glowHot: '#ffb452', soot: '#161513',
  },
  arquebus: {
    label: 'ARQUEBUS', base: '#212a41', accent: '#a98c46', trim: '#111621',
    steel: '#949aa2', glow: '#7fc8ff', glowHot: '#a8ddff', soot: '#0a0c11',
  },
  schneider: {
    label: 'SCHNEIDER', base: '#4d545a', accent: '#63c6dc', trim: '#22262a',
    steel: '#a4aab0', glow: '#8ff0ff', glowHot: '#c0f8ff', soot: '#14171a',
  },
  vespers: {
    label: 'VESPERS', base: '#241d28', accent: '#6f3a9e', trim: '#120e15',
    steel: '#8d8794', glow: '#c07aff', glowHot: '#dcaaff', soot: '#0a070c',
  },
  elcano: {
    label: 'ELCANO', base: '#2e3a33', accent: '#7fae4a', trim: '#141a17',
    steel: '#98a09a', glow: '#9cf05a', glowHot: '#c4ff8c', soot: '#0b0e0c',
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
`;

// Recolour: preserve the baked texture's luminance structure (panel seams, grime,
// weld beads) and drive its hue from the palette. Pixels far brighter than the
// texture mean are chipped paint showing bare metal — those desaturate instead of
// taking the tint, which is what stops dark palettes eating all the wear detail.
const RECOLOR = /* glsl */`
#include <map_fragment>
{
  vec3 acTex = diffuseColor.rgb;
  float acLum = max( dot( acTex, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
  vec3 acSlot = uSlots[0] * vMask.x + uSlots[1] * vMask.y + uSlots[2] * vMask.z + uSlots[3] * vMask.w;
  vec3 acTint = acSlot * ( acLum / uTexMean );
  float acChip = smoothstep( uTexMean * 1.55, uTexMean * 2.70, acLum );
  diffuseColor.rgb = mix( acTint, vec3( acLum ) * 0.85, acChip * 0.80 );
  diffuseColor.rgb = mix( diffuseColor.rgb, uSoot, uDamage * 0.55 );
}
`;

const ROUGH = /* glsl */`
#include <roughnessmap_fragment>
roughnessFactor *= dot( uSlotRough, vMask );
roughnessFactor = clamp( mix( roughnessFactor, 0.93, uDamage * 0.55 ), 0.035, 1.0 );
`;

// Explicit per-slot metalness keeps every surface at a physical 1.0 or 0.0 —
// nothing in between, per the project's PBR rule.
const METAL = /* glsl */`
#include <metalnessmap_fragment>
metalnessFactor = dot( uSlotMetal, vMask );
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

function slotUniforms(palette, rough, metal) {
  const c = (h) => new THREE.Color(h).convertSRGBToLinear();
  return {
    uSlots: { value: [c(palette.base), c(palette.accent), c(palette.trim), c(palette.steel)] },
    uSlotRough: { value: new THREE.Vector4(rough[0], rough[1], rough[2], rough[3]) },
    uSlotMetal: { value: new THREE.Vector4(metal[0], metal[1], metal[2], metal[3]) },
    uTexMean: { value: 0.26 },
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
   */
  async bake(onProgress) {
    if (this._baked) return this;
    const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

    onProgress?.(0.1, 'armour panelling');
    // Baked at a neutral mid grey: the shader recolours from luminance, so one
    // texture set serves every palette in the game.
    this.armorTex = this.forge.armorPanel({
      size: 768, seed: 1207, baseColor: '#9aa1a8', accentColor: '#8e949b',
      panelScale: 5, wear: 0.42, grime: 0.50, rivets: true, stencil: true,
      emissiveColor: '#ffffff', emissiveDensity: 0.10, metal: 1.0, baseRough: 0.38,
    });
    await yieldFrame();

    onProgress?.(0.5, 'fine plating');
    this.armorFineTex = this.forge.armorPanel({
      size: 512, seed: 6011, baseColor: '#9aa1a8', accentColor: '#8e949b',
      panelScale: 9, wear: 0.32, grime: 0.44, rivets: true, stencil: true,
      emissiveColor: '#ffffff', emissiveDensity: 0.16, metal: 1.0, baseRough: 0.34,
    });
    await yieldFrame();

    onProgress?.(0.8, 'joint housings');
    this.mechTex = this.forge.armorPanel({
      size: 384, seed: 3307, baseColor: '#8e9298', accentColor: '#83878d',
      panelScale: 8, wear: 0.30, grime: 0.72, rivets: false, stencil: false,
      emissiveDensity: 0, metal: 1.0, baseRough: 0.66,
    });

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
      envMapIntensity: 1.0,
      aoMapIntensity: 0.85,
      dithering: true,
      ...extra,
    });
    m.normalScale.set(1.0, 1.0);
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

    // slot order: base paint, accent paint, dark trim, bare steel
    const rough = [1.0 + rb, 0.94 + rb, 1.12 + rb, 0.62 + rb];
    const metal = [1, 1, 1, 1];

    const armor = patch(this._standard(this.armorTex, {
      emissiveMap: this.armorTex.emissiveMap,
      emissive: new THREE.Color(pal.glow),
      emissiveIntensity: 1.5 * boost,
    }), slotUniforms(pal, rough, metal), 'acntr-mech-armor');
    armor.userData.baseEmissive = 1.5 * boost;

    const armorFine = patch(this._standard(this.armorFineTex, {
      emissiveMap: this.armorFineTex.emissiveMap,
      emissive: new THREE.Color(pal.glow),
      emissiveIntensity: 1.7 * boost,
    }), slotUniforms(pal, rough, metal), 'acntr-mech-armor');
    armorFine.userData.baseEmissive = 1.7 * boost;

    // Dark mechanical: rubberised booting, cable looms, joint shrouds. Slots 0-2 are
    // all dielectric here; slot 3 stays metal so pistons read as bare steel.
    const mechPal = { ...pal, base: pal.trim, accent: pal.trim, trim: pal.trim };
    const mech = patch(this._standard(this.mechTex, {}),
      slotUniforms(mechPal, [1.28 + rb, 1.22 + rb, 1.30 + rb, 0.55 + rb], [0, 0, 0, 1]),
      'acntr-mech-dark');
    mech.userData.uniforms.uTexMean.value = 0.24;

    // Emissive elements. Intensity well above 1 so the bloom pass actually catches
    // them after ACES tonemapping.
    const glow = new THREE.MeshStandardMaterial({
      color: 0x05070a,
      emissive: new THREE.Color(pal.glow),
      emissiveIntensity: 4.2 * boost,
      emissiveMap: this.stripe,
      roughness: 0.28,
      metalness: 0,
      toneMapped: true,
    });
    glow.userData.baseEmissive = 4.2 * boost;

    const glowHot = new THREE.MeshStandardMaterial({
      color: 0x08070a,
      emissive: new THREE.Color(pal.glowHot),
      emissiveIntensity: 6.5 * boost,
      roughness: 0.35,
      metalness: 0,
      toneMapped: true,
    });
    glowHot.userData.baseEmissive = 6.5 * boost;

    const set = new MaterialSet(
      { armor, armorFine, mech, glow, glowHot },
      [armor, armorFine, glow, glowHot],
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
