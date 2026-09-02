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
      exposure: 0.662,
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
      //
      // `radius` is the tent kernel width on every upsample step. At 1.05 the
      // top mips (25x14 at 1600x900) were being magnified 64x by a 3x3 tent,
      // which is not enough taps to hide the source texels — the halo around
      // the vista's conveyor glint had visible blocky steps in it. 1.35 costs
      // nothing and resolves them.
      //
      // `tint`/`tintCore` are the flare's structure, not its energy: see
      // FINAL_FRAG. A low sun seen down a dust column does not scatter
      // neutrally, so the wide skirt is tinted amber while the core stays
      // white. That difference is most of what separates "atmospheric glow"
      // from "someone smeared white paint on the lens".
      bloom: {
        // `threshold` 1.45 -> 1.90, and this is the flare fix. The threshold is
        // in SCENE-LINEAR radiance (the prefilter runs before exposure), and
        // mapping it through exposure 0.662 + AgX puts 1.45 at display 225 and
        // 1.90 at display 239. The sky's Mie lobe around a 13.5-degree sun peaks
        // near 3.0 linear / display 237 across roughly a sixth of the vista
        // frame — so at 1.45 the SKY ITSELF was the largest bloom emitter in the
        // shot, dumping a broad, low-contrast source into every mip. That is
        // what produced a white smear instead of a flare: the glow was not the
        // sun's falloff, it was a quarter of the sky bleeding sideways. At 1.90
        // the broad lobe drops out and the emitters are the sun disc (120
        // linear), specular glints and emissives — all of them one to two orders
        // of magnitude clear of the threshold, which is what a hot core with a
        // structured skirt requires.
        threshold: 1.90, knee: 0.60, strength: 1.00, radius: 1.35,
        clamp: 4, mipTaper: 0.74,
        tint: new THREE.Vector3(1.06, 0.72, 0.42), tintCore: 2.2,
      },
      // Radius up from 1.1 m: the subject is a 9 m mech on open sand, and a 1 m
      // kernel only ever found the geometry's own creases, never the gap between
      // a foot and the ground.
      //
      // `power` back off 2.0: squaring the visibility term stacks a second,
      // uncorrelated darkening on top of the cascade shadow, and on the hero
      // pose the apron under the mech was landing at display value 11/255 —
      // a contact shadow you cannot see BECAUSE everything around it is also
      // black. AO's job is to find the crease, not to set the black point.
      ssao: { radius: 1.55, strength: 1.0, bias: 0.03, power: 1.7 },
      ssr: { intensity: 0.85, maxDistance: 48, thickness: 1.2, roughness: 0.30, upBoost: 1.1 },
      motionBlur: { shutter: 0.6, maxPx: 24 },
      // Far-field DOF was the single biggest contributor to "distant geometry
      // dissolves into mush": at farScale 0.45 with a 70 m rest focus, every
      // ridge and gantry past the midground was blurred by up to 6.5 px BEFORE
      // the haze touched it. AC6's depth cue is aerial perspective, not defocus.
      //
      // `restFocus` is now only the no-subject fallback (empty scene, garage,
      // boot). It used to be the focus distance in almost every frame the game
      // ever rendered — see `syncFromGame`, which only left it when an enemy
      // was locked — and at 90 m against a third-person camera that sits 8-20 m
      // from the mech, that meant THE SUBJECT WAS PERMANENTLY DEFOCUSED AND THE
      // BACKGROUND WAS THE ONLY THING IN FOCUS. Measured on mech_detail by mean
      // |Laplacian| per region: chest 11.5 with DOF on against 33.7 with it off,
      // pauldron 10.7 against 24.9, while the background was 15.0 against 14.9,
      // i.e. the mech lost two thirds of its detail and the background lost
      // nothing. Every visual review of this project was graded through that.
      //
      // `subjectRise` lifts the focus point from the mech's ORIGIN, which the
      // contract puts at the feet, to roughly the middle of its mass. Focusing
      // on the feet of a 9 m subject 19 m away is a visible error on its own.
      dof: { restFocus: 90, subjectRise: 4.5, farScale: 0.10, nearScale: 0.10, maxRadius: 3.2, hex: 0.75 },
      taa: { blend: 0.925, clampGamma: 1.15, jitterScale: 1.0 },
      // 0.85 -> 0.34. MEASURED: the CA offset in FINAL_FRAG is
      // `cc * r2 * 4.0 * amount * uTexel`, which at the frame corner
      // (|cc| = 0.707, r2 = 0.5) is 1.20 texels per channel — a 2.4 px red/blue
      // split on every edge out there. Binned |R-B| over pixels with a
      // luminance gradient above 40, by radius, on the vista pose: 16.7 at the
      // centre rising to 44.8 in the corner. At 1:1 that is a visible rainbow
      // outline on every gantry rung and every crate edge in the lower right,
      // which is the single loudest "cheap post filter" tell left in the frame.
      // 0.34 puts the corner at 0.48 texels — under one pixel, so it survives
      // as a softening of the extreme corners rather than as coloured fringes.
      // NOTE this uniform is also driven up at runtime by crit/hit/speed (see
      // the FINAL uniform sync), where a hard fringe IS the intent; only the
      // resting value changes here.
      chromatic: { amount: 0.34 },
      // Down from 0.34. Both review framings put GROUND in the bottom corners,
      // so the vignette was spending most of its darkening on the one part of
      // the frame that was already the hardest to read.
      vignette: { amount: 0.26, smoothness: 0.42 },
      grain: { amount: 0.030 },
      scanline: { amount: 0.010, count: 900 },
      atmosphere: { strength: 1.0 },
      // Dust-bank structure for the deck and band media — see `dustGain` in
      // COMPOSITE_FRAG. `amount` is the peak fractional swing in those two
      // terms' density (0.55 = 0.45x .. 1.55x, mean exactly 1.0, so total
      // veiling on the far ridges is unchanged). `scale` is metres per noise
      // cell horizontally. `drift` is metres per second of wind advection.
      //
      // `scale` matters more than it looks. At the first value tried (190 m) a
      // single bank was WIDER than the whole midground: measured on the vista
      // pose, the 700 px window across the 300-800 m plain spans about 140 m of
      // world at the far probe, so one noise cell covered all of it and the term
      // shifted the region's LEVEL without adding any structure inside it —
      // region standard deviation moved 15.9 -> 16.9 and no further at twice the
      // amplitude. The useful range is a scale small enough that two or three
      // banks cross the frame; below ~50 m they start reading as blotches rather
      // than weather. Note that a fixed-region standard deviation is a poor
      // metric for this whichever value is chosen — which bank happens to land
      // on the measured rectangle dominates it — so this was settled on the
      // frames, not the numbers.
      dust: { amount: 0.70, scale: 110, drift: 1.6 },

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
        // MEASURED DEAD END, so nobody repeats it: slope and exposure cannot be
        // traded against each other to buy shoulder. The clip point in scene
        // terms is sigmoid(L * exposure) = 1 / slope, and the sigmoid maps 16.5
        // EV onto [0,1] — so recovering the 5% of mid-tone that dropping slope
        // to 1.07 costs takes +0.4 EV of exposure, which moves the clip point
        // back down by exactly the amount the slope change raised it. Tried it
        // (l21): the blown area shrank only as much as the whole frame dimmed,
        // and the mech's shadow side, the sand and the midground all lost 5%
        // with it. A blown highlight is fixed at the SOURCE or not at all.
        //
        // `power` is the shadow-targeted knob in this vec4 and the one that
        // decides whether the mech's unlit flank is readable. Because it is a
        // pow() on a [0,1] display value it moves the toe hard and the shoulder
        // barely at all: dropping it from 1.14 to 1.04 raises a 0.07 shadow by
        // 40% and a 0.80 highlight by 2.4%. Contrast and exposure cannot do
        // that — they move the whole curve.
        // power 1.00 -> 0.94. `power` is a pow() on the sigmoid's [0,1] output,
        // so it is almost purely a TOE control: measured on the curve, 0.94
        // raises a 0.15 shadow by 12%, a 0.45 mid by 5% and a 0.85 highlight by
        // 1%. That is the trade the hero pose needs — 21.6% of that frame was
        // below display 14 and 12.5% below 8 — and it is affordable now only
        // because the midground haze cut (Sky.fogParams) took MORE than 12% of
        // lift back off the vista's shadowed sand in the same pass. Raising the
        // toe on its own would have re-flattened the plain this iteration is
        // trying to open up.
        agxLook: new THREE.Vector4(1.13, 0.0, 0.94, 0.88),
        // The frame's black point, applied last in the grade (see FINAL_FRAG).
        // AC6's shadows are deep but you can always read what is in them; a
        // crushed-to-black shadow is the giveaway of a hobby renderer.
        // Blue-weighted so the darkest part of the frame is also its coolest.
        //
        // 0.026 -> 0.032. `lift` is the most toe-selective knob in the grade
        // because it is purely additive and scaled by (1 - disp): measured on
        // the curve it moves a display-9 black by +18% and a display-146 sunlit
        // sand by +0.7%. That buys back most of the hero pose's pure black
        // (9.3% of the frame under display 8) for a 2.7% cost in the vista's
        // sunlit:shadowed sand ratio, which is the cheapest exchange rate any
        // knob in this file offers. Do NOT reach for `contrast` or `exposure`
        // here — both move the sunlit half by as much as the shadows.
        //
        // 0.032 -> 0.022, and this is a TRADE, not a revert. `lift` is additive
        // on the display value — `disp = lift + (1 - lift) * disp` — so every
        // code value it adds to the floor is bought by compressing everything
        // above it. A contact shadow that darkens its surround 42% before the
        // grade darkens it less than 42% after, which is exactly the wrong
        // direction for the one defect this pass is chasing. The floor it was
        // holding up is now held up by `Lighting.params.bounceIntensity`, a real
        // light: multiplicative, so the AO and cascade ratios survive intact and
        // the contact shadow gets MORE readable as the shadows open, not less.
        // The 0.010 that comes back off the toe is tonal range returned to the
        // vista's shadowed sand, which is the other defect on the list.
        lift: new THREE.Vector3(0.022, 0.025, 0.038),
        gamma: new THREE.Vector3(1.0, 1.0, 1.0),
        gain: new THREE.Vector3(1.035, 1.0, 0.950),
        // Reads as before (1.0 = neutral) but drives an S-curve now, so it can
        // be pushed for real tonal range in the sand without clipping the toe.
        contrast: 1.24,
        saturation: 0.94,
        // Cooled: (-0.026, -0.006, 0.044) -> (-0.038, -0.008, 0.058). AC6's
        // signature is a warm key against a COOL shadow, and this frame was not
        // delivering the second half — measured on the vista pose, sunlit sand
        // reads R/B 1.38 and sand in shadow still reads 1.22, i.e. the shadow is
        // barely cooler than the light. The cause is that the terrain's own
        // albedo is warm ochre and the largest ambient term reaching it (the
        // PMREM environment) is warm too, so nothing in the shadow is cool
        // enough to overcome the paint. The two directional fills already carry
        // the right temperatures and cannot be pushed harder without flattening
        // the plain, so the remaining separation is bought here, where it is
        // aimed at the bottom of the curve and nowhere else.
        splitShadow: new THREE.Vector3(-0.038, -0.008, 0.058),
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
    // Autofocus scratch — syncFromGame runs every frame and must not allocate.
    this._focusFwd = new THREE.Vector3();
    this._focusVec = new THREE.Vector3();
    this._sunDir = new THREE.Vector3(0.4, 0.35, 0.6).normalize();
    this._fogColor = new THREE.Color(0.26, 0.23, 0.19);
    this._fogSunColor = new THREE.Color(0.72, 0.37, 0.16);
    this._deckColor = new THREE.Color(0.33, 0.27, 0.21);
    this._bandColor = new THREE.Color(0.40, 0.32, 0.24);
    this._aerialColor = new THREE.Color(0.16, 0.17, 0.19);
    // Fallbacks only — Sky pushes the real atmosphere over `sky:params`. Kept
    // in step with Sky.fogParams so a frame rendered before the first emit does
    // not visibly re-grade when it arrives.
    this._fogDensity = 0.0029;
    this._fogHeight = 2;
    this._fogFalloff = 0.115;
    this._bandDensity = 0.0008;
    this._bandHeight = 55;
    this._bandThickness = 16;
    this._aerialDensity = 0.0024;
    this._aerialRamp = 1000;
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
      uDustAmount: { value: p.dust.amount },
      uDustScale: { value: p.dust.scale },
      uDustTime: { value: 0 },
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
      uBloomTint: { value: p.bloom.tint },
      uBloomCore: { value: p.bloom.tintCore },
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
    // MEASURED BUG, and it is why the boost pose had no speed cues at all.
    // This used to be `(speed - 55) / 170`, i.e. it reached full strength at
    // 225 m/s — a speed the movement model cannot produce. PlayerController's
    // tuning table caps assault boost at `assaultMax` 95 m/s and hard-clamps
    // everything at `maxSpeed` 145, so the old range delivered speedNorm 0.235
    // at the game's actual top speed and the radial blur term
    // (`uRadial = d.speed * 0.055`) topped out at 0.013 — under two pixels of
    // stretch at the frame corner. The one term in the pipeline whose job is to
    // say "90 m/s" was permanently at a quarter throttle.
    //
    // The band is now the one the movement model actually occupies: 30 m/s is
    // just under ground boost (`boostSpeed` 34), 95 is assault-boost terminal,
    // so an assault boost reaches 1.0 and a ground boost sits near zero. The
    // 30% scale on the non-assault branch keeps quick boosts (55-78 m/s) as a
    // flick rather than a sustained smear.
    const speedNorm = clamp((speed - 30) / 65, 0, 1);
    d.speedT = assault ? speedNorm : speedNorm * 0.30 * boosting;

    // ---- autofocus ---------------------------------------------------------
    //
    // Focus follows what is actually IN FRAME. This used to key off the locked
    // target alone and fall back to `restFocus` (90 m) whenever nothing was
    // locked — which is every review pose and most of normal play — so the
    // player's own mech, 8-20 m away and filling the middle of the screen, sat
    // 70+ m outside the focal plane in almost every frame the game rendered.
    //
    // The player's mech is the subject of a third-person shot, so it is the
    // primary focus target. When an enemy is ALSO locked, focus at the harmonic
    // mean of the two distances rather than on either: that is the classic
    // two-plane depth-of-field split, and it is what keeps both acceptably
    // sharp instead of trading one for the other. With the mech at 19 m and a
    // target at 200 m it lands at 35 m, which puts BOTH inside the 0.6 px
    // circle-of-confusion threshold the DOF pass skips entirely.
    //
    // Distances are VIEW DEPTH, not radial distance, because that is what
    // DOF_FRAG compares `uFocus` against.
    const pp = game?.player?.root?.position;
    const tp = game?.targeting?.target?.root?.position;
    const pd = pp ? this._viewDepth(pp, this.params.dof.subjectRise) : -1;
    const td = tp ? this._viewDepth(tp, this.params.dof.subjectRise) : -1;

    if (pd > 0 && td > 0) {
      d.focusT = clamp((2 * pd * td) / (pd + td), 3, 500);
    } else if (pd > 0) {
      d.focusT = clamp(pd, 3, 500);
    } else if (td > 0) {
      d.focusT = clamp(td, 3, 500);
    } else {
      d.focusT = this.params.dof.restFocus;
    }

    if (game?.state === 'dead') d.critT = 1;
  }

  /**
   * View-space depth of a world point — its distance along the camera's forward
   * axis, which is the quantity DOF_FRAG reconstructs from the depth buffer.
   * Radial distance is NOT the same thing and is wrong for anything off-centre.
   *
   * Returns -1 when there is no camera. Allocation-free.
   *
   * @param {THREE.Vector3} pos
   * @param {number} rise metres to lift the point along world up
   * @returns {number}
   */
  _viewDepth(pos, rise) {
    const cam = this.camera;
    if (!cam) return -1;
    const e = cam.matrixWorld.elements;
    // three cameras look down their local -Z; column 2 of matrixWorld is that
    // local Z axis expressed in world space.
    this._focusFwd.set(-e[8], -e[9], -e[10]).normalize();
    this._focusVec.copy(pos).sub(cam.position);
    this._focusVec.y += rise;
    return this._focusVec.dot(this._focusFwd);
  }

  _updateDynamics(dt) {
    const d = this._dyn;
    const p = this.params;
    const step = Math.min(dt || 0.016, 0.1);

    d.crit = damp(d.crit, d.critT, 5, step);
    d.speed = damp(d.speed, d.speedT, 6, step);
    // A CUT, not a rack. On a camera teleport, a respawn or a target switch the
    // focus distance jumps by an order of magnitude, and damping through that
    // at rate 3.2 spends over a second visibly focused on nothing — and in a
    // still capture, which settles for well under a second, it never converges
    // at all. Real camera work snaps focus across a cut and racks only within a
    // shot, so key the behaviour off the RATIO: anything past 2.5x is a cut.
    const fr = d.focusT / Math.max(d.focus, 1e-3);
    if (fr > 2.5 || fr < 0.4) d.focus = d.focusT;
    else d.focus = damp(d.focus, d.focusT, 3.2, step);
    d.hit = Math.max(0, d.hit - step * 2.6);
    d.scan = Math.max(0, d.scan - step * 1.8);

    const t = this._elapsed;
    // Low-AP flicker: two detuned oscillators so it reads as a failing power
    // bus rather than a sine wave.
    const flicker = d.crit * (Math.sin(t * 37.0) * 0.5 + Math.sin(t * 11.3) * 0.5) * 0.055;
    const hitFlash = d.hit * 0.22;

    const f = this.mFinal.uniforms;
    f.uExposure.value = p.exposure * (1 + flicker + hitFlash);
    // The speed coefficient came down 1.8 -> 0.95 in the same pass that fixed
    // `speedNorm` above. It was written against a term that could only ever
    // reach 0.235, so it was really a 0.42 fringe; left at 1.8 with a corrected
    // normalisation an assault boost would run uChromatic at 2.14, which is
    // 3.0 texels of per-channel offset at the frame corner — a 6 px rainbow
    // outline on every edge out there, the exact defect `chromatic.amount` was
    // cut from 0.85 to 0.34 to remove. At 0.95 a full assault boost reaches
    // 1.29, i.e. 1.8 texels: an unmistakable prismatic edge stretch in the
    // corners that still never separates into three legible fringes.
    //
    // THE CRIT AND HIT COEFFICIENTS WERE NEVER CONVERTED TO PIXELS, and they
    // are the reason a low-AP frame reads as a cheap filter. The corner offset
    // is `|cc| * r2 * 4 * uChromatic` texels with |cc| = 0.7071 and r2 = 0.5,
    // i.e. 1.414 texels per channel — and R and B move in OPPOSITE directions,
    // so the visible red/blue split is 2.83 * uChromatic pixels. Worked through
    // the whole ladder at 1600x900:
    //
    //   resting          0.34 ->  1.0 px    (sub-pixel, correct)
    //   assault boost    1.29 ->  3.6 px    (measured and intended, see above)
    //   30% AP  (old)    1.96 ->  5.5 px
    //   23% AP  (old)    3.05 ->  8.6 px    <- shots/garage01/hud.png
    //   0% AP   (old)    3.74 -> 10.6 px
    //   23% AP + a hit landing + assault boost (old): 7.00 -> 19.8 px
    //
    // The 0.85 that this uniform was CUT FROM, as "the single loudest cheap
    // post filter tell left in the frame", was 2.4 px. Every crit value above
    // was three to eight times that, on the frames a player spends the most
    // time looking at. Three separate terms key off `crit` (this, +0.10 of
    // vignette, and the damage rim) and this is the one that was out by an
    // order of magnitude, not the rim.
    //
    // New coefficients put full crit at 1.59 (4.5 px — a shade past assault
    // boost, which is right: a failing FCS should read stronger than speed)
    // and a landed hit at up to 2.28 more, a ~0.2 s transient. The clamp is
    // the guard the additive form never had: four independent terms summing
    // means the worst case is not any of their design points, and 3.2 (9.1 px)
    // is the most this frame can carry before the fringe separates.
    f.uChromatic.value = Math.min(
      3.2, p.chromatic.amount + d.crit * 1.25 + d.hit * 1.9 + d.speed * 0.95);
    f.uVignette.value = p.vignette.amount + d.crit * 0.10;
    f.uDamage.value = clamp(d.crit * 0.55 + d.hit * 0.65, 0, 1);
    f.uGrain.value = p.grain.amount * (1 + d.crit * 1.4);
    f.uScanline.value = p.scanline.amount + d.scan * 0.10 + d.crit * 0.02;
    f.uScanCount.value = p.scanline.count;
    f.uSharpen.value = p.sharpen;
    f.uBloomStrength.value = p.bloom.strength;
    f.uBloomCore.value = p.bloom.tintCore;
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
    c.uDustAmount.value = p.dust.amount;
    c.uDustScale.value = p.dust.scale;
    c.uDustTime.value = this._elapsed * p.dust.drift;
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
