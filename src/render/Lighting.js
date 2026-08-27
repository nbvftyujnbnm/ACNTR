import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp } from '../core/MathUtils.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

/** Only one Lighting is ever live; the pipeline pokes it through this. */
let _active = null;

/** Module-scope scratch — the frame path must not allocate. */
const _fillDir = new THREE.Vector3();

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
      // A 17-degree sun delivers only sin(17) = 0.29 of its normal irradiance
      // to horizontal ground, so the key has to be scaled UP hard to stay
      // dominant there. At 3.15 the ground's sun term and its ambient term were
      // within a factor of ~1.2 of each other, which is why the shadows the
      // cascades were correctly rendering could not be seen at all in frame.
      // Lit ground : shadowed ground is now roughly 3.5 : 1.
      sunIntensity: 11.0,
      hemiIntensity: 0.10,
      // Every mech surface is metalness 1.0, so it is lit ENTIRELY by the
      // environment — diffuse is identically zero. At 1.0 the PMREM was too
      // dim to show a single panel seam.
      envIntensity: 2.2,
      // Cool bounce from the opposite side so the shadow side stays readable.
      // AC6 shadows are deep but never crushed; this is what keeps them open.
      fillIntensity: 0.62,
      cascades: 4,
      shadowMapSize: 2048,
      // The camera's near plane is 0.35 m, which drags every automatic split
      // scheme into uselessness: 'practical' put the first cascade break at
      // 79 m, so a 9 m mech got 2 cm... of a 180 m cascade. Explicit splits,
      // tuned for a mech-scale subject with a city-scale background.
      shadowMaxFar: 460,
      splits: [22, 66, 170, 460],
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

    /** @type {THREE.DirectionalLight|null} shadowless bounce/fill */
    this.fill = null;

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
   * A single shadowless directional bounce, opposite and above the key.
   *
   * ORDER MATTERS: three indexes `directionalShadow[]` by a light's position in
   * the full directional list, then truncates that list to the shadow count. A
   * non-shadow directional light added *before* the cascades therefore shifts
   * every cascade's shadow map by one and drops the last one entirely. It has
   * to be added after the CSM lights, so this re-adds it whenever CSM is built.
   */
  _ensureFill() {
    if (this.fill) {
      this.scene.remove(this.fill);
      this.scene.remove(this.fill.target);
    } else {
      this.fill = new THREE.DirectionalLight(0xffffff, this.params.fillIntensity);
      this.fill.name = 'ACNTR.Bounce';
      this.fill.castShadow = false;
    }
    this.scene.add(this.fill);
    this.scene.add(this.fill.target);
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

    const f = this.fill;
    if (f) {
      // Sky-coloured, from the anti-sun side and higher up: this is skylight
      // bounced back into the shadow side, not a second key. Keep it cool so
      // the shadow/key split also reads as a temperature split.
      _fillDir.copy(this._sunDir).multiplyScalar(-1);
      _fillDir.y = Math.abs(_fillDir.y) + 0.85;
      _fillDir.normalize();
      f.position.copy(this._focus).addScaledVector(_fillDir, 220);
      f.target.position.copy(this._focus);
      f.target.updateMatrixWorld();
      if (this.sky?.skyFillColor) f.color.copy(this.sky.skyFillColor);
      // The sky fill colour is a radiance, not a hue — renormalise so the knob
      // controls intensity and the colour only carries the tint.
      const m = Math.max(f.color.r, f.color.g, f.color.b, 1e-4);
      f.color.multiplyScalar(1 / m);
      f.intensity = this.params.fillIntensity;
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
    this.scene.remove(this.hemi);
    this.hemi.dispose?.();
    this.sun = null;
    this.sunLights = [];
  }
}
