import * as THREE from 'three';
import { bus, EV } from './EventBus.js';
import { clamp } from './MathUtils.js';

/**
 * Engine owns the WebGL context, the frame loop and the global clock.
 * It knows nothing about gameplay. Rendering beyond `renderer.render` is
 * delegated to a pipeline object supplied via `setPipeline()`.
 */
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // pipeline handles AA (TAA/SMAA)
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    renderer.debug.checkShaderErrors = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = false;
    this.renderer = renderer;

    this.maxPixelRatio = 2;
    this.pixelRatio = clamp(window.devicePixelRatio || 1, 1, this.maxPixelRatio);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.35, 6000);
    this.camera.position.set(0, 12, 24);

    this.pipeline = null;

    // --- timing -----------------------------------------------------------
    this.clock = { elapsed: 0, dt: 0, raw: 0, frame: 0 };
    this.timeScale = 1;
    this._hitstop = 0;
    this._last = performance.now();
    this._running = false;
    this._updaters = [];
    this._lateUpdaters = [];
    this._rafId = 0;

    // rolling perf stats for adaptive resolution
    this.fps = 60;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.adaptiveResolution = true;
    this.resolutionScale = 1;
    this._adaptCooldown = 0;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._last = performance.now();
    });

    bus.on(EV.HITSTOP, (d) => {
      this._hitstop = Math.max(this._hitstop, typeof d === 'number' ? d : d?.duration || 0.05);
    });

    this.resize();
  }

  setPipeline(pipeline) {
    this.pipeline = pipeline;
    this.resize();
  }

  /** fn(dt, elapsed) — gameplay tick */
  addUpdate(fn) {
    this._updaters.push(fn);
    return () => {
      const i = this._updaters.indexOf(fn);
      if (i >= 0) this._updaters.splice(i, 1);
    };
  }
  /** fn(dt, elapsed) — runs after all updates, before render (camera, HUD) */
  addLateUpdate(fn) {
    this._lateUpdaters.push(fn);
    return () => {
      const i = this._lateUpdaters.indexOf(fn);
      if (i >= 0) this._lateUpdaters.splice(i, 1);
    };
  }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.width = w;
    this.height = h;
    this.pixelRatio = clamp(window.devicePixelRatio || 1, 1, this.maxPixelRatio) * this.resolutionScale;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pipeline?.setSize?.(w, h, this.pixelRatio);
    bus.emit('engine:resize', { width: w, height: h, pixelRatio: this.pixelRatio });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    const tick = (now) => {
      this._rafId = requestAnimationFrame(tick);
      this.frame(now);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._rafId);
  }

  frame(now) {
    const raw = Math.min((now - this._last) / 1000, 0.1); // clamp huge stalls
    this._last = now;

    // fps tracking
    this._fpsAccum += raw;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
      this._adaptResolution();
    }

    let scale = this.timeScale;
    if (this._hitstop > 0) {
      this._hitstop -= raw;
      scale *= 0.04; // near-freeze impact frames
    }
    const dt = raw * scale;

    this.clock.raw = raw;
    this.clock.dt = dt;
    this.clock.elapsed += dt;
    this.clock.frame++;

    for (let i = 0; i < this._updaters.length; i++) this._updaters[i](dt, this.clock.elapsed, raw);
    for (let i = 0; i < this._lateUpdaters.length; i++) this._lateUpdaters[i](dt, this.clock.elapsed, raw);

    this.renderer.info.reset();
    if (this.pipeline) this.pipeline.render(dt, this.clock.elapsed);
    else this.renderer.render(this.scene, this.camera);
  }

  _adaptResolution() {
    if (!this.adaptiveResolution) return;
    if (this._adaptCooldown > 0) {
      this._adaptCooldown--;
      return;
    }
    const target = 58;
    if (this.fps < target - 12 && this.resolutionScale > 0.62) {
      this.resolutionScale = Math.max(0.62, this.resolutionScale - 0.1);
      this._adaptCooldown = 4;
      this.resize();
    } else if (this.fps > target + 12 && this.resolutionScale < 1) {
      this.resolutionScale = Math.min(1, this.resolutionScale + 0.06);
      this._adaptCooldown = 6;
      this.resize();
    }
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
