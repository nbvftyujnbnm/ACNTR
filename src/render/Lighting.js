import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp } from '../core/MathUtils.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

/** Only one Lighting is ever live; the pipeline pokes it through this. */
let _active = null;

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
      sunIntensity: 3.15,
      hemiIntensity: 0.55,
      envIntensity: 1.0,
      cascades: 4,
      shadowMapSize: 2048,
      shadowMaxFar: 620,
      lightNear: 1,
      lightFar: 3000,
      lightMargin: 260,
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
      mode: 'practical',
      shadowMapSize: p.shadowMapSize,
      shadowBias: -0.00008,
      lightDirection: this._lightDir.copy(this._sunDir).multiplyScalar(-1).normalize(),
      lightIntensity: p.sunIntensity,
      lightNear: p.lightNear,
      lightFar: p.lightFar,
      lightMargin: p.lightMargin,
    });
    this.csm.fade = p.fade;
    this.csm.updateFrustums();

    this.sunLights = this.csm.lights;
    this.sun = this.csm.lights[0];
    for (let i = 0; i < this.sunLights.length; i++) {
      this.sunLights[i].name = `ACNTR.SunCascade${i}`;
    }
    this._tuneShadows();
    this._applySunColor();
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

      l.shadow.normalBias = clamp(texel * 1.6, 0.015, 0.5);
      l.shadow.bias = -(texel * 2.5) / depthRange - 0.00002;
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
    if (sky.skyFillColor) this.hemi.color.copy(sky.skyFillColor);
    if (sky.groundFillColor) this.hemi.groundColor.copy(sky.groundFillColor);
    this.hemi.intensity = this.params.hemiIntensity;
  }

  _applySunColor() {
    const col = this.sky?.sunColor;
    for (let i = 0; i < this.sunLights.length; i++) {
      const l = this.sunLights[i];
      if (col) l.color.copy(col);
      l.intensity = this.params.sunIntensity;
    }
  }

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {THREE.Vector3} [focusPos] player position; re-centres the fallback
   *        shadow frustum (CSM re-centres itself off the camera frustum).
   */
  update(dt, elapsed, focusPos) {
    this._ensureSun();
    this._syncFromSky();
    this._applySunColor();

    if (focusPos) this._focus.copy(focusPos);

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
    this.scene.remove(this.hemi);
    this.hemi.dispose?.();
    this.sun = null;
    this.sunLights = [];
  }
}
