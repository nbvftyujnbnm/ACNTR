// Does the plume survive the RENDER PIPELINE?
//
// tools/probes/flamepix.js proved the flame meshes rasterise: rendered into a
// plain LDR target with a camera pointed at them they light 3.7% of it with
// saturated cores. But a full capture with four plumes at intensity 4, on
// screen at known NDC, instanceCount 4 and both meshes visible shows not one
// blue pixel. So the difference is the pipeline, and this measures it directly:
// one synchronous frame at a time, reading the drawing buffer back and diffing
// the same rectangle with the flame layer on and off.
(async () => {
  const { debug, game, engine, THREE } = window.__ACNTR__;
  const renderer = engine.renderer;
  const gl = renderer.getContext();
  const out = {};

  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();
  debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 120 });
  debug.step(0.5);

  game._plumes = null;
  const force = () => {
    for (const f of (game.vfx?._flames || [])) { f.intensity = 4; f.target = 4; f.radius = 1.0; f.length = 6; }
  };
  force();
  debug.step(0.05);
  debug.cameraBehindPlayer({ back: 9.0, up: 3.2, side: 7.0, lookY: 5.4, fov: 40 });
  debug.step(0.05);
  force();

  const cam = engine.camera;
  const ps = game.vfx.ps;
  const f0 = game.vfx._flames[0];
  const mid = f0.pos.clone().addScaledVector(f0.dirW, f0.length * 0.5);
  const ndc = mid.clone().project(cam);

  // Drawing-buffer pixel coords (readPixels origin is bottom-left).
  const bw = gl.drawingBufferWidth;
  const bh = gl.drawingBufferHeight;
  const px = Math.round((ndc.x * 0.5 + 0.5) * bw);
  const py = Math.round((ndc.y * 0.5 + 0.5) * bh);
  const R = 60;
  const x0 = Math.max(0, Math.min(bw - 1, px - R));
  const y0 = Math.max(0, Math.min(bh - 1, py - R));
  const w = Math.min(R * 2, bw - x0);
  const h = Math.min(R * 2, bh - y0);
  const buf = new Uint8Array(w * h * 4);
  out.region = { bw, bh, px, py, x0, y0, w, h, ndc: [+ndc.x.toFixed(3), +ndc.y.toFixed(3), +ndc.z.toFixed(3)] };

  function frameAndRead() {
    force();
    engine.frame(performance.now() + 16);
    renderer.setRenderTarget(null);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, max = 0;
    const n = w * h;
    for (let i = 0; i < buf.length; i += 4) {
      const v = buf[i] + buf[i + 1] + buf[i + 2];
      sum += v;
      if (v > max) max = v;
    }
    return { mean: +(sum / n / 3).toFixed(2), max };
  }

  // Warm two frames so TAA history is settled before anything is compared.
  frameAndRead(); frameAndRead();

  out.on = frameAndRead();
  ps.flameInner.visible = false;
  ps.flameOuter.visible = false;
  out.off = frameAndRead();
  ps.flameInner.visible = true;
  ps.flameOuter.visible = true;
  out.onAgain = frameAndRead();
  out.deltaMean = +(out.on.mean - out.off.mean).toFixed(2);

  // --- pipeline out of the way ---------------------------------------------
  // renderer.render(scene, camera) straight to the canvas, no post at all.
  const savedPipe = engine.pipeline;
  engine.pipeline = null;
  frameAndRead();
  out.rawWithFlames = frameAndRead();
  ps.flameInner.visible = false;
  ps.flameOuter.visible = false;
  out.rawWithout = frameAndRead();
  ps.flameInner.visible = true;
  ps.flameOuter.visible = true;
  engine.pipeline = savedPipe;
  out.rawDelta = +(out.rawWithFlames.mean - out.rawWithout.mean).toFixed(2);

  // --- soft-depth fade off --------------------------------------------------
  game.vfx.setDepthTexture(null);
  frameAndRead();
  out.noSoft = frameAndRead();
  ps.flameInner.visible = false;
  ps.flameOuter.visible = false;
  out.noSoftOff = frameAndRead();
  ps.flameInner.visible = true;
  ps.flameOuter.visible = true;
  out.noSoftDelta = +(out.noSoft.mean - out.noSoftOff.mean).toFixed(2);
  out.softParams = Array.from(ps.softUniform.value.toArray());

  out.state = {
    instanceCount: ps._flameGeo.instanceCount,
    innerVisible: ps.flameInner.visible,
    flames: game.vfx._flames.length,
    innerRenderOrder: ps.flameInner.renderOrder,
    innerBlending: ps.flameInner.material.blending,
    innerTransparent: ps.flameInner.material.transparent,
    innerDepthTest: ps.flameInner.material.depthTest,
    groupVisible: ps.group.visible,
    groupParent: ps.group.parent?.type || null,
    uTime: ps.timeUniform.value,
    programUsed: (() => {
      // Did three actually compile a program for this material?
      const p = renderer.info.programs || [];
      return p.filter((q) => q.cacheKey && q.usedTimes > 0).length;
    })(),
  };
  return out;
})()
