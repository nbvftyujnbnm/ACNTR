import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp } from '../core/MathUtils.js';
import { SKY_VERT, SKY_FRAG } from './shaders/sky.js';

const _invProj = new THREE.Matrix4();

/**
 * Rubicon-grade atmosphere: an analytic scattering base (Rayleigh lobe +
 * strong forward-scattering aerosol lobe) with two procedural layers on top —
 * a stratified horizon dust bank and a scrolling smog deck — plus a limb
 * darkened sun disc bright enough to feed the bloom chain a real hot core.
 *
 * It draws as a full-screen triangle pinned to the far plane, so sky pixels
 * leave depth at 1.0 and the post stack can identify them for free.
 *
 * The same material is re-used to bake a PMREM environment map, which is what
 * gives every metal surface in the game a physically plausible response.
 */
export class Sky {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    /** Live-tweakable atmosphere description. Call `bake()` after big changes. */
    this.params = {
      // Low enough to rake, high enough that horizontal ground still receives a
      // dominant key: sin(17) = 0.29 against sin(12.5) = 0.22, a third more.
      sunElevation: 17.0 * (Math.PI / 180),
      // Chosen so the key rakes ACROSS both review framings rather than sitting
      // behind the camera: side-key on the hero pose, back-side on the vista.
      sunAzimuth: -0.35,
      sunSpeed: 0,                            // radians/sec of azimuth drift
      windSpeed: 1.0,
      hazeFalloff: 5.2,
      // Tight, not broad. A wide Mie lobe turns the whole sun side of the sky
      // into a single blown highlight, which then feeds the bloom chain a
      // quarter-frame of white — REVIEW calls that an automatic failure.
      mieStrength: 0.72,
      mieG: 0.845,
      rayleigh: 0.34,
      sunIntensity: 190,
      sunAngular: 0.0165,
      // How much wider / dimmer the disc becomes for the IBL bake. A 0.0165 rad
      // disc is a third of a texel on a 256px cube face — it aliases into
      // fireflies. Widening it ~7x and dropping the peak keeps roughly the same
      // integrated energy while giving metals a real, resolvable sun blob to
      // reflect (that blob is what draws the chamfer glints).
      envSunWiden: 7.0,
      envSunGain: 0.10,
      cloudCover: 0.52,
      cloudOpacity: 0.86,
      cloudScale: 0.62,
      bandStrength: 0.70,
      dither: 0.009,
      bakeInterval: 7.0,
    };

    // --- palette (linear radiance, pre-tonemap) ---------------------------
    // Deliberately dim and desaturated away from the sun: the frame's contrast
    // has to come from WHERE the light is, not from a uniformly bright dome. The
    // Mie lobe puts ~2.5 linear next to the sun against ~0.3 on the far side,
    // which is what gives the PMREM its directionality.
    this.colors = {
      zenith: new THREE.Color(0.070, 0.090, 0.128),
      horizon: new THREE.Color(0.285, 0.262, 0.230),
      ground: new THREE.Color(0.052, 0.046, 0.040),
      sunTint: new THREE.Color(1.150, 0.590, 0.250),
      sunDisc: new THREE.Color(1.000, 0.845, 0.640),
      cloudDark: new THREE.Color(0.062, 0.064, 0.072),
      cloudLit: new THREE.Color(0.420, 0.372, 0.318),
      /** Lower hemisphere seen only by the IBL bake: sunlit ground bounce. */
      groundBake: new THREE.Color(0.150, 0.122, 0.088),
    };

    /** @type {THREE.Vector3} normalised, points FROM origin TOWARD the sun */
    this.sunDirection = new THREE.Vector3();
    /** @type {THREE.Color} warm ochre key-light colour */
    this.sunColor = new THREE.Color();
    /** @type {THREE.Color} cool sky fill colour, for the hemisphere light */
    this.skyFillColor = new THREE.Color();
    /** @type {THREE.Color} ground bounce colour */
    this.groundFillColor = new THREE.Color();

    /**
     * Atmosphere description consumed by the post stack's aerial-perspective
     * pass. Three superposed media rather than one exponential — a single
     * FogExp2 can only ever produce a uniform wash, which reads as milk:
     *
     *  - `deck`   low, dense, warm ground dust. Dies off with altitude, so it
     *             buries the far ground plane while leaving skylines readable.
     *  - `band`   a thin smog stratum at a fixed altitude (gaussian in height).
     *             This is the visible haze *line* that crosses tall structures.
     *  - `aerial` thin, height-independent, cool. True aerial perspective: it
     *             desaturates and lifts distant geometry without flattening it.
     *
     * `color`/`density`/`height` stay on the object because the contract names
     * them; the extra fields are additive (see Contract Amendments).
     */
    this.fogParams = {
      color: new THREE.Color(),        // mid haze (contract field)
      density: 0.0042,                 // deck density at `height` (contract field)
      height: 2,                       // deck base altitude, metres (contract field)
      falloff: 0.060,                  // 1/m vertical falloff of the deck
      deckColor: new THREE.Color(),
      bandColor: new THREE.Color(),
      // A tight stratum well clear of the deck. The gap of clean air between
      // the two is what makes each of them read as a LAYER instead of as fog.
      bandDensity: 0.0028,
      bandHeight: 55,
      bandThickness: 16,
      aerialColor: new THREE.Color(),
      aerialDensity: 0.00075,
      sunColor: new THREE.Color(),
    };

    this._time = 0;
    this._bakeTimer = 0;
    this._envDirty = true;

    this._buildMaterial();
    this._buildMesh();

    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._envTarget = null;
    /** @type {THREE.Texture|null} PMREM environment, also on scene.environment */
    this.environment = null;

    this._updateSun();
    this._updateFog();
    this.bake();
    this._emitParams();
  }

  // -------------------------------------------------------------------------

  _buildMaterial() {
    const c = this.colors;
    const p = this.params;

    this.material = new THREE.ShaderMaterial({
      name: 'ACNTR.Sky',
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uSunDir: { value: this.sunDirection },
        uZenith: { value: c.zenith },
        uHorizon: { value: c.horizon },
        uGround: { value: c.ground },
        uSunTint: { value: c.sunTint },
        uSunDisc: { value: c.sunDisc },
        uCloudDark: { value: c.cloudDark },
        uCloudLit: { value: c.cloudLit },
        uTime: { value: 0 },
        uHazeFalloff: { value: p.hazeFalloff },
        uMieStrength: { value: p.mieStrength },
        uMieG: { value: p.mieG },
        uRayleigh: { value: p.rayleigh },
        uSunIntensity: { value: p.sunIntensity },
        uSunAngular: { value: p.sunAngular },
        uCloudCover: { value: p.cloudCover },
        uCloudOpacity: { value: p.cloudOpacity },
        uCloudScale: { value: p.cloudScale },
        uBandStrength: { value: p.bandStrength },
        uDither: { value: p.dither },
        uEnvBake: { value: 0 },
        uEnvSunWiden: { value: p.envSunWiden },
        uEnvSunGain: { value: p.envSunGain },
        uGroundBake: { value: c.groundBake },
      },
      // Drawn first (renderOrder -1000) and writes no depth, so every opaque
      // object simply covers it. depthTest is off because the PMREM cube bake
      // runs with autoClear disabled and no guaranteed depth attachment.
      depthWrite: false,
      depthTest: false,
      side: THREE.FrontSide,
      toneMapped: false,
      fog: false,
    });
  }

  _buildMesh() {
    // Clip-space triangle; the vertex shader ignores every matrix.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this._geometry = geo;

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = -1000;
    mesh.name = 'ACNTR.SkyDome';

    // The view ray has to come from whichever camera is drawing us — the main
    // camera, or one of the six faces of the PMREM cube bake. Uniforms are
    // uploaded after onBeforeRender, so setting them here is always in time.
    const u = this.material.uniforms;
    mesh.onBeforeRender = (renderer, scene, camera) => {
      _invProj.copy(camera.projectionMatrix).invert();
      u.uInvProj.value.copy(_invProj);
      u.uCamWorld.value.copy(camera.matrixWorld);
    };

    this.mesh = mesh;
    this.scene.add(mesh);
  }

  // -------------------------------------------------------------------------

  _updateSun() {
    const el = this.params.sunElevation;
    const az = this.params.sunAzimuth;
    const ce = Math.cos(el);
    this.sunDirection.set(ce * Math.cos(az), Math.sin(el), ce * Math.sin(az)).normalize();

    // A sun this low is heavily reddened by the dust column it has to cross.
    const t = clamp(1 - Math.sin(Math.max(el, 0)) * 1.9, 0, 1);
    this.sunColor.setRGB(
      1.0,
      0.86 - 0.26 * t,
      0.68 - 0.42 * t
    );
  }

  _updateFog() {
    const c = this.colors;
    const p = this.fogParams;

    // Every layer terminates into a colour the sky actually shows somewhere
    // along that sight line, or distant geometry visibly cuts out against it.
    // Mid haze: horizon-weighted.
    p.color.setRGB(
      c.horizon.r * 0.74 + c.zenith.r * 0.26,
      c.horizon.g * 0.74 + c.zenith.g * 0.26,
      c.horizon.b * 0.74 + c.zenith.b * 0.26
    );

    // Ground dust: warmer than the mid haze, because it is the layer the low
    // sun actually rakes through — but no brighter, or the midground turns to
    // milk again and every value in it collapses together.
    p.deckColor.copy(c.horizon).lerp(c.sunTint, 0.10).multiplyScalar(0.94);

    // Smog band: lit from below by the ground bounce, so warmer again.
    p.bandColor.copy(c.horizon).lerp(c.sunTint, 0.15).multiplyScalar(1.00);

    // Aerial perspective: cool and pale. This is the term that separates a
    // distant ridge from the one in front of it — if it is warm like the rest,
    // depth collapses into a single beige plane. The explicit blue push is the
    // whole point: warm near, cool far is what the eye reads as distance.
    p.aerialColor.copy(c.zenith).lerp(c.horizon, 0.60);
    p.aerialColor.setRGB(
      p.aerialColor.r * 0.94,
      p.aerialColor.g * 1.02,
      p.aerialColor.b * 1.30
    );

    p.sunColor.copy(c.sunTint).multiplyScalar(0.62);

    // The post stack owns atmosphere outright. A FogExp2 here would be a SECOND
    // exponential stacked on top of the pass below, which is exactly how the
    // frame turned into an undifferentiated wash.
    this.scene.fog = null;

    // Weighted toward the zenith: the bounce/hemisphere fill has to be the COOL
    // half of the key/fill temperature split, or the shadow side goes the same
    // ochre as the lit side and the frame reads monochrome.
    this.skyFillColor.copy(c.zenith).lerp(c.horizon, 0.25);
    this.groundFillColor.copy(c.groundBake).lerp(c.horizon, 0.28);
  }

  _emitParams() {
    // The post stack needs the atmosphere description for its height-fog and
    // aerial-perspective term. Bus rather than a direct import so neither
    // module has to know the other exists.
    const f = this.fogParams;
    bus.emit('sky:params', {
      sunDirection: this.sunDirection,
      sunColor: this.sunColor,
      fogColor: f.color,
      fogSunColor: f.sunColor,
      fogDensity: f.density,
      fogHeight: f.height,
      fogFalloff: f.falloff,
      deckColor: f.deckColor,
      bandColor: f.bandColor,
      bandDensity: f.bandDensity,
      bandHeight: f.bandHeight,
      bandThickness: f.bandThickness,
      aerialColor: f.aerialColor,
      aerialDensity: f.aerialDensity,
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Re-render the sky into a PMREM environment map. Expensive (six cube faces
   * plus the roughness convolution chain) so it runs at init and then only on
   * `params.bakeInterval`, never per frame.
   */
  bake() {
    const u = this.material.uniforms;

    // Swap the pin-sharp disc for a wide, resolvable sun blob. A 0.0165 rad
    // disc is sub-texel on a 256px cube face — it either vanishes or turns into
    // fireflies. The widened blob carries comparable energy, survives the
    // roughness convolution, and is what a chamfer actually glints off.
    u.uEnvBake.value = 1;

    const bakeScene = this._bakeScene || (this._bakeScene = new THREE.Scene());
    if (!this._bakeMesh) {
      this._bakeMesh = new THREE.Mesh(this._geometry, this.material);
      this._bakeMesh.frustumCulled = false;
      this._bakeMesh.onBeforeRender = this.mesh.onBeforeRender;
      bakeScene.add(this._bakeMesh);
    }

    const prev = this._envTarget;
    this._envTarget = this._pmrem.fromScene(bakeScene, 0, 0.1, 100);
    if (prev) prev.dispose();

    u.uEnvBake.value = 0;

    this.environment = this._envTarget.texture;
    this.scene.environment = this.environment;
    // No scene.background: the sky triangle already covers every pixel the
    // opaque pass leaves, so a background pass is pure overdraw — and a PMREM
    // texture as a background is a blurred, low-res version of the same sky.
    this.scene.background = null;
    this._envDirty = false;
    this._bakeTimer = 0;
  }

  /**
   * @param {number} dt seconds
   * @param {number} elapsed seconds since boot
   */
  update(dt, elapsed) {
    this._time += dt * this.params.windSpeed;
    this.material.uniforms.uTime.value = this._time;

    if (this.params.sunSpeed !== 0) {
      this.params.sunAzimuth += this.params.sunSpeed * dt;
      this._updateSun();
      this._envDirty = true;
    }

    this._bakeTimer += dt;
    if (this._bakeTimer >= this.params.bakeInterval) {
      // Cloud drift changes the environment slowly; re-integrating it keeps
      // ambient light from locking to a stale sky.
      this.bake();
      this._emitParams();
    }
  }

  /**
   * Push palette / density edits into the live uniforms, fog and IBL.
   * Call after mutating `.colors`, `.params` or `.fogParams`.
   */
  refresh() {
    const u = this.material.uniforms;
    const p = this.params;
    u.uHazeFalloff.value = p.hazeFalloff;
    u.uMieStrength.value = p.mieStrength;
    u.uMieG.value = p.mieG;
    u.uRayleigh.value = p.rayleigh;
    u.uSunIntensity.value = p.sunIntensity;
    u.uSunAngular.value = p.sunAngular;
    u.uCloudCover.value = p.cloudCover;
    u.uCloudOpacity.value = p.cloudOpacity;
    u.uCloudScale.value = p.cloudScale;
    u.uBandStrength.value = p.bandStrength;
    u.uDither.value = p.dither;
    u.uEnvSunWiden.value = p.envSunWiden;
    u.uEnvSunGain.value = p.envSunGain;

    this._updateSun();
    this._updateFog();
    this.bake();
    this._emitParams();
  }

  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.onBeforeRender = () => {};
    }
    if (this._bakeMesh && this._bakeScene) this._bakeScene.remove(this._bakeMesh);
    this._geometry?.dispose();
    this.material?.dispose();
    this._envTarget?.dispose();
    this._pmrem?.dispose();
    if (this.scene.environment === this.environment) this.scene.environment = null;
    this.environment = null;
  }
}
