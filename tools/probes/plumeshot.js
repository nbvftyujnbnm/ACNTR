// Does the plume produce pixels in a REAL pipeline frame, and if not, why?
//
// The previous attempt (plumeframe.js) measured nothing: it trusted
// `cameraBehindPlayer` to frame the exhaust and the plume midpoint came back at
// NDC (-2.57, 1.80) — off screen — so it diffed a 120x1 strip of sky at the
// corner of the frame. Never diff a region you have not proved is on screen.
//
// This one pins the camera BY CONSTRUCTION: it reads plume 0's world position
// and axis out of the live handle, puts the lens 6 m off to the side of the
// plume's midpoint, and looks straight at it. Then it renders single frames
// synchronously and reads the drawing buffer back, toggling one variable at a
// time:
//   on/off          flame meshes visible vs not, full pipeline
//   raw             same, with engine.pipeline detached (no post at all)
//   soft            same, with the soft-depth fade forced off
//   glError         gl.getError() after each frame — a feedback loop between
//                   the bound framebuffer's depth attachment and a sampled
//                   texture shows up here as INVALID_OPERATION (1282)
//   tris            renderer.info.render.triangles, which counts SUBMITTED
//                   geometry whether or not it rasterises
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

  // Detach the per-frame driver, or it resets the intensity we force.
  game._plumes = null;
  const force = () => {
    for (const f of (game.vfx?._flames || [])) {
      f.intensity = 3; f.target = 3; f.radius = 1.0; f.length = 6;
    }
  };
  force();
  debug.step(0.05);
  force();

  const f0 = game.vfx._flames[0];
  const ps = game.vfx.ps;
  const mid = f0.pos.clone().addScaledVector(f0.dirW, f0.length * 0.5);

  // Look at the plume from 90 degrees off its axis — a cone aimed at the lens
  // projects as a disc and flameFrag weights alpha by fresnel, so head-on is
  // its dimmest view.
  const up = new THREE.Vector3(0, 1, 0);
  let side = new THREE.Vector3().crossVectors(f0.dirW, up);
  if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
  side.normalize();
  const eye = mid.clone().addScaledVector(side, 7).addScaledVector(up, 1.2);
  debug.setCamera(eye, mid, 32);
  debug.step(0.05);
  force();

  const cam = engine.camera;
  cam.updateMatrixWorld(true);
  const ndc = mid.clone().project(cam);
  const bw = gl.drawingBufferWidth;
  const bh = gl.drawingBufferHeight;
  const px = Math.round((ndc.x * 0.5 + 0.5) * bw);
  const py = Math.round((ndc.y * 0.5 + 0.5) * bh);
  const R = 90;
  const x0 = Math.max(0, Math.min(bw - 1, px - R));
  const y0 = Math.max(0, Math.min(bh - 1, py - R));
  const w = Math.max(1, Math.min(R * 2, bw - x0));
  const h = Math.max(1, Math.min(R * 2, bh - y0));
  const buf = new Uint8Array(w * h * 4);
  out.region = {
    bw, bh, px, py, x0, y0, w, h,
    ndc: [+ndc.x.toFixed(3), +ndc.y.toFixed(3), +ndc.z.toFixed(3)],
    onScreen: Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1,
  };
  out.plume = {
    pos: f0.pos.toArray().map((v) => +v.toFixed(2)),
    dir: f0.dirW.toArray().map((v) => +v.toFixed(3)),
    mid: mid.toArray().map((v) => +v.toFixed(2)),
    eye: eye.toArray().map((v) => +v.toFixed(2)),
    dist: +eye.distanceTo(mid).toFixed(2),
    intensity: f0.intensity,
  };

  function shot() {
    force();
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    engine.frame(performance.now() + 16);
    const err = gl.getError();
    const tris = renderer.info.render.triangles;
    renderer.setRenderTarget(null);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, max = 0, blue = 0;
    const n = w * h;
    for (let i = 0; i < buf.length; i += 4) {
      const v = buf[i] + buf[i + 1] + buf[i + 2];
      sum += v;
      if (v > max) max = v;
      if (buf[i + 2] > buf[i] + 24) blue++;
    }
    return { mean: +(sum / n / 3).toFixed(2), max, blueFrac: +(blue / n).toFixed(4), tris, glError: err };
  }

  const setFlames = (v) => { ps.flameInner.visible = v; ps.flameOuter.visible = v; };

  shot(); shot();                       // warm TAA history

  out.softParamsAsShipped = Array.from(ps.softUniform.value.toArray());
  out.depthIsSceneTarget = ps.depthUniform.value === game.pipeline?.rtScene?.depthTexture;
  out.depthIsDummy = ps.depthUniform.value === ps._dummyDepth;

  out.on = shot();
  setFlames(false); out.off = shot();
  setFlames(true);  out.onAgain = shot();
  out.delta = +(out.on.mean - out.off.mean).toFixed(2);
  out.deltaTris = out.on.tris - out.off.tris;

  // --- soft fade forced off ------------------------------------------------
  const savedSoft = ps.softUniform.value.clone();
  ps.softUniform.value.x = 0;
  shot();
  out.noSoftOn = shot();
  setFlames(false); out.noSoftOff = shot();
  setFlames(true);
  out.noSoftDelta = +(out.noSoftOn.mean - out.noSoftOff.mean).toFixed(2);
  ps.softUniform.value.copy(savedSoft);

  // --- no post at all ------------------------------------------------------
  const savedPipe = engine.pipeline;
  engine.pipeline = null;
  shot();
  out.rawOn = shot();
  setFlames(false); out.rawOff = shot();
  setFlames(true);
  out.rawDelta = +(out.rawOn.mean - out.rawOff.mean).toFixed(2);
  engine.pipeline = savedPipe;

  out.state = {
    instanceCount: ps._flameGeo.instanceCount,
    flames: game.vfx._flames.length,
    innerVisible: ps.flameInner.visible,
    groupVisible: ps.group.visible,
    data12: Array.from(ps.flameData.slice(0, 12)).map((v) => +v.toFixed(3)),
    resolutionScale: engine.resolutionScale,
  };
  return out;
})()
