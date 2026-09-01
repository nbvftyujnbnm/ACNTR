// Does an InstancedBufferGeometry with INTERLEAVED per-instance attributes at
// non-zero offsets actually reach the vertex shader in this environment?
//
// Every particle batch, the decal batch, the ring batch and the thruster plume
// layer in ParticleSystem.js are built that way. If the construction does not
// work here then nothing in the VFX system has ever rendered, and every VFX
// review in this project was made on frames with no particles in them.
//
// The test renders a full-clip-space quad whose colour comes ONLY from a
// per-instance attribute, into a 32x32 render target, and reads the pixels
// back. Three variants, all otherwise identical:
//   interleaved  — InterleavedBufferAttribute at offsets 0 and 4 (what we ship)
//   separate     — one InstancedBufferAttribute per field
//   uniform      — no instance attributes at all (does ANYTHING draw?)
(() => {
  const { THREE, engine } = window.__ACNTR__;
  const renderer = engine.renderer;
  const out = {};

  const rt = new THREE.WebGLRenderTarget(32, 32, { type: THREE.UnsignedByteType });
  const cam = new THREE.Camera();
  const buf = new Uint8Array(32 * 32 * 4);

  const VERT = `
    attribute vec4 aFoo;
    attribute vec4 aBar;
    varying vec3 vC;
    void main() {
      // Same early-out shape as flameVert / particleVert: a zeroed instance
      // attribute clips every vertex.
      if (aBar.y <= 0.001) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vC = vec3(0.0); return; }
      vC = aFoo.rgb;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`;
  const FRAG = `
    varying vec3 vC;
    void main() { gl_FragColor = vec4(vC, 1.0); }`;
  const UVERT = `
    varying vec3 vC;
    void main() { vC = vec3(0.0, 1.0, 0.0); gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  const quadPos = new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
  ]), 3);
  const quadIdx = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);

  function measure(mesh) {
    const sc = new THREE.Scene();
    sc.add(mesh);
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    renderer.render(sc, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, 32, 32, buf);
    renderer.setRenderTarget(prevRT);
    let r = 0, g = 0, b = 0, lit = 0;
    for (let i = 0; i < buf.length; i += 4) {
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
      if (buf[i] + buf[i + 1] + buf[i + 2] > 8) lit++;
    }
    const n = buf.length / 4;
    return { meanR: +(r / n).toFixed(1), meanG: +(g / n).toFixed(1), meanB: +(b / n).toFixed(1), litFrac: +(lit / n).toFixed(3) };
  }

  // --- 1. interleaved, exactly how ParticleSystem builds every batch --------
  {
    const stride = 8;
    const data = new Float32Array(stride * 2);
    // instance 0: aFoo = (1, 0.25, 0.5, 1), aBar = (0, 1, 0, 0)  -> intensity 1
    data[0] = 1; data[1] = 0.25; data[2] = 0.5; data[3] = 1;
    data[4] = 0; data[5] = 1; data[6] = 0; data[7] = 0;
    const ib = new THREE.InstancedInterleavedBuffer(data, stride);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', quadPos);
    geo.setIndex(quadIdx);
    geo.setAttribute('aFoo', new THREE.InterleavedBufferAttribute(ib, 4, 0));
    geo.setAttribute('aBar', new THREE.InterleavedBufferAttribute(ib, 4, 4));
    geo.instanceCount = 1;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const m = new THREE.Mesh(geo, new THREE.RawShaderMaterial({
      vertexShader: '#version 300 es\n' , fragmentShader: '',
    }));
    // Use ShaderMaterial (three injects the built-ins/precision) rather than raw.
    m.material.dispose();
    m.material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false });
    m.frustumCulled = false;
    out.interleaved = measure(m);
    out.interleaved.expect = 'meanR 255, meanG 64, meanB 128';
  }

  // --- 2. separate InstancedBufferAttributes -------------------------------
  {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', quadPos);
    geo.setIndex(quadIdx);
    geo.setAttribute('aFoo', new THREE.InstancedBufferAttribute(new Float32Array([1, 0.25, 0.5, 1]), 4));
    geo.setAttribute('aBar', new THREE.InstancedBufferAttribute(new Float32Array([0, 1, 0, 0]), 4));
    geo.instanceCount = 1;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false }));
    m.frustumCulled = false;
    out.separate = measure(m);
  }

  // --- 3. no instance attributes at all ------------------------------------
  {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', quadPos);
    geo.setIndex(quadIdx);
    const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: UVERT, fragmentShader: FRAG, depthTest: false, depthWrite: false }));
    m.frustumCulled = false;
    out.plain = measure(m);
    out.plain.expect = 'meanG 255';
  }

  // --- 4. the REAL particle geometry, drawn with a debug material ----------
  // Same geometry object the shipped batch uses, so any attribute-layout
  // problem in it shows up here. Colour is taken straight from aCol0.
  {
    const ps = window.__ACNTR__.game?.vfx?.ps;
    if (ps) {
      const b = ps.batches[0];
      const dbgVert = `
        attribute vec4 aPosBirth;
        attribute vec4 aCol0;
        varying vec3 vC;
        void main() {
          vC = clamp(aCol0.rgb, 0.0, 1.0);
          if (aPosBirth.w == 0.0 && aCol0.a == 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
          gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
        }`;
      const dbg = new THREE.ShaderMaterial({ vertexShader: dbgVert, fragmentShader: FRAG, depthTest: false, depthWrite: false });
      const m = new THREE.Mesh(b.geometry, dbg);
      m.frustumCulled = false;
      const savedCount = b.geometry.instanceCount;
      out.realGeoInstanceCount = savedCount;
      out.realGeoHigh = b.high;
      out.realGeoDrawn = measure(m);
      b.geometry.instanceCount = savedCount;
      m.geometry = null;
      dbg.dispose();
    } else {
      out.realGeo = 'no particle system';
    }
  }

  out.glVersion = renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1';
  out.maxVertexAttribs = renderer.getContext().getParameter(renderer.getContext().MAX_VERTEX_ATTRIBS);
  const dbgInfo = renderer.getContext().getExtension('WEBGL_debug_renderer_info');
  if (dbgInfo) out.gpu = renderer.getContext().getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL);
  rt.dispose();
  return out;
})()
