// Does the FLAME LAYER rasterise any pixels, and if not, at which stage does it
// stop? Renders the shipped flame meshes into a 128x128 render target with a
// camera pointed straight at a synthetic plume, three ways:
//   A) the real flameInner/flameOuter materials
//   B) a debug material that IGNORES every instance attribute (tests geometry,
//      index buffer and instanceCount alone)
//   C) a debug material that colours by aParams / aOrigin / aAxis (tests whether
//      the per-instance attributes reach the vertex shader at all)
// The quad-particle path is known to render, so anything that fails here is
// specific to this geometry or this shader.
(() => {
  const { THREE, engine, game } = window.__ACNTR__;
  const renderer = engine.renderer;
  const ps = game.vfx.ps;
  const out = {};

  // --- plant one plume at a known place, firing along +X --------------------
  const ORIGIN = new THREE.Vector3(0, 40, 0);
  const AXIS = new THREE.Vector3(1, 0, 0);
  const d = ps.flameData;
  d.fill(0);
  d[0] = ORIGIN.x; d[1] = ORIGIN.y; d[2] = ORIGIN.z; d[3] = 0.31;   // seed
  d[4] = AXIS.x; d[5] = AXIS.y; d[6] = AXIS.z; d[7] = 4.0;          // length 4 m
  d[8] = 0.55;                                                       // radius
  d[9] = 1.0;                                                        // intensity
  d[10] = 0.85;                                                      // temperature
  d[11] = 3.7;                                                       // phase
  ps.setFlameInstances(1);

  // --- camera looking at the plume side-on ---------------------------------
  const cam = new THREE.PerspectiveCamera(45, 1, 0.5, 500);
  cam.position.set(2.0, 40 + 1.5, 9.0);
  cam.lookAt(2.0, 40, 0);
  cam.updateMatrixWorld(true);

  const SZ = 128;
  const rt = new THREE.WebGLRenderTarget(SZ, SZ, { type: THREE.UnsignedByteType });
  const buf = new Uint8Array(SZ * SZ * 4);

  function shoot(objects, clearCol = 0x000000) {
    const sc = new THREE.Scene();
    for (const o of objects) sc.add(o);
    const prevRT = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(clearCol, 1);
    renderer.clear(true, true, true);
    renderer.render(sc, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, SZ, SZ, buf);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);
    let sum = 0, lit = 0, max = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const v = buf[i] + buf[i + 1] + buf[i + 2];
      sum += v;
      if (v > 12) lit++;
      if (v > max) max = v;
    }
    const n = buf.length / 4;
    return { mean: +(sum / n / 3).toFixed(2), litFrac: +(lit / n).toFixed(4), maxSum: max };
  }

  // Meshes must be detached from the VFX group before being added to a temp
  // scene, then put back.
  const grp = ps.group;
  const inner = ps.flameInner;
  const outer = ps.flameOuter;
  grp.remove(inner, outer);

  const savedMatI = inner.material;
  const savedMatO = outer.material;

  // --- A) as shipped -------------------------------------------------------
  inner.visible = true; outer.visible = true;
  inner.updateMatrixWorld(true); outer.updateMatrixWorld(true);
  out.A_shipped = shoot([outer, inner]);

  // --- B) geometry only, no instance attributes read ------------------------
  const FRAG = 'precision highp float; varying vec3 vC; void main(){ gl_FragColor = vec4(vC, 1.0); }';
  const bVert = `
    varying vec3 vC;
    void main() {
      // Ignore every instance attribute: a fixed 1 m ring at the known origin.
      vec3 wp = vec3(0.0, 40.0, 0.0) + vec3(position.x * 0.6, position.y * 0.6, 0.0) + vec3(position.z * 4.0, 0.0, 0.0);
      vC = vec3(0.2, 1.0, 0.2);
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }`;
  const matB = new THREE.ShaderMaterial({ vertexShader: bVert, fragmentShader: FRAG, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
  inner.material = matB;
  out.B_geometryOnly = shoot([inner]);
  out.B_expect = 'litFrac > 0 if the geometry, index and instanceCount are sound';

  // --- C) read the instance attributes -------------------------------------
  const cVert = `
    attribute vec4 aOrigin;
    attribute vec4 aAxis;
    attribute vec4 aParams;
    varying vec3 vC;
    void main() {
      // Position from aOrigin/aAxis exactly as flameVert does, but WITHOUT the
      // early-out, and colour by the attribute values so a zero reads black.
      vec3 z = normalize(aAxis.xyz);
      vec3 ref = abs(z.y) < 0.985 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 x = normalize(cross(ref, z));
      vec3 y = cross(z, x);
      vec3 wp = aOrigin.xyz + x * (position.x * aParams.x) + y * (position.y * aParams.x) + z * (position.z * aAxis.w);
      vC = vec3(aParams.y, aParams.x, aAxis.w * 0.25);
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }`;
  const matC = new THREE.ShaderMaterial({ vertexShader: cVert, fragmentShader: FRAG, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
  inner.material = matC;
  out.C_attributes = shoot([inner]);
  out.C_expect = 'R=255 (intensity 1), G=140 (radius .55), B=255 (length 4) if attributes arrive';

  // --- D) the real vertex shader, real material, but opaque + no depth ------
  inner.material = savedMatI;
  const clone = savedMatI.clone();
  clone.uniforms = savedMatI.uniforms;   // share, so uTime is live
  clone.blending = THREE.NormalBlending;
  clone.transparent = false;
  clone.depthTest = false;
  clone.depthWrite = false;
  inner.material = clone;
  out.D_realShaderOpaque = shoot([inner]);

  inner.material = savedMatI;
  outer.material = savedMatO;
  grp.add(outer, inner);
  matB.dispose(); matC.dispose(); clone.dispose(); rt.dispose();

  // --- state snapshot ------------------------------------------------------
  const g = ps._flameGeo;
  out.state = {
    instanceCount: g.instanceCount,
    maxInstanceCount: g._maxInstanceCount === undefined ? 'undefined' : g._maxInstanceCount,
    indexCount: g.index ? g.index.count : null,
    posCount: g.attributes.position ? g.attributes.position.count : null,
    attrs: Object.keys(g.attributes),
    aParamsOffset: g.attributes.aParams?.offset,
    aParamsItemSize: g.attributes.aParams?.itemSize,
    bufferStride: g.attributes.aParams?.data?.stride,
    bufferCount: g.attributes.aParams?.data?.count,
    meshPerAttribute: g.attributes.aParams?.data?.meshPerAttribute,
    isInstancedInterleaved: !!g.attributes.aParams?.data?.isInstancedInterleavedBuffer,
    innerVisible: inner.visible,
    outerVisible: outer.visible,
    innerParent: inner.parent?.name || null,
    data12: Array.from(ps.flameData.slice(0, 12)),
    programs: renderer.info.programs?.length ?? null,
  };
  return out;
})()
