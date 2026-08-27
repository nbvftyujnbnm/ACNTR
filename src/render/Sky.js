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
      sunElevation: 13.5 * (Math.PI / 180),   // low, harsh, raking light
      sunAzimuth: 2.34,
      sunSpeed: 0,                            // radians/sec of azimuth drift
      windSpeed: 1.0,
      hazeFalloff: 4.1,
      mieStrength: 0.95,
      mieG: 0.77,
      rayleigh: 0.42,
      sunIntensity: 110,
      sunAngular: 0.0165,
      cloudCover: 0.54,
      cloudOpacity: 0.88,
      cloudScale: 0.62,
      bandStrength: 0.62,
      dither: 0.006,
      bakeInterval: 7.0,
    };

    // --- palette (linear radiance, pre-tonemap) ---------------------------
    this.colors = {
      zenith: new THREE.Color(0.150, 0.196, 0.277),
      horizon: new THREE.Color(1.020, 0.792, 0.532),
      ground: new THREE.Color(0.086, 0.074, 0.063),
      sunTint: new THREE.Color(1.000, 0.596, 0.288),
      sunDisc: new THREE.Color(1.000, 0.860, 0.680),
      cloudDark: new THREE.Color(0.170, 0.170, 0.182),
      cloudLit: new THREE.Color(0.960, 0.860, 0.720),
    };

    /** @type {THREE.Vector3} normalised, points FROM origin TOWARD the sun */
    this.sunDirection = new THREE.Vector3();
    /** @type {THREE.Color} warm ochre key-light colour */
    this.sunColor = new THREE.Color();
    /** @type {THREE.Color} cool sky fill colour, for the hemisphere light */
    this.skyFillColor = new THREE.Color();
    /** @type {THREE.Color} ground bounce colour */
    this.groundFillColor = new THREE.Color();

    this.fogParams = {
      color: new THREE.Color(),
      density: 0.0030,
      height: 34,        // metres — above this the low dust layer thins out
      falloff: 0.028,    // 1/metres for the height term used by the post fog
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
    const f = this.fogParams.color;

    // Horizon-weighted: the fog has to terminate into the same colour the sky
    // shows at the horizon or distant geometry visibly "cuts out" against it.
    f.setRGB(
      c.horizon.r * 0.70 + c.zenith.r * 0.30,
      c.horizon.g * 0.70 + c.zenith.g * 0.30,
      c.horizon.b * 0.70 + c.zenith.b * 0.30
    );
    f.multiplyScalar(0.82);

    if (!this.scene.fog) {
      this.scene.fog = new THREE.FogExp2(f.getHex(), this.fogParams.density);
    }
    this.scene.fog.color.copy(f);
    this.scene.fog.density = this.fogParams.density;

    this.skyFillColor.copy(c.zenith).lerp(c.horizon, 0.35);
    this.groundFillColor.copy(c.ground).lerp(c.horizon, 0.22);
  }

  _emitParams() {
    // The post stack needs the atmosphere description for its height-fog and
    // aerial-perspective term. Bus rather than a direct import so neither
    // module has to know the other exists.
    bus.emit('sky:params', {
      sunDirection: this.sunDirection,
      sunColor: this.sunColor,
      fogColor: this.fogParams.color,
      fogSunColor: this.colors.sunTint,
      fogDensity: this.fogParams.density,
      fogHeight: this.fogParams.height,
      fogFalloff: this.fogParams.falloff,
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

    // Tame the disc for the IBL: a 110x sun in a 256px cube face is a firefly
    // generator that puts a hard white dot on every metal surface.
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
    this.scene.background = this.environment;
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
    if (this.scene.background === this.environment) this.scene.background = null;
    this.environment = null;
  }
}
