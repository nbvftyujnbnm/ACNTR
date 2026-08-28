import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp } from '../core/MathUtils.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

/** Only one Lighting is ever live; the pipeline pokes it through this. */
let _active = null;

/** Module-scope scratch — the frame path must not allocate. */
const _fillDir = new THREE.Vector3();
const _bounceDir = new THREE.Vector3();

/**
 * Scale a colour so its largest channel is 1. The sky palette stores radiances,
 * not hues; every light in this rig wants the hue from the palette and the
 * level from its own intensity, or the two multiply and the knob stops meaning
 * anything. Mutates and returns `c` — no allocation.
 *
 * @param {THREE.Color} c
 * @returns {THREE.Color}
 */
function normaliseHue(c) {
  const m = Math.max(c.r, c.g, c.b, 1e-4);
  return c.multiplyScalar(1 / m);
}

/**
 * Register every lit material in `scene` with the active CSM.
 *
 * CSM works by replacing the single sun with one directional light per cascade
 * and gating each one on view depth inside the shader. A material that never
 * got `USE_CSM` takes the stock path instead and sums ALL cascade lights, so it
 * renders at 4x sun brightness. Everything therefore has to be registered
 * before it is first drawn — which is why the render pipeline calls this
 * immediately before `renderer.render`, not on some timer.
 *
 * @param {THREE.Scene} scene
 */
export function syncSceneMaterials(scene) {
  if (_active) _active.syncMaterials(scene);
}

function isLitMaterial(m) {
  return !!(
    m.isMeshStandardMaterial ||
    m.isMeshPhysicalMaterial ||
    m.isMeshLambertMaterial ||
    m.isMeshPhongMaterial ||
    m.isMeshToonMaterial ||
    (m.isShaderMaterial && m.lights === true)
  );
}

/**
 * Sun + ambient rig.
 *
 * - Cascaded shadow maps (4 cascades, texel-snapped by CSM so they don't swim).
 * - A hemisphere fill derived from the sky palette so nothing reads pure black
 *   even before the PMREM environment kicks in.
 * - Physically scaled intensities tuned for the pipeline's AgX exposure.
 */
export class Lighting {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {import('./Sky.js').Sky} sky
   */
  constructor(scene, renderer, sky) {
    this.scene = scene;
    this.renderer = renderer;
    this.sky = sky;

    this.params = {
      // A 13.5-degree sun delivers only sin(13.5) = 0.23 of its normal
      // irradiance to horizontal ground, so the key has to be scaled UP hard to
      // stay dominant there. Measured on the hero pose, raising this from 11
      // roughly doubled the display value of the mech's key-lit plating (median
      // 45 -> 98 out of 255) without touching its shadow side, which is the
      // whole point: brightness that arrives with a DIRECTION.
      sunIntensity: 17.5,
      // A small omnidirectional floor. Its job is only to keep a downward-facing
      // chamfer off pure black; anything more and it flattens the terrain, which
      // is a single enormous up-facing surface and therefore the thing that
      // suffers most from undirected light.
      //
      // This knob was a no-op for most of its life: `hemi.color` is copied
      // straight from the sky palette, whose radiances sit around 0.13, so an
      // "intensity" of 0.42 delivered 0.055 of irradiance against a key of 4.
      // The colours are renormalised now (see `_syncFromSky`), so this reads as
      // real irradiance and 0.30 means 0.30. That is deliberately the ONE
      // undirected term in the rig, and it exists for a single measured
      // failure: on the hero pose the tarmac apron in the mech's own shadow was
      // landing at display 17/255 with 64% of the lower-left quadrant below 16.
      // Sunlit ground pays 5% for it; ground in shadow gains 25%, because the
      // sun is 4.1 and the ambient it is being added to is 1.1.
      //
      // 0.22 -> 0.16, paid straight into `bounceIntensity`. Same trade as
      // before and for the same measured reason: on the vista pose the sunlit
      // sand reads display 128 against 58 in shadow, a ratio of only 2.2:1,
      // and the reason is that a 13.5-degree sun delivers just sin(13.5) = 0.23
      // of its irradiance to horizontal ground. That makes the PLAIN — and only
      // the plain — a surface whose shadowed value is dominated by undirected
      // light. Every 0.01 taken off an omnidirectional term is therefore worth
      // ~4x more contrast on the ground than the same 0.01 costs the mech,
      // which has a directional fill of its own to fall back on.
      //
      // 0.30 -> 0.22. This is the ONLY term in the rig with no direction at all,
      // so it is the only one that costs the terrain contrast at full rate: the
      // plain is one enormous up-facing surface, and an omnidirectional 0.30
      // against a horizontal-ground key of 4.08 is 7% of the lit value but 31%
      // of the shadowed value. The 0.08 taken out comes back on `fillIntensity`,
      // which delivers 0.13 of itself to horizontal ground and 0.99 to a
      // vertical flank — so the swap is a straight transfer of ambient off the
      // sand and onto the mech's plating.
      hemiIntensity: 0.16,
      // Was 2.2, from when every mech surface was metalness 1.0 and had no
      // diffuse lobe at all. The armour is dielectric now (see Contract
      // Amendments), so the environment feeds DIFFUSE on every surface in the
      // level — and an environment map is, by construction, the least
      // directional light in the rig. At 2.2 the sand plain's ambient term was
      // within a factor of 3 of its sun term, which is why cascades that were
      // correctly rendering shadows produced almost no visible contrast. The
      // energy taken out here goes back in on the key and the bounce, both of
      // which have a direction and therefore SHAPE the surface.
      // 1.18 -> 1.00. The environment is the SECOND undirected term, and on the
      // plain it is the larger of the two. It cannot be cut as freely as the
      // hemisphere because it also drives specular — it is what puts the sky in
      // a chamfer and stops metal reading as plastic — so this is a 15% trim
      // rather than the 25% the ground contrast alone would want. Anything past
      // this should come out of `hemiIntensity` or go into the key instead.
      envIntensity: 1.00,
      // Cool bounce from the opposite side so the shadow side stays readable.
      // AC6 shadows are deep but never crushed; this is what keeps them open.
      // Carries much more of the ambient budget than it used to — see
      // `fillElevation` for why that does NOT flatten the ground.
      //
      // 2.75 -> 3.35, paid for out of `hemiIntensity`. At a 7.5-degree
      // elevation this adds 0.59 to a vertical unlit flank and 0.078 to
      // horizontal ground; the hemisphere cut removes 0.08 from both. Net: the
      // mech's shadow side gains ~16% of its ambient, the sand plain loses ~0.2%
      // of its lit value and ~0.3% of its shadowed value. That asymmetry is the
      // entire reason this light is nearly horizontal.
      fillIntensity: 3.35,
      // The SINE of the bounce's elevation above the horizon, and the single
      // most useful number in this rig — because it is the only knob that
      // separates "shadow on the mech" from "shadow on the ground".
      //
      // At the original 0.85 the fill pointed almost straight down: it landed
      // on the terrain, which is one enormous up-facing surface and already the
      // brightest thing in frame, and missed the VERTICAL shadow-side plating
      // entirely.
      //
      // This used to be an OFFSET added to |sunDir.y|, which meant the fill's
      // real elevation tracked the sun's: at a 13.5-degree sun, an "elevation"
      // of 0.10 actually put the bounce at 18.7 degrees — HIGHER than the key,
      // and landing 0.32 of itself on the sand. Read as an absolute sine it
      // does what it says: 0.13 is 7.5 degrees, so cos(theta) on horizontal
      // ground is 0.13 while cos(theta) on an unlit vertical flank is 0.99.
      // That ratio is 7.6:1 against the old 2.7:1, which is what lets the fill
      // be strong enough to open the mech's dark side (+62% measured on the
      // hero pose) while simultaneously taking 37% of the undirected light OFF
      // the sand. No exposure, gamma or contrast setting can do that, because
      // those move the whole frame together.
      fillElevation: 0.13,
      // GROUND BOUNCE — the second half of the fill, and the only light in this
      // rig that is FREE on the terrain.
      //
      // `fillElevation` buys asymmetry by being nearly horizontal (0.13 of
      // itself lands on the plain, 0.99 on a vertical flank). Taking the
      // elevation NEGATIVE takes that trade to its limit: at -0.11 the light
      // arrives from 6.3 degrees BELOW the horizon, so n.l on an up-facing
      // surface is negative and clamps to zero. The plain — the single largest
      // up-facing surface in every pose, and the one the contract keeps warning
      // about — receives exactly nothing from this light no matter how hard it
      // is pushed. What it does reach is what the sky fill cannot: the
      // DOWNWARD-facing half of the mech (measured on the hero pose, the
      // darkest regions in the frame are the shins and feet at mean display
      // 23.3 against a full-frame mean of 57.9) plus every vertical flank.
      //
      // Physically this is the sand bouncing the key back up, so it takes the
      // sky's `groundFillColor` — warm ochre — against the cool `skyFillColor`
      // of the horizontal fill. Warm from below, cool from the side, warm key:
      // the shadow side gets a temperature GRADIENT instead of one flat tint.
      //
      // Why this rather than more `grade.lift`: lift is additive on the display
      // value, so it raises the shadow floor by COMPRESSING everything above it
      // — a contact shadow that darkens the ground 42% before the grade darkens
      // it less than 42% after. Light added at the source is multiplicative:
      // the AO and cascade ratios survive intact and the contact shadow gets
      // MORE readable as the floor comes up, not less. `grade.lift` is dropped
      // 0.032 -> 0.022 in the same pass to pay for this in tonal range.
      // 2.1 -> 2.4, funding the hemisphere and environment cuts above. This is
      // the ONE light in the rig that is free on the terrain (it arrives from
      // 6.3 degrees BELOW the horizon, so n.l on an up-facing surface clamps to
      // zero), which makes it the only place the ambient taken off the plain can
      // be put back without undoing the contrast it just bought. Net on a
      // vertical unlit flank: roughly break-even. Net on horizontal sand:
      // strictly a loss, which is the point.
      bounceIntensity: 2.4,
      bounceElevation: -0.11,
      // Azimuth offset from the anti-sun direction, in radians. The horizontal
      // fill sits exactly opposite the key, which leaves a dead zone: a flank
      // at 90 degrees to the sun's azimuth gets cos(90) = 0 from BOTH the key
      // and the fill, and falls back on the hemisphere's 0.22. Offsetting the
      // bounce by 54 degrees puts a second lobe in the middle of that gap, so
      // the worst-lit azimuth goes from 0.22 of undirected light to ~1.2.
      bounceAzimuth: 0.95,
      cascades: 4,
      shadowMapSize: 2048,
      // The camera's near plane is 0.35 m, which drags every automatic split
      // scheme into uselessness: 'practical' put the first cascade break at
      // 79 m, so a 9 m mech got 2 cm... of a 180 m cascade. Explicit splits,
      // tuned for a mech-scale subject with a city-scale background.
      // 420 -> 560. In the vista pose the camera stands at y=78 and the plain
      // runs out to the refinery at ~500 m, so a 420 m shadow range stopped
      // casting roughly where the frame's midground begins: past that line the
      // sand had no cast shadow on it at all, which is a large part of why the
      // lower half read as one flat sheet. Cascade 3 pays ~340 mm/texel at the
      // new far edge, which at 560 m is a third of a screen pixel.
      shadowMaxFar: 560,
      // MEASURED DEFECT, and the reason the hero pose's contact shadow was soft.
      // CSM splits on VIEW DEPTH, not radial distance. The hero camera sits at
      // the player + (12, 6.4, 14) looking at (0, 4.7, 0), so its forward axis
      // puts the mech's FEET — exactly where the contact shadow is drawn — at a
      // view depth of 18.95 m. Cascade 0 ended at 18. The subject of the shot
      // was therefore being shadowed by cascade 1 at ~3.5x coarser texels, and,
      // because `fade` is on, inside the blend band between two cascades of
      // different resolution: a soft, doubled contact edge.
      //
      // 28 m puts the whole mech and its ground contact at 68% of cascade 0,
      // clear of the fade margin, at ~17 mm/texel. The later splits are moved
      // out in proportion to carry the new `shadowMaxFar`.
      splits: [28, 78, 200, 560],
      lightNear: 1,
      lightFar: 2200,
      lightMargin: 180,
      fade: true,
    };

    this._sunDir = new THREE.Vector3(0.4, 0.5, 0.6).normalize();
    this._lightDir = new THREE.Vector3();
    this._focus = new THREE.Vector3();
    this._camera = null;
    this._nonLit = new WeakSet();
    this._warnedForeignShadow = false;

    /** @type {CSM|null} */
    this.csm = null;
    /** @type {THREE.DirectionalLight} main sun handle (cascade 0 when CSM is on) */
    this.sun = null;
    /** @type {THREE.DirectionalLight[]} */
    this.sunLights = [];

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, this.params.hemiIntensity);
    this.hemi.name = 'ACNTR.SkyFill';
    scene.add(this.hemi);

    /** @type {THREE.DirectionalLight|null} shadowless sky fill, near-horizontal */
    this.fill = null;
    /** @type {THREE.DirectionalLight|null} shadowless ground bounce, below horizon */
    this.bounce = null;

    scene.environmentIntensity = this.params.envIntensity;

    this._visit = (obj) => this._visitObject(obj);

    this._offCamera = bus.on('render:camera', (cam) => {
      if (cam && cam.isCamera) this._camera = cam;
    });
    this._offResize = bus.on('engine:resize', () => {
      if (this.csm) {
        this.csm.updateFrustums();
        this._tuneShadows();
      }
    });
    this._offQuality = bus.on('render:quality', (lvl) => this.setShadowQuality(lvl));

    // The contract hands Lighting a scene and a renderer but no camera, and CSM
    // needs one to split the view frustum. The pipeline owns the camera, so ask
    // for it over the bus — emit is synchronous, so this usually resolves now.
    bus.emit('render:needCamera');

    _active = this;

    this._syncFromSky();
    this._ensureSun();
    this.syncMaterials(scene);
  }

  // -------------------------------------------------------------------------
  // sun construction
  // -------------------------------------------------------------------------

  _ensureSun() {
    if (this.csm) return;

    if (!this._camera) {
      // No camera yet — keep the scene lit with a single fitted shadow so the
      // first frames aren't black, and upgrade to CSM as soon as one arrives.
      if (!this._fallbackSun) this._createFallbackSun();
      bus.emit('render:needCamera');
      return;
    }

    if (this._fallbackSun) this._destroyFallbackSun();

    const p = this.params;
    this.csm = new CSM({
      camera: this._camera,
      parent: this.scene,
      cascades: p.cascades,
      maxFar: p.shadowMaxFar,
      mode: 'custom',
      customSplitsCallback: (amount, near, far, target) => {
        target.length = 0;
        for (let i = 0; i < amount; i++) {
          const end = i === amount - 1 ? far : Math.min(p.splits[i] || far, far);
          target.push(end / far);
        }
      },
      shadowMapSize: p.shadowMapSize,
      shadowBias: -0.00008,
      lightDirection: this._lightDir.copy(this._sunDir).multiplyScalar(-1).normalize(),
      lightIntensity: p.sunIntensity,
      lightNear: p.lightNear,
      lightFar: p.lightFar,
      lightMargin: p.lightMargin,
    });
    // fade has to be set before updateFrustums: _updateShadowBounds reads it to
    // expand each cascade by the blend margin, and _updateUniforms syncs the
    // CSM_FADE define off it.
    this.csm.fade = p.fade;
    this.csm.updateFrustums();

    this.sunLights = this.csm.lights;
    this.sun = this.csm.lights[0];
    for (let i = 0; i < this.sunLights.length; i++) {
      this.sunLights[i].name = `ACNTR.SunCascade${i}`;
    }
    this._tuneShadows();
    this._ensureFill();
    this._applySunColor();
  }

  /**
   * The two shadowless directional fills: a cool sky fill just ABOVE the
   * horizon opposite the key, and a warm ground bounce just BELOW it, offset in
   * azimuth. See `fillElevation` / `bounceElevation` for why the signs matter.
   *
   * ORDER MATTERS: three indexes `directionalShadow[]` by a light's position in
   * the full directional list, then truncates that list to the shadow count. A
   * non-shadow directional light added *before* the cascades therefore shifts
   * every cascade's shadow map by one and drops the last one entirely. They
   * have to be added after the CSM lights, so this re-adds them whenever CSM is
   * built.
   */
  _ensureFill() {
    if (this.fill) {
      this.scene.remove(this.fill);
      this.scene.remove(this.fill.target);
    } else {
      this.fill = new THREE.DirectionalLight(0xffffff, this.params.fillIntensity);
      this.fill.name = 'ACNTR.SkyFillDir';
      this.fill.castShadow = false;
    }
    this.scene.add(this.fill);
    this.scene.add(this.fill.target);

    if (this.bounce) {
      this.scene.remove(this.bounce);
      this.scene.remove(this.bounce.target);
    } else {
      this.bounce = new THREE.DirectionalLight(0xffffff, this.params.bounceIntensity);
      this.bounce.name = 'ACNTR.GroundBounce';
      this.bounce.castShadow = false;
    }
    this.scene.add(this.bounce);
    this.scene.add(this.bounce.target);
  }

  _createFallbackSun() {
    const light = new THREE.DirectionalLight(0xffffff, this.params.sunIntensity);
    light.name = 'ACNTR.SunFallback';
    light.castShadow = true;
    light.shadow.mapSize.set(this.params.shadowMapSize, this.params.shadowMapSize);
    const c = light.shadow.camera;
    c.left = -110; c.right = 110; c.top = 110; c.bottom = -110;
    c.near = 1; c.far = 900;
    c.updateProjectionMatrix();
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.08;
    this.scene.add(light);
    this.scene.add(light.target);
    this._fallbackSun = light;
    this.sun = light;
    this.sunLights = [light];
  }

  _destroyFallbackSun() {
    const l = this._fallbackSun;
    if (!l) return;
    this.scene.remove(l.target);
    this.scene.remove(l);
    l.shadow?.map?.dispose();
    l.dispose?.();
    this._fallbackSun = null;
    this.sun = null;
    this.sunLights = [];
  }

  /**
   * Per-cascade depth/normal bias scaled by that cascade's world-space texel
   * size. A single global bias either acnes the near cascade or peter-pans the
   * far one; there is no value that works for both.
   */
  _tuneShadows() {
    if (!this.csm) return;
    const size = this.params.shadowMapSize;
    const depthRange = this.params.lightFar - this.params.lightNear;

    for (let i = 0; i < this.csm.lights.length; i++) {
      const l = this.csm.lights[i];
      const cam = l.shadow.camera;
      const texel = Math.max((cam.right - cam.left) / size, 1e-4);

      // normalBias is a WORLD-SPACE offset along the surface normal. The old
      // clamp allowed 0.5 m, which is thicker than most of the geometry casting
      // the shadow — every contact shadow detached and small props stopped
      // casting at all. One texel of slope compensation is the correct scale.
      l.shadow.normalBias = clamp(texel * 1.05, 0.012, 0.14);
      // Depth bias is in normalised ortho depth, so a metre costs 1/depthRange.
      l.shadow.bias = -(texel * 1.4) / depthRange - 0.000015;
      l.shadow.camera.updateProjectionMatrix();
    }
  }

  // -------------------------------------------------------------------------
  // material registration
  // -------------------------------------------------------------------------

  /** @param {THREE.Scene} scene */
  syncMaterials(scene) {
    if (!this.csm) return;
    scene.traverse(this._visit);
  }

  _visitObject(obj) {
    if (obj.isDirectionalLight) {
      // A second shadow-casting directional light would push NUM_DIR_LIGHT_SHADOWS
      // past CSM_CASCADES and index the cascade array out of bounds — that is a
      // GLSL compile error, i.e. a hard crash. Defuse it instead.
      if (obj.castShadow && this.csm.lights.indexOf(obj) === -1) {
        obj.castShadow = false;
        if (!this._warnedForeignShadow) {
          this._warnedForeignShadow = true;
          console.warn('[Lighting] disabled castShadow on a foreign DirectionalLight — CSM owns directional shadows.');
        }
      }
      return;
    }

    const m = obj.material;
    if (!m) return;
    if (Array.isArray(m)) {
      for (let i = 0; i < m.length; i++) this._attach(m[i]);
    } else {
      this._attach(m);
    }
  }

  _attach(mat) {
    if (!mat || this._nonLit.has(mat) || this.csm.shaders.has(mat)) return;

    if (!isLitMaterial(mat)) {
      this._nonLit.add(mat);
      return;
    }

    const ownHook = Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile')
      ? mat.onBeforeCompile
      : null;
    const state = { user: ownHook };

    this.csm.setupMaterial(mat);
    const csmHook = mat.onBeforeCompile;

    const combined = function (shader, renderer) {
      csmHook.call(this, shader, renderer);
      if (state.user) state.user.call(this, shader, renderer);
    };

    // Another subsystem assigning `material.onBeforeCompile` later would drop the
    // CSM uniforms, leaving every cascade test comparing against zero — i.e. an
    // unlit scene. Intercept the assignment and chain it instead.
    Object.defineProperty(mat, 'onBeforeCompile', {
      configurable: true,
      enumerable: true,
      get() { return combined; },
      set(fn) {
        state.user = fn === combined ? state.user : fn;
        mat.needsUpdate = true;
      },
    });

    mat.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------------

  _syncFromSky() {
    const sky = this.sky;
    if (!sky) return;
    if (sky.sunDirection) this._sunDir.copy(sky.sunDirection).normalize();
    // Renormalise, exactly as the bounce does: the sky palette holds RADIANCES
    // (~0.13), so copying them raw made `hemiIntensity` a lie by a factor of
    // eight and left the only knob for "light in a shadow" doing nothing. The
    // hue is what these colours are for; the level belongs to the intensity.
    if (sky.skyFillColor) normaliseHue(this.hemi.color.copy(sky.skyFillColor));
    if (sky.groundFillColor) normaliseHue(this.hemi.groundColor.copy(sky.groundFillColor));
    this.hemi.intensity = this.params.hemiIntensity;
  }

  _applySunColor() {
    const col = this.sky?.sunColor;
    for (let i = 0; i < this.sunLights.length; i++) {
      const l = this.sunLights[i];
      if (col) l.color.copy(col);
      l.intensity = this.params.sunIntensity;
    }

    const f = this.fill;
    if (f) {
      // Sky-coloured, from the anti-sun side and only just above the horizon:
      // this is skylight bounced back into the shadow side, not a second key.
      // Keep it cool so the shadow/key split also reads as a temperature split.
      // Absolute elevation, not an offset from the sun's: the whole point of
      // this light is that it is NEARLY HORIZONTAL regardless of where the key
      // is, so its cosine falls off a flat plain and holds on a vertical flank.
      _fillDir.copy(this._sunDir).multiplyScalar(-1);
      _fillDir.y = this.params.fillElevation;
      _fillDir.normalize();
      f.position.copy(this._focus).addScaledVector(_fillDir, 220);
      f.target.position.copy(this._focus);
      f.target.updateMatrixWorld();
      // The sky fill colour is a radiance, not a hue — renormalise so the knob
      // controls intensity and the colour only carries the tint.
      if (this.sky?.skyFillColor) normaliseHue(f.color.copy(this.sky.skyFillColor));
      f.intensity = this.params.fillIntensity;
    }

    const b = this.bounce;
    if (b) {
      // Anti-sun azimuth, rotated by `bounceAzimuth` about +Y, then pushed
      // BELOW the horizon. Rotating in the XZ plane by hand rather than with
      // Vector3.applyAxisAngle keeps this allocation-free and makes the sign
      // convention explicit: (x, z) -> (x cos + z sin, -x sin + z cos).
      const ax = -this._sunDir.x;
      const az = -this._sunDir.z;
      const inv = 1 / Math.max(Math.hypot(ax, az), 1e-4);
      const ux = ax * inv;
      const uz = az * inv;
      const ca = Math.cos(this.params.bounceAzimuth);
      const sa = Math.sin(this.params.bounceAzimuth);
      _bounceDir.set(ux * ca + uz * sa, this.params.bounceElevation, -ux * sa + uz * ca);
      _bounceDir.normalize();
      b.position.copy(this._focus).addScaledVector(_bounceDir, 220);
      b.target.position.copy(this._focus);
      b.target.updateMatrixWorld();
      // The ground hemisphere colour IS this light's hue by construction — it
      // is the sky module's own estimate of what the terrain bounces back.
      if (this.sky?.groundFillColor) normaliseHue(b.color.copy(this.sky.groundFillColor));
      b.intensity = this.params.bounceIntensity;
    }
  }

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {THREE.Vector3} [focusPos] player position; re-centres the fallback
   *        shadow frustum (CSM re-centres itself off the camera frustum).
   */
  update(dt, elapsed, focusPos) {
    if (focusPos) this._focus.copy(focusPos);

    this._ensureSun();
    this._syncFromSky();
    this._applySunColor();

    if (this.csm) {
      this._lightDir.copy(this._sunDir).multiplyScalar(-1).normalize();
      this.csm.lightDirection.copy(this._lightDir);
      this.csm.update();
      return;
    }

    const l = this._fallbackSun;
    if (l) {
      // Snap the frustum centre to texel increments or the shadow crawls as the
      // player walks.
      const size = this.params.shadowMapSize;
      const extent = (l.shadow.camera.right - l.shadow.camera.left);
      const texel = extent / size;
      const cx = Math.round(this._focus.x / texel) * texel;
      const cz = Math.round(this._focus.z / texel) * texel;
      l.target.position.set(cx, this._focus.y, cz);
      l.position.set(cx, this._focus.y, cz).addScaledVector(this._sunDir, 320);
      l.target.updateMatrixWorld();
    }
  }

  /**
   * @param {'low'|'med'|'high'|'ultra'} level
   */
  setShadowQuality(level) {
    const sizes = { low: 1024, med: 1536, high: 2048, ultra: 3072 };
    const size = sizes[level] || 2048;
    if (size === this.params.shadowMapSize) return;
    this.params.shadowMapSize = size;

    if (this.csm) {
      this.csm.shadowMapSize = size;
      for (let i = 0; i < this.csm.lights.length; i++) {
        const s = this.csm.lights[i].shadow;
        s.mapSize.set(size, size);
        if (s.map) { s.map.dispose(); s.map = null; }
      }
      this.csm.updateFrustums();
      this._tuneShadows();
    } else if (this._fallbackSun) {
      const s = this._fallbackSun.shadow;
      s.mapSize.set(size, size);
      if (s.map) { s.map.dispose(); s.map = null; }
    }
  }

  dispose() {
    this._offCamera?.();
    this._offResize?.();
    this._offQuality?.();
    if (_active === this) _active = null;

    if (this.csm) {
      for (let i = 0; i < this.csm.lights.length; i++) {
        this.csm.lights[i].shadow?.map?.dispose();
      }
      this.csm.remove();
      this.csm.dispose();
      this.csm = null;
    }
    this._destroyFallbackSun();
    if (this.fill) {
      this.scene.remove(this.fill.target);
      this.scene.remove(this.fill);
      this.fill.dispose?.();
      this.fill = null;
    }
    if (this.bounce) {
      this.scene.remove(this.bounce.target);
      this.scene.remove(this.bounce);
      this.bounce.dispose?.();
      this.bounce = null;
    }
    this.scene.remove(this.hemi);
    this.hemi.dispose?.();
    this.sun = null;
    this.sunLights = [];
  }
}
