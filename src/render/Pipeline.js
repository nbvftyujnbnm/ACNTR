import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { clamp, damp, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { getForge } from './TextureForge.js';
import { syncSceneMaterials } from './Lighting.js';
import { FULLSCREEN_VERT } from './shaders/lib.js';
import { VELOCITY_FRAG, AO_FRAG, AO_BLUR_FRAG, SSR_FRAG, COMPOSITE_FRAG } from './shaders/post.js';
import { TAA_FRAG, TILEMAX_FRAG, NEIGHBORMAX_FRAG, MOTION_BLUR_FRAG, DOF_FRAG } from './shaders/temporal.js';
import { BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG, FINAL_FRAG } from './shaders/grade.js';

const NOISE_SIZE = 128;
const JITTER_COUNT = 16;
const MAX_BLOOM_MIPS = 6;

/** Radical-inverse van der Corput / Halton — the standard TAA jitter sequence. */
function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * RenderPipeline — hand-rolled HDR deferred-post stack.
 *
 * Pass order (everything up to the final pass is linear HDR):
 *   1  scene            -> rtScene (+ depth texture), TAA-jittered projection
 *   2  velocity         -> rtVelocity      (camera reprojection from depth)
 *   3  tile max x2 + neighbour max         (bounds the motion blur radius)
 *   4  SSAO + bilateral blur               (half res)
 *   5  SSR                                 (half res)
 *   6  composite: AO * scene + SSR + height fog  -> rtA
 *   7  TAA resolve                         -> history ping-pong
 *   8  motion blur
 *   9  depth of field
 *  10  bloom: prefilter -> 6 mip downsample -> tent upsample
 *  11  final: CA, sharpen, bloom, exposure, AgX, grade, vignette, grain -> canvas
 *
 * This class owns tonemapping outright — see the constructor.
 */
export class RenderPipeline {
  /** @param {{renderer:THREE.WebGLRenderer, scene:THREE.Scene, camera:THREE.Camera, width:number, height:number}} engine */
  constructor(engine) {
    this.engine = engine;
    this.renderer = engine.renderer;
    this.scene = engine.scene;
    this.camera = engine.camera;

    // The composite pass does exposure -> AgX -> grade itself. Leaving the
    // renderer's tonemapper on would tonemap the scene *into* the HDR buffer,
    // clipping everything bloom and SSR need. The pipeline owns tonemapping.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 1);

    const ext = this.renderer.extensions;
    this._floatRT = !!(ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));
    this._hdrType = this._floatRT ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this.params = {
      maxPixelRatio: 1.5,     // internal buffers are independent of the canvas
      renderScale: 1.0,
      // Scene radiance went up ~3x when the key took over from the ambient, so
      // the exposure comes down to keep sunlit concrete around 0.6 display and
      // leave headroom for emissives to punch through the tonemap.
      exposure: 0.645,
      sharpen: 0.30,
      tonemap: 'agx',         // 'agx' | 'aces'

      // Threshold sits just above the brightest lit-metal highlight, so only
      // emissives, the sun and specular glints bloom.
      //
      // `clamp` is the important one and it used to be 90. The sun disc renders
      // at ~120 linear over a ~30 px blob; at clamp 90 that blob entered the mip
      // chain essentially intact, saturated every mip it touched, and came out
      // the far side as a flat white sheet — a smear, not a flare. Clamping the
      // PREFILTERED value to 10 costs the core nothing (the core is the
      // untouched scene pixel, still 120, still pure white after the tonemap)
      // and hands the falloff back to the mip chain, which is the only part of
      // this that can produce structure.
      //
      // `mipTaper` compounds down the upsample chain, so mip k reaches the frame
      // at taper^k. Equal weights make every blur radius equally bright, which
      // is exactly the uniform veiling glow REVIEW calls an automatic failure;
      // a geometric taper is the tight-hot-core / wide-soft-skirt shape.
      bloom: { threshold: 1.25, knee: 0.60, strength: 1.00, radius: 1.05, clamp: 6, mipTaper: 0.80 },
      // Radius up from 1.1 m: the subject is a 9 m mech on open sand, and a 1 m
      // kernel only ever found the geometry's own creases, never the gap between
      // a foot and the ground.
      ssao: { radius: 1.55, strength: 1.0, bias: 0.03, power: 2.0 },
      ssr: { intensity: 0.85, maxDistance: 48, thickness: 1.2, roughness: 0.30, upBoost: 1.1 },
      motionBlur: { shutter: 0.6, maxPx: 24 },
      // Far-field DOF was the single biggest contributor to "distant geometry
      // dissolves into mush": at farScale 0.45 with a 70 m rest focus, every
      // ridge and gantry past the midground was blurred by up to 6.5 px BEFORE
      // the haze touched it. AC6's depth cue is aerial perspective, not defocus.
      dof: { restFocus: 90, farScale: 0.10, nearScale: 0.10, maxRadius: 3.2, hex: 0.75 },
      taa: { blend: 0.925, clampGamma: 1.15, jitterScale: 1.0 },
      chromatic: { amount: 0.85 },
      vignette: { amount: 0.34, smoothness: 0.42 },
      grain: { amount: 0.030 },
      scanline: { amount: 0.010, count: 900 },
      atmosphere: { strength: 1.0 },

      // AgX with a steeper slope and a de-saturating look: AC6's palette is
      // steel/ochre with saturation only in emissives, and its highlights roll
      // off rather than clip. Shadows get a small cool lift so they stay open.
      grade: {
        // slope / offset / power / saturation, applied in the sigmoid's OUTPUT
        // space — so `slope` is a hard clip point: everything above 1/slope
        // becomes pure white. At 1.22 that was 0.82, which turned a long
        // specular rail into a flat white lens with no roll-off at all. 1.13
        // buys back a stop and a half of highlight shoulder; the mid-tone punch
        // it costs comes back from `contrast`, which pivots at 0.5 and does not
        // touch the clip point.
        //
        // `power` is the shadow-targeted knob in this vec4 and the one that
        // decides whether the mech's unlit flank is readable. Because it is a
        // pow() on a [0,1] display value it moves the toe hard and the shoulder
        // barely at all: dropping it from 1.14 to 0.98 raises a 0.07 shadow by
        // 44% and a 0.80 highlight by 3.6%. Contrast and exposure cannot do
        // that — they move the whole curve.
        agxLook: new THREE.Vector4(1.13, 0.0, 0.98, 0.88),
        // The frame's black point, applied last in the grade (see FINAL_FRAG).
        // AC6's shadows are deep but you can always read what is in them; a
        // crushed-to-black shadow is the giveaway of a hobby renderer.
        // Blue-weighted so the darkest part of the frame is also its coolest.
        lift: new THREE.Vector3(0.020, 0.026, 0.042),
        gamma: new THREE.Vector3(1.0, 1.0, 1.0),
        gain: new THREE.Vector3(1.035, 1.0, 0.950),
        // Reads as before (1.0 = neutral) but drives an S-curve now, so it can
        // be pushed for real tonal range in the sand without clipping the toe.
        contrast: 1.20,
        saturation: 0.94,
        splitShadow: new THREE.Vector3(-0.026, -0.006, 0.044),
        splitHighlight: new THREE.Vector3(0.032, 0.012, -0.024),
        splitBalance: 0.42,
      },
    };

    /** Per-quality pass switches, driven by setQuality(). */
    this.q = {
      taa: true, ssao: true, ssr: false, motionBlur: true, dof: true,
      bloomMips: MAX_BLOOM_MIPS, aoSamples: 12, ssrSteps: 24, ssrRefine: 5,
      mbSamples: 5, dofTaps: 19, aoScale: 0.5, ssrScale: 0.5,
    };

    // ---- dynamic state driven by syncFromGame / the event bus -------------
    this._dyn = {
      crit: 0, critT: 0,
      speed: 0, speedT: 0,
      hit: 0, scan: 0,
      focus: this.params.dof.restFocus, focusT: this.params.dof.restFocus,
      exposureBias: 1,
    };

    this._frame = 0;
    this._elapsed = 0;
    this._histIdx = 0;
    this._taaReset = 1;
    this._hasPrev = false;
    this._quality = 'high';

    // ---- scratch (zero per-frame allocation) ------------------------------
    this._viewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._invProj = new THREE.Matrix4();
    this._viewToWorld = new THREE.Matrix3();
    this._prevCamPos = new THREE.Vector3(1e9, 1e9, 1e9);
    this._camPos = new THREE.Vector3();
    this._sunDir = new THREE.Vector3(0.4, 0.35, 0.6).normalize();
    this._fogColor = new THREE.Color(0.26, 0.23, 0.19);
    this._fogSunColor = new THREE.Color(0.72, 0.37, 0.16);
    this._deckColor = new THREE.Color(0.33, 0.27, 0.21);
    this._bandColor = new THREE.Color(0.40, 0.32, 0.24);
    this._aerialColor = new THREE.Color(0.16, 0.17, 0.19);
    this._fogDensity = 0.0042;
    this._fogHeight = 2;
    this._fogFalloff = 0.060;
    this._bandDensity = 0.0028;
    this._bandHeight = 55;
    this._bandThickness = 16;
    this._aerialDensity = 0.0012;
    this._aerialRamp = 250;
    this._damageColor = new THREE.Color(0.85, 0.06, 0.05);

    this._jitter = new Float32Array(JITTER_COUNT * 2);
    for (let i = 0; i < JITTER_COUNT; i++) {
      this._jitter[i * 2] = halton(i + 1, 2) - 0.5;
      this._jitter[i * 2 + 1] = halton(i + 1, 3) - 0.5;
    }

    this._noise = getForge(this.renderer).blueNoise(NOISE_SIZE);

    this._bw = 2;
    this._bh = 2;
    this._targets = [];
    this._aoSize = [2, 2];
    this._ssrSize = [2, 2];
    this.bloomMips = [];
    this._bloomSizes = [];

    this._buildQuad();
    this._buildMaterials();

    this.setSize(engine.width || 1, engine.height || 1, engine.pixelRatio || 1);

    this._wireEvents();

    // The lighting rig has no camera of its own; hand ours over on request.
    this._offNeedCam = bus.on('render:needCamera', () => bus.emit('render:camera', this.camera));
    bus.emit('render:camera', this.camera);
  }

  // =========================================================================
  // construction
  // =========================================================================

  _buildQuad() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this._quadGeo = geo;

    this._quad = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    this._quad.frustumCulled = false;
    this._quad.matrixAutoUpdate = false;
    this._placeholderMat = this._quad.material;

    this._quadScene = new THREE.Scene();
    this._quadScene.matrixWorldAutoUpdate = false;
    this._quadScene.add(this._quad);

    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  _pass(fragmentShader, uniforms, defines) {
    return new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      uniforms,
      defines: defines || {},
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
      fog: false,
    });
  }

  _buildMaterials() {
    const p = this.params;
    const noise = this._noise;

    this.mVelocity = this._pass(VELOCITY_FRAG, {
      tDepth: { value: null },
      uInvViewProj: { value: this._invViewProj },
      uPrevViewProj: { value: this._prevViewProj },
    });

    this.mAO = this._pass(AO_FRAG, {
      tDepth: { value: null },
      tNoise: { value: noise },
      uKernel: { value: [] },
      uProj: { value: new THREE.Matrix4() },
      uInvProj: { value: this._invProj },
      uDepthTexel: { value: new THREE.Vector2() },
      uNoiseScale: { value: new THREE.Vector2() },
      uRadius: { value: p.ssao.radius },
      uStrength: { value: p.ssao.strength },
      uBias: { value: p.ssao.bias },
      uPower: { value: p.ssao.power },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uFrame: { value: 0 },
    }, { AO_SAMPLES: this.q.aoSamples });

    const blurUniforms = () => ({
      tAO: { value: null },
      uDirection: { value: new THREE.Vector2() },
      uDepthSigma: { value: 1.2 },
    });
    this.mAOBlurX = this._pass(AO_BLUR_FRAG, blurUniforms());
    this.mAOBlurY = this._pass(AO_BLUR_FRAG, blurUniforms());

    this.mSSR = this._pass(SSR_FRAG, {
      tColor: { value: null },
      tDepth: { value: null },
      tNoise: { value: noise },
      uProj: { value: new THREE.Matrix4() },
      uInvProj: { value: this._invProj },
      uViewToWorld: { value: this._viewToWorld },
      uDepthTexel: { value: new THREE.Vector2() },
      uNoiseScale: { value: new THREE.Vector2() },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uMaxDistance: { value: p.ssr.maxDistance },
      uThickness: { value: p.ssr.thickness },
      uRoughness: { value: p.ssr.roughness },
      uUpBoost: { value: p.ssr.upBoost },
      uFrame: { value: 0 },
    }, { SSR_STEPS: this.q.ssrSteps, SSR_REFINE: this.q.ssrRefine });

    this.mComposite = this._pass(COMPOSITE_FRAG, {
      tScene: { value: null },
      tDepth: { value: null },
      tAO: { value: null },
      tSSR: { value: null },
      uInvViewProj: { value: this._invViewProj },
      uCameraPos: { value: this._camPos },
      uSunDir: { value: this._sunDir },
      uFogColor: { value: this._fogColor },
      uFogSunColor: { value: this._fogSunColor },
      uDeckColor: { value: this._deckColor },
      uBandColor: { value: this._bandColor },
      uAerialColor: { value: this._aerialColor },
      uFogDensity: { value: this._fogDensity },
      uFogHeight: { value: this._fogHeight },
      uFogFalloff: { value: this._fogFalloff },
      uBandDensity: { value: this._bandDensity },
      uBandHeight: { value: this._bandHeight },
      uBandThickness: { value: this._bandThickness },
      uAerialDensity: { value: this._aerialDensity },
      uAerialRamp: { value: this._aerialRamp },
      uFogStrength: { value: p.atmosphere.strength },
      uAOEnabled: { value: 1 },
      uSSREnabled: { value: 0 },
      uSSRIntensity: { value: p.ssr.intensity },
    });

    this.mTAA = this._pass(TAA_FRAG, {
      tCurrent: { value: null },
      tHistory: { value: null },
      tVelocity: { value: null },
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uBlend: { value: p.taa.blend },
      uClampGamma: { value: p.taa.clampGamma },
      uReset: { value: 1 },
    });

    this.mTileA = this._pass(TILEMAX_FRAG, {
      tVelocity: { value: null },
      uSourceTexel: { value: new THREE.Vector2() },
    });
    this.mTileB = this._pass(TILEMAX_FRAG, {
      tVelocity: { value: null },
      uSourceTexel: { value: new THREE.Vector2() },
    });
    this.mNeighborMax = this._pass(NEIGHBORMAX_FRAG, {
      tVelocity: { value: null },
      uSourceTexel: { value: new THREE.Vector2() },
    });

    this.mMotion = this._pass(MOTION_BLUR_FRAG, {
      tColor: { value: null },
      tVelocity: { value: null },
      tNeighborMax: { value: null },
      tDepth: { value: null },
      tNoise: { value: noise },
      uTexel: { value: new THREE.Vector2() },
      uNoiseScale: { value: new THREE.Vector2() },
      uRadialCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uShutter: { value: p.motionBlur.shutter },
      uMaxPx: { value: p.motionBlur.maxPx },
      uRadial: { value: 0 },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uFrame: { value: 0 },
    }, { MB_SAMPLES: this.q.mbSamples });

    this.mDOF = this._pass(DOF_FRAG, {
      tColor: { value: null },
      tDepth: { value: null },
      tNoise: { value: noise },
      uTexel: { value: new THREE.Vector2() },
      uNoiseScale: { value: new THREE.Vector2() },
      uFocus: { value: p.dof.restFocus },
      uFarScale: { value: p.dof.farScale },
      uNearScale: { value: p.dof.nearScale },
      uMaxRadius: { value: p.dof.maxRadius },
      uHex: { value: p.dof.hex },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uFrame: { value: 0 },
    }, { DOF_TAPS: this.q.dofTaps });

    this.mBloomPre = this._pass(BLOOM_PREFILTER_FRAG, {
      tSource: { value: null },
      uSourceTexel: { value: new THREE.Vector2() },
      uThreshold: { value: p.bloom.threshold },
      uKnee: { value: p.bloom.knee },
      uClamp: { value: p.bloom.clamp },
    });

    this.mBloomDown = [];
    this.mBloomUp = [];
    for (let i = 0; i < MAX_BLOOM_MIPS; i++) {
      this.mBloomDown.push(this._pass(BLOOM_DOWN_FRAG, {
        tSource: { value: null },
        uSourceTexel: { value: new THREE.Vector2() },
      }));
      const up = this._pass(BLOOM_UP_FRAG, {
        tSource: { value: null },
        uSourceTexel: { value: new THREE.Vector2() },
        uRadius: { value: p.bloom.radius },
        uWeight: { value: 1.0 },
      });
      up.blending = THREE.AdditiveBlending;
      this.mBloomUp.push(up);
    }

    const g = p.grade;
    this.mFinal = this._pass(FINAL_FRAG, {
      tColor: { value: null },
      tBloom: { value: null },
      tNoise: { value: noise },
      uTexel: { value: new THREE.Vector2() },
      uNoiseScale: { value: new THREE.Vector2() },
      uTime: { value: 0 },
      uExposure: { value: p.exposure },
      uBloomStrength: { value: p.bloom.strength },
      uChromatic: { value: p.chromatic.amount },
      uSharpen: { value: p.sharpen },
      uTonemapMode: { value: 0 },
      uAgxLook: { value: g.agxLook },
      uLift: { value: g.lift },
      uGamma: { value: g.gamma },
      uGain: { value: g.gain },
      uContrast: { value: g.contrast },
      uSaturation: { value: g.saturation },
      uSplitShadow: { value: g.splitShadow },
      uSplitHighlight: { value: g.splitHighlight },
      uSplitBalance: { value: g.splitBalance },
      uVignette: { value: p.vignette.amount },
      uVignetteSmooth: { value: p.vignette.smoothness },
      uDamage: { value: 0 },
      uDamageColor: { value: this._damageColor },
      uGrain: { value: p.grain.amount },
      uScanline: { value: p.scanline.amount },
      uScanCount: { value: p.scanline.count },
    });

    this._rebuildAOKernel();
    this.setQuality('high');
  }

  _rebuildAOKernel() {
    const n = this.q.aoSamples;
    const rng = mulberry32(0x5eed01);
    const arr = [];
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 0.92 + 0.08);
      v.normalize();
      // Bias samples toward the origin: contact occlusion is what we want, not
      // a uniform sphere sample that mostly reports "nothing there".
      const t = (i + 0.5) / n;
      v.multiplyScalar(0.22 + 0.78 * t * t);
      arr.push(v);
    }
    this.mAO.uniforms.uKernel.value = arr;
    this.mAO.defines.AO_SAMPLES = n;
    this.mAO.needsUpdate = true;
  }

  _wireEvents() {
    this._offs = [];
    this._offs.push(bus.on('sky:params', (s) => {
      if (!s) return;
      if (s.sunDirection) this._sunDir.copy(s.sunDirection);
      if (s.fogColor) this._fogColor.copy(s.fogColor);
      if (s.fogSunColor) this._fogSunColor.copy(s.fogSunColor);
      if (s.deckColor) this._deckColor.copy(s.deckColor);
      if (s.bandColor) this._bandColor.copy(s.bandColor);
      if (s.aerialColor) this._aerialColor.copy(s.aerialColor);
      if (typeof s.fogDensity === 'number') this._fogDensity = s.fogDensity;
      if (typeof s.fogHeight === 'number') this._fogHeight = s.fogHeight;
      if (typeof s.fogFalloff === 'number') this._fogFalloff = s.fogFalloff;
      if (typeof s.bandDensity === 'number') this._bandDensity = s.bandDensity;
      if (typeof s.bandHeight === 'number') this._bandHeight = s.bandHeight;
      if (typeof s.bandThickness === 'number') this._bandThickness = s.bandThickness;
      if (typeof s.aerialDensity === 'number') this._aerialDensity = s.aerialDensity;
      if (typeof s.aerialRamp === 'number') this._aerialRamp = s.aerialRamp;
    }));
    this._offs.push(bus.on(EV.PLAYER_HIT, () => {
      this._dyn.hit = Math.min(1.2, this._dyn.hit + 0.6);
      this._dyn.scan = Math.min(1, this._dyn.scan + 0.5);
    }));
    this._offs.push(bus.on(EV.STAGGER, (e) => {
      if (e && e.entity && e.entity.isPlayer) this._dyn.scan = 1;
    }));
    this._offs.push(bus.on(EV.QUICK_BOOST, () => {
      this._dyn.hit = Math.min(1.2, this._dyn.hit + 0.16);
    }));
    this._offs.push(bus.on(EV.GAME_OVER, () => { this._dyn.critT = 1; }));
  }

  // =========================================================================
  // sizing
  // =========================================================================

  _makeRT(w, h, opts) {
    const o = opts || {};
    const filter = o.filter || THREE.LinearFilter;
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      type: o.type || this._hdrType,
      format: o.format || THREE.RGBAFormat,
      minFilter: filter,
      magFilter: filter,
      depthBuffer: !!o.depth,
      stencilBuffer: false,
      generateMipmaps: false,
      depthTexture: o.depthTexture || null,
    });
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    rt.texture.name = o.name || 'acntr.rt';
    this._targets.push(rt);
    return rt;
  }

  _disposeTargets() {
    for (let i = 0; i < this._targets.length; i++) this._targets[i].dispose();
    this._targets.length = 0;
    this._depthTexture?.dispose();
    this._depthTexture = null;
  }

  /**
   * @param {number} w css pixels
   * @param {number} h css pixels
   * @param {number} pixelRatio device pixel ratio the canvas is using
   */
  setSize(w, h, pixelRatio) {
    const p = this.params;
    const scale = clamp((pixelRatio || 1), 0.4, p.maxPixelRatio) * p.renderScale;
    const bw = Math.max(4, Math.round(w * scale));
    const bh = Math.max(4, Math.round(h * scale));
    if (bw === this._bw && bh === this._bh && this._targets.length) return;

    this._bw = bw;
    this._bh = bh;
    this._allocate();
    this.resetHistory();
  }

  _allocate() {
    this._disposeTargets();

    const bw = this._bw;
    const bh = this._bh;
    const q = this.q;

    const depthTex = new THREE.DepthTexture(bw, bh, THREE.UnsignedIntType);
    depthTex.format = THREE.DepthFormat;
    depthTex.minFilter = THREE.NearestFilter;
    depthTex.magFilter = THREE.NearestFilter;
    depthTex.generateMipmaps = false;
    this._depthTexture = depthTex;

    this.rtScene = this._makeRT(bw, bh, { depth: true, depthTexture: depthTex, name: 'scene' });
    this.rtA = this._makeRT(bw, bh, { name: 'postA' });
    this.rtB = this._makeRT(bw, bh, { name: 'postB' });
    this.rtHist = [
      this._makeRT(bw, bh, { name: 'hist0' }),
      this._makeRT(bw, bh, { name: 'hist1' }),
    ];

    const vecType = this._floatRT ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.rtVelocity = this._makeRT(bw, bh, {
      type: vecType, format: this._floatRT ? THREE.RGFormat : THREE.RGBAFormat,
      filter: THREE.NearestFilter, name: 'velocity',
    });

    const t1w = Math.max(1, Math.ceil(bw / 4));
    const t1h = Math.max(1, Math.ceil(bh / 4));
    const t2w = Math.max(1, Math.ceil(t1w / 4));
    const t2h = Math.max(1, Math.ceil(t1h / 4));
    const tileOpts = {
      type: vecType, format: this._floatRT ? THREE.RGFormat : THREE.RGBAFormat,
      filter: THREE.NearestFilter,
    };
    this.rtTileA = this._makeRT(t1w, t1h, { ...tileOpts, name: 'tileA' });
    this.rtTileB = this._makeRT(t2w, t2h, { ...tileOpts, name: 'tileB' });
    this.rtNeighbor = this._makeRT(t2w, t2h, { ...tileOpts, name: 'neighbor' });

    const aw = Math.max(1, Math.round(bw * q.aoScale));
    const ah = Math.max(1, Math.round(bh * q.aoScale));
    const aoOpts = { type: vecType, format: this._floatRT ? THREE.RGFormat : THREE.RGBAFormat };
    this.rtAO = [
      this._makeRT(aw, ah, { ...aoOpts, name: 'ao0' }),
      this._makeRT(aw, ah, { ...aoOpts, name: 'ao1' }),
    ];
    this._aoSize = [aw, ah];

    const sw = Math.max(1, Math.round(bw * q.ssrScale));
    const sh = Math.max(1, Math.round(bh * q.ssrScale));
    this.rtSSR = this._makeRT(sw, sh, { name: 'ssr' });
    this._ssrSize = [sw, sh];

    this.bloomMips = [];
    this._bloomSizes = [];
    let mw = bw;
    let mh = bh;
    for (let i = 0; i < q.bloomMips; i++) {
      mw = Math.max(1, Math.floor(mw / 2));
      mh = Math.max(1, Math.floor(mh / 2));
      this.bloomMips.push(this._makeRT(mw, mh, { name: `bloom${i}` }));
      this._bloomSizes.push([mw, mh]);
      if (mw <= 2 || mh <= 2) break;
    }

    this._updateSizeUniforms();
  }

  _updateSizeUniforms() {
    const bw = this._bw;
    const bh = this._bh;
    const texel = 1 / NOISE_SIZE;

    this.mAO.uniforms.uDepthTexel.value.set(1 / bw, 1 / bh);
    this.mAO.uniforms.uNoiseScale.value.set(this._aoSize[0] * texel, this._aoSize[1] * texel);
    this.mAOBlurX.uniforms.uDirection.value.set(1 / this._aoSize[0], 0);
    this.mAOBlurY.uniforms.uDirection.value.set(0, 1 / this._aoSize[1]);

    this.mSSR.uniforms.uDepthTexel.value.set(1 / bw, 1 / bh);
    this.mSSR.uniforms.uNoiseScale.value.set(this._ssrSize[0] * texel, this._ssrSize[1] * texel);

    this.mTAA.uniforms.uTexel.value.set(1 / bw, 1 / bh);

    this.mTileA.uniforms.uSourceTexel.value.set(1 / bw, 1 / bh);
    this.mTileB.uniforms.uSourceTexel.value.set(1 / this.rtTileA.width, 1 / this.rtTileA.height);
    this.mNeighborMax.uniforms.uSourceTexel.value.set(1 / this.rtTileB.width, 1 / this.rtTileB.height);

    this.mMotion.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    this.mMotion.uniforms.uNoiseScale.value.set(bw * texel, bh * texel);

    this.mDOF.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    this.mDOF.uniforms.uNoiseScale.value.set(bw * texel, bh * texel);

    this.mBloomPre.uniforms.uSourceTexel.value.set(1 / bw, 1 / bh);
    for (let i = 1; i < this.bloomMips.length; i++) {
      const s = this._bloomSizes[i - 1];
      this.mBloomDown[i].uniforms.uSourceTexel.value.set(1 / s[0], 1 / s[1]);
    }
    for (let i = 1; i < this.bloomMips.length; i++) {
      const s = this._bloomSizes[i];
      this.mBloomUp[i].uniforms.uSourceTexel.value.set(1 / s[0], 1 / s[1]);
    }

    this.mFinal.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    this.mFinal.uniforms.uNoiseScale.value.set(bw * texel, bh * texel);
  }

  // =========================================================================
  // quality
  // =========================================================================

  /** @param {'low'|'med'|'high'|'ultra'} level */
  setQuality(level) {
    const q = this.q;
    const prevMips = q.bloomMips;
    const prevAO = q.aoSamples;
    const prevScale = q.aoScale;

    switch (level) {
      case 'low':
        q.taa = true; q.ssao = false; q.ssr = false; q.motionBlur = false; q.dof = false;
        q.bloomMips = 4; q.aoSamples = 8; q.mbSamples = 4; q.dofTaps = 13;
        q.aoScale = 0.5; q.ssrScale = 0.5; q.ssrSteps = 16; q.ssrRefine = 4;
        break;
      case 'med':
        q.taa = true; q.ssao = true; q.ssr = false; q.motionBlur = true; q.dof = false;
        q.bloomMips = 5; q.aoSamples = 8; q.mbSamples = 4; q.dofTaps = 13;
        q.aoScale = 0.5; q.ssrScale = 0.5; q.ssrSteps = 18; q.ssrRefine = 4;
        break;
      case 'ultra':
        q.taa = true; q.ssao = true; q.ssr = true; q.motionBlur = true; q.dof = true;
        q.bloomMips = 6; q.aoSamples = 16; q.mbSamples = 6; q.dofTaps = 25;
        q.aoScale = 0.5; q.ssrScale = 0.5; q.ssrSteps = 28; q.ssrRefine = 6;
        break;
      case 'high':
      default:
        level = 'high';
        // SSR stays off at 'high': it is the one pass that can still shimmer on
        // very rough geometry, so it is opt-in via 'ultra'.
        q.taa = true; q.ssao = true; q.ssr = false; q.motionBlur = true; q.dof = true;
        q.bloomMips = 6; q.aoSamples = 12; q.mbSamples = 5; q.dofTaps = 19;
        q.aoScale = 0.5; q.ssrScale = 0.5; q.ssrSteps = 24; q.ssrRefine = 5;
        break;
    }

    if (!this._floatRT) {
      // No renderable float targets: temporal passes have nowhere to store
      // velocity and HDR, so fall back to bloom + tonemap only.
      q.taa = false; q.ssao = false; q.ssr = false; q.motionBlur = false; q.dof = false;
    }

    this._quality = level;

    if (q.aoSamples !== prevAO) this._rebuildAOKernel();
    this.mSSR.defines.SSR_STEPS = q.ssrSteps;
    this.mSSR.defines.SSR_REFINE = q.ssrRefine;
    this.mSSR.needsUpdate = true;
    this.mMotion.defines.MB_SAMPLES = q.mbSamples;
    this.mMotion.needsUpdate = true;
    this.mDOF.defines.DOF_TAPS = q.dofTaps;
    this.mDOF.needsUpdate = true;

    if (this._targets.length && (q.bloomMips !== prevMips || q.aoScale !== prevScale)) {
      this._allocate();
      this.resetHistory();
    }

    bus.emit('render:quality', level);
  }

  /**
   * The scene depth buffer, for anything that needs to fade against geometry
   * (soft particles). Recreated on every resize, so re-read it on
   * `engine:resize` rather than caching it once.
   * @type {THREE.DepthTexture|null}
   */
  get depthTexture() {
    return this._depthTexture;
  }

  /** Drop the TAA history — call on camera cuts, teleports, respawns. */
  resetHistory() {
    this._taaReset = 1;
    this._hasPrev = false;
  }

  // =========================================================================
  // game coupling
  // =========================================================================

  /**
   * Read whatever gameplay state exists and turn it into look. Every access is
   * optional-chained because the systems this reads from boot asynchronously
   * and may simply not be there yet.
   *
   * @param {object} game
   * @param {number} dt
   */
  syncFromGame(game, dt) {
    const d = this._dyn;

    const stats = game?.player?.stats;
    const apMax = stats?.apMax || 1;
    const ap = typeof stats?.ap === 'number' ? stats.ap : apMax;
    const health = clamp(ap / apMax, 0, 1);
    d.critT = 1 - smoothstep(0.14, 0.45, health);

    const cs = game?.controller?.state;
    const speed = cs?.speed || 0;
    const assault = cs?.assaultBoost ? 1 : 0;
    const boosting = cs?.boosting ? 1 : 0;
    const speedNorm = clamp((speed - 55) / 170, 0, 1);
    d.speedT = assault ? speedNorm : speedNorm * 0.30 * boosting;

    const target = game?.targeting?.target;
    const tp = target?.root?.position;
    if (tp && this.camera?.position) {
      d.focusT = clamp(this.camera.position.distanceTo(tp), 8, 500);
    } else {
      d.focusT = this.params.dof.restFocus;
    }

    if (game?.state === 'dead') d.critT = 1;
  }

  _updateDynamics(dt) {
    const d = this._dyn;
    const p = this.params;
    const step = Math.min(dt || 0.016, 0.1);

    d.crit = damp(d.crit, d.critT, 5, step);
    d.speed = damp(d.speed, d.speedT, 6, step);
    d.focus = damp(d.focus, d.focusT, 3.2, step);
    d.hit = Math.max(0, d.hit - step * 2.6);
    d.scan = Math.max(0, d.scan - step * 1.8);

    const t = this._elapsed;
    // Low-AP flicker: two detuned oscillators so it reads as a failing power
    // bus rather than a sine wave.
    const flicker = d.crit * (Math.sin(t * 37.0) * 0.5 + Math.sin(t * 11.3) * 0.5) * 0.055;
    const hitFlash = d.hit * 0.22;

    const f = this.mFinal.uniforms;
    f.uExposure.value = p.exposure * (1 + flicker + hitFlash);
    f.uChromatic.value = p.chromatic.amount + d.crit * 3.4 + d.hit * 5.0 + d.speed * 1.8;
    f.uVignette.value = p.vignette.amount + d.crit * 0.10;
    f.uDamage.value = clamp(d.crit * 0.55 + d.hit * 0.65, 0, 1);
    f.uGrain.value = p.grain.amount * (1 + d.crit * 1.4);
    f.uScanline.value = p.scanline.amount + d.scan * 0.10 + d.crit * 0.02;
    f.uScanCount.value = p.scanline.count;
    f.uSharpen.value = p.sharpen;
    f.uBloomStrength.value = p.bloom.strength;
    f.uTonemapMode.value = p.tonemap === 'aces' ? 1 : 0;
    f.uTime.value = t;
    f.uContrast.value = p.grade.contrast;
    f.uSaturation.value = p.grade.saturation;
    f.uSplitBalance.value = p.grade.splitBalance;
    f.uVignetteSmooth.value = p.vignette.smoothness;

    // Assault boost draws the frame outward from the reticle.
    this.mMotion.uniforms.uRadial.value = d.speed * 0.055;
    this.mMotion.uniforms.uShutter.value = p.motionBlur.shutter;
    this.mMotion.uniforms.uMaxPx.value = p.motionBlur.maxPx;

    this.mDOF.uniforms.uFocus.value = d.focus;
    this.mDOF.uniforms.uFarScale.value = p.dof.farScale;
    this.mDOF.uniforms.uNearScale.value = p.dof.nearScale;
    this.mDOF.uniforms.uMaxRadius.value = p.dof.maxRadius;
    this.mDOF.uniforms.uHex.value = p.dof.hex;

    this.mAO.uniforms.uRadius.value = p.ssao.radius;
    this.mAO.uniforms.uStrength.value = p.ssao.strength;
    this.mAO.uniforms.uBias.value = p.ssao.bias;
    this.mAO.uniforms.uPower.value = p.ssao.power;

    this.mSSR.uniforms.uMaxDistance.value = p.ssr.maxDistance;
    this.mSSR.uniforms.uThickness.value = p.ssr.thickness;
    this.mSSR.uniforms.uRoughness.value = p.ssr.roughness;
    this.mSSR.uniforms.uUpBoost.value = p.ssr.upBoost;

    this.mBloomPre.uniforms.uThreshold.value = p.bloom.threshold;
    this.mBloomPre.uniforms.uKnee.value = p.bloom.knee;
    this.mBloomPre.uniforms.uClamp.value = p.bloom.clamp;

    this.mTAA.uniforms.uBlend.value = p.taa.blend;
    this.mTAA.uniforms.uClampGamma.value = p.taa.clampGamma;

    const c = this.mComposite.uniforms;
    c.uFogDensity.value = this._fogDensity;
    c.uFogHeight.value = this._fogHeight;
    c.uFogFalloff.value = this._fogFalloff;
    c.uBandDensity.value = this._bandDensity;
    c.uBandHeight.value = this._bandHeight;
    c.uBandThickness.value = this._bandThickness;
    c.uAerialDensity.value = this._aerialDensity;
    c.uAerialRamp.value = this._aerialRamp;
    c.uFogStrength.value = p.atmosphere.strength;
    c.uSSRIntensity.value = p.ssr.intensity;
  }

  // =========================================================================
  // frame
  // =========================================================================

  _blit(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._quadScene, this._quadCam);
  }

  /**
   * @param {number} dt
   * @param {number} elapsed
   */
  render(dt, elapsed) {
    const r = this.renderer;
    const cam = this.camera;
    const q = this.q;
    this._elapsed = elapsed;
    this._frame++;

    // Every lit material must carry the CSM defines before it is first drawn.
    syncSceneMaterials(this.scene);

    this._updateDynamics(dt);

    // Camera cut / teleport detection — a reprojected history across a cut is
    // pure smear.
    this._camPos.copy(cam.position);
    if (this._prevCamPos.distanceToSquared(this._camPos) > 900) this.resetHistory();
    this._prevCamPos.copy(this._camPos);

    const near = cam.near || 0.1;
    const far = cam.far || 1000;

    // ---- 1. scene, with the TAA jitter on the projection ------------------
    const e = cam.projectionMatrix.elements;
    const save8 = e[8];
    const save9 = e[9];
    if (q.taa) {
      const i = this._frame % JITTER_COUNT;
      const s = this.params.taa.jitterScale;
      e[8] = save8 + (this._jitter[i * 2] * 2 * s) / this._bw;
      e[9] = save9 + (this._jitter[i * 2 + 1] * 2 * s) / this._bh;
    }

    r.setRenderTarget(this.rtScene);
    r.render(this.scene, cam);

    e[8] = save8;
    e[9] = save9;

    // ---- matrices (un-jittered: post reconstructs geometry, not samples) --
    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._invViewProj.copy(this._viewProj).invert();
    this._invProj.copy(cam.projectionMatrix).invert();
    this._viewToWorld.setFromMatrix4(cam.matrixWorld);
    if (!this._hasPrev) {
      this._prevViewProj.copy(this._viewProj);
      this._hasPrev = true;
    }

    const depthTex = this.rtScene.depthTexture;
    const needsVelocity = q.taa || q.motionBlur;

    // ---- 2. velocity ------------------------------------------------------
    if (needsVelocity) {
      this.mVelocity.uniforms.tDepth.value = depthTex;
      this._blit(this.mVelocity, this.rtVelocity);
    }

    // ---- 3. velocity tiles ------------------------------------------------
    if (q.motionBlur) {
      this.mTileA.uniforms.tVelocity.value = this.rtVelocity.texture;
      this._blit(this.mTileA, this.rtTileA);
      this.mTileB.uniforms.tVelocity.value = this.rtTileA.texture;
      this._blit(this.mTileB, this.rtTileB);
      this.mNeighborMax.uniforms.tVelocity.value = this.rtTileB.texture;
      this._blit(this.mNeighborMax, this.rtNeighbor);
    }

    // ---- 4. SSAO ----------------------------------------------------------
    if (q.ssao) {
      const u = this.mAO.uniforms;
      u.tDepth.value = depthTex;
      u.uProj.value.copy(cam.projectionMatrix);
      u.uNear.value = near;
      u.uFar.value = far;
      u.uFrame.value = this._frame;
      this._blit(this.mAO, this.rtAO[0]);

      this.mAOBlurX.uniforms.tAO.value = this.rtAO[0].texture;
      this._blit(this.mAOBlurX, this.rtAO[1]);
      this.mAOBlurY.uniforms.tAO.value = this.rtAO[1].texture;
      this._blit(this.mAOBlurY, this.rtAO[0]);
    }

    // ---- 5. SSR -----------------------------------------------------------
    if (q.ssr) {
      const u = this.mSSR.uniforms;
      u.tColor.value = this.rtScene.texture;
      u.tDepth.value = depthTex;
      u.uProj.value.copy(cam.projectionMatrix);
      u.uNear.value = near;
      u.uFar.value = far;
      u.uFrame.value = this._frame;
      this._blit(this.mSSR, this.rtSSR);
    }

    // ---- 6. composite -----------------------------------------------------
    {
      const u = this.mComposite.uniforms;
      u.tScene.value = this.rtScene.texture;
      u.tDepth.value = depthTex;
      u.tAO.value = this.rtAO[0].texture;
      u.tSSR.value = this.rtSSR.texture;
      u.uAOEnabled.value = q.ssao ? 1 : 0;
      u.uSSREnabled.value = q.ssr ? 1 : 0;
      this._blit(this.mComposite, this.rtA);
    }

    let src = this.rtA;

    // ---- 7. TAA -----------------------------------------------------------
    if (q.taa) {
      const cur = this.rtHist[this._histIdx];
      const prev = this.rtHist[1 - this._histIdx];
      const u = this.mTAA.uniforms;
      u.tCurrent.value = src.texture;
      u.tHistory.value = prev.texture;
      u.tVelocity.value = this.rtVelocity.texture;
      u.tDepth.value = depthTex;
      u.uReset.value = this._taaReset;
      this._blit(this.mTAA, cur);
      this._taaReset = 0;
      this._histIdx = 1 - this._histIdx;
      src = cur;
    }

    // ---- 8. motion blur ---------------------------------------------------
    if (q.motionBlur) {
      const dst = src === this.rtA ? this.rtB : this.rtA;
      const u = this.mMotion.uniforms;
      u.tColor.value = src.texture;
      u.tVelocity.value = this.rtVelocity.texture;
      u.tNeighborMax.value = this.rtNeighbor.texture;
      u.tDepth.value = depthTex;
      u.uNear.value = near;
      u.uFar.value = far;
      u.uFrame.value = this._frame;
      this._blit(this.mMotion, dst);
      src = dst;
    }

    // ---- 9. depth of field ------------------------------------------------
    if (q.dof) {
      const dst = src === this.rtA ? this.rtB : this.rtA;
      const u = this.mDOF.uniforms;
      u.tColor.value = src.texture;
      u.tDepth.value = depthTex;
      u.uNear.value = near;
      u.uFar.value = far;
      u.uFrame.value = this._frame;
      this._blit(this.mDOF, dst);
      src = dst;
    }

    // ---- 10. bloom --------------------------------------------------------
    const mips = this.bloomMips;
    this.mBloomPre.uniforms.tSource.value = src.texture;
    this._blit(this.mBloomPre, mips[0]);

    for (let i = 1; i < mips.length; i++) {
      this.mBloomDown[i].uniforms.tSource.value = mips[i - 1].texture;
      this._blit(this.mBloomDown[i], mips[i]);
    }

    const autoClear = r.autoClear;
    r.autoClear = false;   // upsample accumulates onto the downsampled mip
    // Each step's weight compounds on the way down, so mip k lands in the frame
    // at taper^k: a 1 / 0.8 / 0.64 / 0.51 / 0.41 / 0.33 ladder against blur radii
    // that double each rung. That is the falloff; equal weights are a flat veil.
    const taper = this.params.bloom.mipTaper;
    for (let i = mips.length - 1; i >= 1; i--) {
      const u = this.mBloomUp[i].uniforms;
      u.tSource.value = mips[i].texture;
      u.uRadius.value = this.params.bloom.radius;
      u.uWeight.value = taper;
      this._blit(this.mBloomUp[i], mips[i - 1]);
    }
    r.autoClear = autoClear;

    // ---- 11. final --------------------------------------------------------
    this.mFinal.uniforms.tColor.value = src.texture;
    this.mFinal.uniforms.tBloom.value = mips[0].texture;
    this._blit(this.mFinal, null);

    this._prevViewProj.copy(this._viewProj);
  }

  // =========================================================================

  dispose() {
    this._offNeedCam?.();
    if (this._offs) for (let i = 0; i < this._offs.length; i++) this._offs[i]();
    this._offs = null;

    this._disposeTargets();
    this._quadGeo?.dispose();
    this._placeholderMat?.dispose();

    const mats = [
      this.mVelocity, this.mAO, this.mAOBlurX, this.mAOBlurY, this.mSSR,
      this.mComposite, this.mTAA, this.mTileA, this.mTileB, this.mNeighborMax,
      this.mMotion, this.mDOF, this.mBloomPre, this.mFinal,
    ].concat(this.mBloomDown || [], this.mBloomUp || []);
    for (let i = 0; i < mats.length; i++) mats[i]?.dispose();

    this._quadScene?.remove(this._quad);
    this._quad = null;
  }
}
