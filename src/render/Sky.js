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
      // 13.5 degrees. Lower than the previous 17 on purpose: the terrain is a
      // dune field, and a dune field only shows its FORM when the key rakes
      // across it. At 17 the crests and troughs were within a few percent of
      // each other and the plain read as one flat sheet of sand. The 20% of
      // irradiance lost on horizontal ground is bought back on the key.
      //
      // 13.5 is also the FLOOR, and that is a measured result, not caution.
      // Going to 11.5 (l23) reads as an obvious improvement in the numbers —
      // the vista's sunlit/shadowed sand ratio went from 2.3:1 to 2.8:1 — and
      // is an obvious regression in the frame. "Raking light reveals form"
      // stops being true the moment the shadows MERGE: at 11.5 the refinery's
      // cast shadows overlapped across the whole plain, the long bands of
      // sunlight running between them disappeared, and the lower half of the
      // vista went from graphic to uniformly murky. The interesting ground is
      // where lit and shadowed are INTERLEAVED, not where the ratio is largest.
      sunElevation: 13.5 * (Math.PI / 180),
      // Chosen so the key rakes ACROSS both review framings rather than sitting
      // behind the camera: side-key on the hero pose, back-side on the vista.
      sunAzimuth: -0.35,
      sunSpeed: 0,                            // radians/sec of azimuth drift
      windSpeed: 1.0,
      hazeFalloff: 5.2,
      // Tight, not broad. A wide Mie lobe turns the whole sun side of the sky
      // into a single blown highlight, which then feeds the bloom chain a
      // quarter-frame of white — REVIEW calls that an automatic failure.
      mieStrength: 0.66,
      mieG: 0.845,
      rayleigh: 0.34,
      // The disc feeds the bloom chain. At 190 with a 0.0165 rad radius it was a
      // ~32 px blob of 190 linear, which survived the prefilter clamp, filled
      // every bloom mip and came out of the tonemap as a flat white smear with
      // no structure. A smaller, less absurd disc still clips to white in the
      // core (120 x 0.62 exposure is 74) but leaves the falloff to the mip
      // chain instead of to the clamp.
      sunIntensity: 120,
      sunAngular: 0.0138,
      // How much wider / dimmer the disc becomes for the IBL bake. A 0.0165 rad
      // disc is a third of a texel on a 256px cube face — it aliases into
      // fireflies. Widening it and dropping the peak keeps roughly the same
      // integrated energy while giving metals a real, resolvable sun blob to
      // reflect (that blob is what draws the chamfer glints).
      //
      // Down from 6.5, which put the baked sun at 5.1 degrees of angular RADIUS
      // — twenty times the real disc, and far too wide a source to draw a
      // chamfer glint with. At 4.0 the blob is 3.2 degrees, still eight texels
      // across on a 256px cube face (so it neither aliases nor fireflies), and
      // `envSunGain` is raised in the same breath to hold widen^2 * gain
      // constant: identical integrated irradiance on every diffuse surface in
      // the level, a tighter and brighter specular on every smooth one. Rough
      // metal cannot tell the difference; smooth metal gets its glint back.
      //
      // NOT a fix for the vista's blown conveyor streak — that was the theory
      // and the measurement refuted it. Halving the blob's solid angle at
      // constant energy moved the frame's above-230 area by 0.1 percentage
      // points (2.15% -> 2.03%), so the streak is not a reflection of this
      // blob. It is the ANALYTIC sun's specular on a near-mirror roughness in
      // the conveyor's material, which lives outside this module.
      envSunWiden: 4.0,
      // Peak radiance of the baked sun blob is `sunIntensity * this`. Paired
      // with `envSunWiden` so that widen^2 * gain stays put (6.5^2 * 0.075 ==
      // 4.0^2 * 0.198): the blob carries the same energy, concentrated.
      envSunGain: 0.198,
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
      /**
       * Lower hemisphere seen only by the IBL bake: sunlit ground bounce.
       * A pale desert under a raking sun is a genuinely strong bounce source —
       * it is what keeps a mech's undersides and shadow-side flank off black,
       * and it is warm, so it also splits temperature against the cool sky fill.
       */
      groundBake: new THREE.Color(0.178, 0.142, 0.100),
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
      density: 0.0029,                 // deck density at `height` (contract field)
      height: 2,                       // deck base altitude, metres (contract field)
      // 0.10 = a 10 m e-folding height. The deck used to e-fold over 17 m,
      // which put its half-density surface above the roof line of most of the
      // level — so it behaved like plain distance fog on the midground instead
      // of like dust lying on the ground. Tightening it is what lets a 120 m
      // structure keep its material read while the plain it stands on still
      // dissolves.
      falloff: 0.115,
      deckColor: new THREE.Color(),
      bandColor: new THREE.Color(),
      // A tight stratum well clear of the deck. The gap of clean air between
      // the two is what makes each of them read as a LAYER instead of as fog.
      //
      // Thinned again, 0.0013 -> 0.0008, and this is the measured fix for the
      // milky midground. The band's optical depth is LINEAR in distance, and
      // from an elevated camera it is linear with a large coefficient: the vista
      // pose sits at y=78, the band at 55 +/- 16, so every sight line down to
      // the plain crosses the stratum near its peak. Simpson over that ray gives
      // 0.30 of full band density *whatever the range*, which at 400 m made the
      // band 44% of the total tau on a structure — more than the deck and the
      // aerial term put together, and carrying the brightest of the three
      // colours. That is the definition of a flat wash: a constant-per-metre
      // veil with a bright terminator. The band still draws its haze line across
      // the towers (that is a HEIGHT effect and survives a density cut); what it
      // no longer does is set the midground's contrast.
      bandDensity: 0.0008,
      bandHeight: 55,
      bandThickness: 16,
      aerialColor: new THREE.Color(),
      // Aerial perspective now carries the far distance almost on its own, and
      // it ramps in with range (see `aerialRamp`) instead of accumulating from
      // the camera. Net effect versus the old numbers: ~40% less veiling at
      // 150-250 m, ~15% more past 700 m.
      //
      // Raised with the ramp pushed out (see `aerialRamp`) so the pair steepens
      // rather than just brightening. Optical depth on this term goes as
      // d^3 / (ramp^2 + d^2): at ramp 520 the 400 m : 800 m : 2000 m tau ratios
      // were 1 : 3.8 : 21, at ramp 1000 they are 1 : 5.7 : 29. The same total
      // extinction on the ridges therefore costs a third as much on the
      // midground, which is the whole trade this term exists to make.
      aerialDensity: 0.0024,
      // Range in metres at which the aerial term reaches half of its full
      // per-metre extinction. Models a clean basin under a distant dust wall:
      // the first couple of hundred metres of air really are clearer than the
      // column out to the ridges. Pushed way out (from 300) now that the ramp
      // in COMPOSITE_FRAG is quadratic and has no floor — the pair moves haze
      // OUT of the 100-250 m midground and into the 600 m+ background, which
      // is where an AC6 frame actually keeps it.
      //
      // 520 -> 1000. Measured on the vista pose (camera y=78, ridges at 2 km):
      // total veiling on a structure at 400 m goes 34.6% -> 22%, on the plain at
      // 800 m 77% -> 69%, and on the ridges 98.8% -> 98.6%. The far distance is
      // unchanged and the midground gets a third of its contrast back. The
      // limiting factor is now the DECK, which is correct — the far ground plane
      // is supposed to dissolve while the things standing on it do not.
      aerialRamp: 1000,
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
    // sun actually rakes through — but much DARKER than it looks like it should
    // be. This is the single value that decides whether the frame reads as milk.
    // Dust lying on the ground is self-shadowing: it is lit by a sun that has
    // already crossed most of the dust column, so its radiance sits well below
    // the sky's. At 0.94 x horizon the deck was brighter than the shadowed sand
    // it was veiling, so every distant surface got LIGHTER as it receded and the
    // whole lower half of the frame collapsed to one pale value.
    p.deckColor.copy(c.horizon).lerp(c.sunTint, 0.10).multiplyScalar(0.64);

    // Smog band: lit from below by the ground bounce, so warmer again — and it
    // sits higher, in cleaner air, so it stays brighter than the deck. That
    // difference is what draws the visible haze line across the towers.
    //
    // 0.86 -> 0.78. It only has to out-run the DECK to draw the line; it must
    // not out-run the shadowed ground it crosses, or the line stops reading as
    // a stratum of dust and starts reading as a bright bar painted over the
    // frame. At 0.86 its luminance was 0.285 against sunlit sand at ~0.25.
    p.bandColor.copy(c.horizon).lerp(c.sunTint, 0.15).multiplyScalar(0.78);

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
      aerialRamp: f.aerialRamp,
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
