import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { clamp, damp, DEG } from '../core/MathUtils.js';
import * as W from './Widgets.js';

/**
 * Garage — AC assembly screen.
 *
 * Layout: slot list (left) / live 3D preview (centre) / salvage inventory with
 * stat deltas (right) / build-constraint readout (bottom).
 *
 * ── How the 3D preview is rendered ──────────────────────────────────────────
 * No second WebGL context and no renderer surgery. A "stage" group is added to
 * the live scene on a **dedicated render layer** (7) and the camera's layer
 * mask is switched to that layer while the garage is open. The existing
 * RenderPipeline therefore draws *only* the preview — mech, studio lights,
 * floor ring and gradient backdrop — through the game's post stack, so the
 * mech gets the same bloom/grade/tone-mapping it has in combat, with the
 * scene's PMREM environment still providing image-based lighting.
 *
 * The stage is re-anchored to the camera transform every frame and offset in
 * camera space so the mech lands exactly inside the centre panel's rect, at
 * any aspect ratio. Restoring the camera's saved layer mask on close puts the
 * world back with no other state touched.
 */

const GARAGE_LAYER = 7;

const SLOTS = [
  ['head', 'Head'],
  ['core', 'Core'],
  ['arms', 'Arms'],
  ['legs', 'Legs'],
  ['booster', 'Booster'],
  ['generator', 'Generator'],
  ['rArm', 'R-Arm Unit'],
  ['lArm', 'L-Arm Unit'],
  ['rShoulder', 'R-Shoulder'],
  ['lShoulder', 'L-Shoulder'],
];

const STAT_DENY = new Set(['seed', 'price', 'value', 'index', 'count', 'qty', 'id', 'icon', 'slot', 'name', 'rarity', 'level']);

const _off = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _ctr = new THREE.Vector3();

/** camelCase / snake_case → "SPACED LABEL" */
const _humanCache = new Map();
function humanize(k) {
  let v = _humanCache.get(k);
  if (v) return v;
  v = String(k)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toUpperCase();
  _humanCache.set(k, v);
  return v;
}

function fmtNum(n) {
  if (!isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a >= 1000) return String(Math.round(n));
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function fmtDelta(n) {
  if (!isFinite(n) || Math.abs(n) < 1e-6) return '±0';
  return (n > 0 ? '+' : '') + fmtNum(n);
}

/** Best-effort extraction of a part's numeric stat block. */
function statBag(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.stats && typeof part.stats === 'object') return part.stats;
  if (part.mods && typeof part.mods === 'object') return part.mods;
  if (part.props && typeof part.props === 'object') return part.props;
  return part;
}

function partName(p) {
  if (!p) return null;
  return p.name || p.displayName || p.label || p.id || null;
}

export class Garage {
  /**
   * @param {HTMLElement} rootEl #ui-root
   * @param {object} game
   */
  constructor(rootEl, game) {
    this.game = game;
    this.parent = rootEl || document.body;
    this.opened = false;

    this.filter = 'all';
    this.sort = 'tier';
    this.selIndex = 0;
    this.selSlot = 'head';
    this.hovered = null;
    this.spin = 0.6;
    this.spinVel = 0;
    this.zoom = 1;
    this.zoomShown = 1;
    this.dragging = false;
    this.dragX = 0;
    this._listDirty = true;
    this._modelDirty = true;
    this._statsT = 0;
    this._rows = [];
    this._cmpRows = [];
    this._savedLayerMask = null;
    this._savedDof = null;

    this._buildDom();
    this._bind();
  }

  // =========================================================================
  // DOM
  // =========================================================================

  _buildDom() {
    const root = document.createElement('div');
    root.className = 'acntr-garage';
    root.innerHTML = `
      <div class="g-head">
        <span class="t">Assembly</span>
        <span class="s">AC // NIGHTFALL — Field Reconfiguration</span>
        <span class="close" data-a="close">[ ESC ] Disengage</span>
      </div>

      <div class="g-col left">
        <div class="ch"><span>Frame</span><em>10 Units</em></div>
        <div class="g-scroll slots"></div>
      </div>

      <div class="g-col mid">
        <div class="g-view">
          <span class="cn a"></span><span class="cn b"></span><span class="cn c"></span><span class="cn d"></span>
          <div class="vlab">AC Assembly // Live Preview</div>
          <div class="vspec"></div>
        </div>
      </div>

      <div class="g-col right">
        <div class="ch"><span>Salvage</span><em data-k="sortlab">SORT: TIER</em></div>
        <div class="g-filters"></div>
        <div class="g-scroll items"></div>
        <div class="g-cmp"><div class="hd">Comparison</div><div class="rows"></div></div>
      </div>

      <div class="g-foot">
        <div class="g-loads">
          <div class="g-load" data-l="wt"><span class="k">Weight</span><div class="bar"><i class="fill"></i><b class="seg" style="--seg:13px"></b></div><span class="v">0 / 0</span></div>
          <div class="g-load" data-l="arm"><span class="k">Arms Load</span><div class="bar"><i class="fill"></i><b class="seg" style="--seg:13px"></b></div><span class="v">0 / 0</span></div>
          <div class="g-load" data-l="en"><span class="k">EN Load</span><div class="bar"><i class="fill"></i><b class="seg" style="--seg:13px"></b></div><span class="v">0 / 0</span></div>
        </div>
        <div class="g-derived"></div>
        <div class="g-status"></div>
      </div>
    `;
    this.parent.appendChild(root);
    this.root = root;

    const q = (s) => root.querySelector(s);
    this.el = {
      slots: q('.slots'),
      view: q('.g-view'),
      vspec: q('.g-view .vspec'),
      filters: q('.g-filters'),
      items: q('.items'),
      cmp: q('.g-cmp .rows'),
      derived: q('.g-derived'),
      status: q('.g-status'),
      sortLab: q('[data-k="sortlab"]'),
      loads: {
        wt: q('[data-l="wt"]'),
        arm: q('[data-l="arm"]'),
        en: q('[data-l="en"]'),
      },
    };

    // slot rows (static — only their text changes)
    this.slotRows = [];
    for (let i = 0; i < SLOTS.length; i++) {
      const d = document.createElement('div');
      d.className = 'g-slot';
      d.dataset.slot = SLOTS[i][0];
      d.innerHTML = `<span class="k">${SLOTS[i][1]}</span><span class="w mono">--</span><span class="n">— none —</span>`;
      this.el.slots.appendChild(d);
      this.slotRows.push({ el: d, key: SLOTS[i][0], n: d.querySelector('.n'), w: d.querySelector('.w') });
    }

    // filter chips
    const chips = [['all', 'All']].concat(SLOTS.map((s) => [s[0], s[1]]));
    for (const [k, lab] of chips) {
      const s = document.createElement('span');
      s.dataset.f = k;
      s.textContent = lab;
      if (k === 'all') s.className = 'on';
      this.el.filters.appendChild(s);
    }

    // derived stat cells
    this.derivedCells = {};
    const DERIVED = [
      ['apMax', 'AP'],
      ['enMax', 'EN Cap'],
      ['boostSpeed', 'Boost'],
      ['qbThrust', 'QB Thrust'],
      ['enRecharge', 'EN Recharge'],
      ['acsMax', 'ACS Limit'],
      ['weight', 'Weight'],
      ['loadLimit', 'Load Limit'],
    ];
    for (const [k, lab] of DERIVED) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.innerHTML = `<div class="k">${lab}</div><div class="v">--</div>`;
      this.el.derived.appendChild(c);
      this.derivedCells[k] = c.querySelector('.v');
    }
  }

  _bind() {
    this._offs = [];
    this._offs.push(bus.on(EV.BUILD_CHANGED, () => {
      this._listDirty = true;
      this._modelDirty = true;
    }));
    this._offs.push(bus.on(EV.PART_EQUIPPED, () => {
      this._listDirty = true;
      this._modelDirty = true;
    }));
    this._offs.push(bus.on(EV.LOOT_PICKUP, () => {
      this._listDirty = true;
    }));
    this._onResize = () => {
      if (this.opened) this._layout();
    };
    this._offs.push(bus.on('engine:resize', this._onResize));
    window.addEventListener('resize', this._onResize);

    this._onClick = (e) => {
      const t = e.target;
      if (!t || !t.dataset) return;
      if (t.dataset.a === 'close') {
        this._requestClose();
        return;
      }
      if (t.dataset.f) {
        this.filter = t.dataset.f;
        for (const c of this.el.filters.children) c.className = c.dataset.f === this.filter ? 'on' : '';
        this.selIndex = 0;
        this._listDirty = true;
        return;
      }
      const slotEl = t.closest ? t.closest('.g-slot') : null;
      if (slotEl) {
        this.selSlot = slotEl.dataset.slot;
        this.filter = this.selSlot;
        for (const c of this.el.filters.children) c.className = c.dataset.f === this.filter ? 'on' : '';
        this.selIndex = 0;
        this._listDirty = true;
        return;
      }
      const itemEl = t.closest ? t.closest('.g-item') : null;
      if (itemEl) {
        const idx = parseInt(itemEl.dataset.i, 10);
        this.selIndex = this._rows.findIndex((r) => r.idx === idx);
        if (this.selIndex < 0) this.selIndex = 0;
        this._equip(this._rows[this.selIndex]?.part);
      }
    };
    this._onMove = (e) => {
      const itemEl = e.target && e.target.closest ? e.target.closest('.g-item') : null;
      if (!itemEl) return;
      const idx = parseInt(itemEl.dataset.i, 10);
      const row = this._rows.find((r) => r.idx === idx);
      if (row && row.part !== this.hovered) {
        this.hovered = row.part;
        this._renderCompare(row.part);
      }
    };
    this.root.addEventListener('click', this._onClick);
    this.root.addEventListener('mousemove', this._onMove);

    // turntable drag + zoom on the preview panel
    this._onDown = (e) => {
      this.dragging = true;
      this.dragX = e.clientX;
      this.el.view.style.cursor = 'grabbing';
    };
    this._onDrag = (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragX;
      this.dragX = e.clientX;
      this.spinVel = dx * 0.012;
      this.spin += dx * 0.008;
    };
    this._onUp = () => {
      this.dragging = false;
      this.el.view.style.cursor = 'grab';
    };
    this._onWheel = (e) => {
      if (!this.opened) return;
      this.zoom = clamp(this.zoom - Math.sign(e.deltaY) * 0.08, 0.66, 1.7);
    };
    this.el.view.addEventListener('mousedown', this._onDown);
    window.addEventListener('mousemove', this._onDrag);
    window.addEventListener('mouseup', this._onUp);
    this.el.view.addEventListener('wheel', this._onWheel, { passive: true });
  }

  // =========================================================================
  // open / close
  // =========================================================================

  open() {
    if (this.opened) return;
    this.opened = true;
    this.root.classList.add('open');
    this._listDirty = true;
    this._modelDirty = true;

    this._buildStage();
    const scene = this.game?.scene || this.game?.engine?.scene;
    if (scene && this.stage && !this.stage.parent) scene.add(this.stage);

    const cam = this.game?.engine?.camera;
    if (cam) {
      this._savedLayerMask = cam.layers.mask;
      cam.layers.set(GARAGE_LAYER); // only the preview renders while assembling
    }

    // depth of field would fight a menu preview; it is a documented tunable
    const params = this.game?.pipeline?.params;
    if (params && typeof params.dof === 'number') {
      this._savedDof = params.dof;
      params.dof = 0;
    }

    this._layout();
    this._refreshAll();
    bus.emit('mission:log', { text: 'ASSEMBLY BAY // COMBAT SUSPENDED', color: W.COL.cyan });
  }

  close() {
    if (!this.opened) return;
    this.opened = false;
    this.root.classList.remove('open');

    const cam = this.game?.engine?.camera;
    if (cam && this._savedLayerMask !== null) {
      cam.layers.mask = this._savedLayerMask;
      this._savedLayerMask = null;
    }
    const params = this.game?.pipeline?.params;
    if (params && this._savedDof !== null) {
      params.dof = this._savedDof;
      this._savedDof = null;
    }
    if (this.stage && this.stage.parent) this.stage.parent.remove(this.stage);
  }

  _requestClose() {
    try {
      if (this.game?.closeGarage) this.game.closeGarage();
      else this.close();
    } catch (err) {
      this.close();
    }
  }

  // =========================================================================
  // 3D stage
  // =========================================================================

  _buildStage() {
    if (this.stage) return;
    const stage = new THREE.Group();
    stage.name = 'garage-stage';
    stage.matrixAutoUpdate = true;

    // gradient backdrop — sits behind everything, unlit, tone-mapping bypassed
    const tex = this._backdropTexture();
    this.backdropMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, fog: false, depthWrite: true });
    this.backdropGeo = new THREE.PlaneGeometry(1, 1);
    this.backdrop = new THREE.Mesh(this.backdropGeo, this.backdropMat);
    this.backdrop.renderOrder = -100;
    stage.add(this.backdrop);

    // rig holds everything positioned at the preview panel centre
    this.rig = new THREE.Group();
    stage.add(this.rig);

    this.pivot = new THREE.Group();
    this.rig.add(this.pivot);

    // floor: a thin ring + spokes, additive so it glows through the grade
    this.floorMat = new THREE.LineBasicMaterial({ color: 0x2f8ea6, transparent: true, opacity: 0.7, toneMapped: false, fog: false });
    this.floorGeo = this._floorGeometry();
    this.floor = new THREE.LineSegments(this.floorGeo, this.floorMat);
    this.rig.add(this.floor);

    // three-point studio rig. Targets live in the stage so the light directions
    // are fixed relative to the mech, not to world origin.
    const mkDir = (color, intensity, x, y, z) => {
      const l = new THREE.DirectionalLight(color, intensity);
      l.position.set(x, y, z);
      l.castShadow = false;
      const t = new THREE.Object3D();
      t.position.set(0, 0, 0);
      this.rig.add(t);
      l.target = t;
      this.rig.add(l);
      return l;
    };
    this.keyLight = mkDir(0xdff4ff, 3.4, 3.2, 4.0, 3.4);
    this.fillLight = mkDir(0x5f92b4, 1.15, -4.0, 1.0, 2.6);
    this.rimLight = mkDir(0xffb96a, 4.2, -1.6, 2.6, -4.6);

    this.stage = stage;
    this._applyLayer(stage);
  }

  _backdropTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#070c11');
    grd.addColorStop(0.52, '#0d151c');
    grd.addColorStop(0.72, '#0a1117');
    grd.addColorStop(1, '#04070a');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    // soft pool of light behind the mech
    const rad = g.createRadialGradient(128, 150, 8, 128, 150, 130);
    rad.addColorStop(0, 'rgba(60,130,160,0.30)');
    rad.addColorStop(1, 'rgba(60,130,160,0)');
    g.fillStyle = rad;
    g.fillRect(0, 0, 256, 256);
    // faint horizontal banding — reads as a hangar wall, not a webpage gradient
    g.fillStyle = 'rgba(120,200,225,0.030)';
    for (let y = 0; y < 256; y += 6) g.fillRect(0, y, 256, 1);
    g.strokeStyle = 'rgba(120,200,225,0.06)';
    g.lineWidth = 1;
    for (let x = 16; x < 256; x += 42) {
      g.beginPath();
      g.moveTo(x + 0.5, 0);
      g.lineTo(x + 0.5, 256);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Concentric ring + spokes + calibration ticks under the mech. */
  _floorGeometry() {
    const pts = [];
    const ring = (r, seg) => {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        pts.push(Math.cos(a0) * r, 0, Math.sin(a0) * r, Math.cos(a1) * r, 0, Math.sin(a1) * r);
      }
    };
    ring(1.0, 72);
    ring(1.62, 84);
    ring(0.42, 40);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const inner = i % 6 === 0 ? 1.62 : 1.68;
      const outer = i % 6 === 0 ? 1.95 : 1.78;
      pts.push(c * inner, 0, s * inner, c * outer, 0, s * outer);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
      pts.push(Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42, Math.cos(a) * 1.0, 0, Math.sin(a) * 1.0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }

  _applyLayer(obj) {
    obj.traverse((o) => {
      o.layers.set(GARAGE_LAYER);
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });
  }

  /** Build (or rebuild) the previewed mech from the current loadout. */
  _buildModel() {
    this._modelDirty = false;
    if (!this.pivot) return;
    if (this.model) {
      this.pivot.remove(this.model);
      if (this._modelOwned) this._disposeTree(this.model);
      this.model = null;
      this._modelOwned = false;
    }

    let obj = null;
    let owned = false;
    const mf = this.game?.mechFactory;
    try {
      if (mf && typeof mf.buildPlayer === 'function' && this.game?.loadout) {
        const m = mf.buildPlayer(this.game.loadout);
        obj = m && (m.root || (m.isObject3D ? m : null));
      }
    } catch (err) {
      obj = null;
    }
    if (!obj) {
      try {
        const src = this.game?.player?.root;
        if (src) obj = src.clone(true);
      } catch (err) {
        obj = null;
      }
    }
    if (!obj) {
      obj = this._placeholderMech();
      owned = true;
    }

    // normalise: centre on the origin, scale to the panel, feet on the floor ring
    const holder = new THREE.Group();
    holder.add(obj);
    _box.setFromObject(obj);
    if (!isFinite(_box.min.x) || _box.isEmpty()) {
      _box.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 9, 2));
    }
    _box.getSize(_size);
    _box.getCenter(_ctr);
    const height = Math.max(0.001, _size.y);
    obj.position.sub(_ctr);
    obj.position.y += _size.y * 0.5; // base at y = 0
    this.modelHeight = height;

    this.model = holder;
    this._modelOwned = owned;
    this.pivot.add(holder);
    this._applyLayer(this.stage);
    this._layout();
  }

  /** Last-resort stand-in so the garage is never an empty box. */
  _placeholderMech() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x39434c, metalness: 1.0, roughness: 0.42 });
    const emis = new THREE.MeshStandardMaterial({ color: 0x101418, metalness: 1.0, roughness: 0.3, emissive: 0x6ff2ff, emissiveIntensity: 2.4 });
    const box = (w, h, d, x, y, z, m) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const me = new THREE.Mesh(geo, m || mat);
      me.position.set(x, y, z);
      g.add(me);
      return me;
    };
    box(2.6, 2.8, 2.0, 0, 6.2, 0); // core
    box(1.1, 0.9, 1.1, 0, 8.0, 0.1); // head
    box(0.34, 0.2, 0.3, 0, 8.05, 0.7, emis); // optic
    box(0.9, 2.6, 0.9, 1.9, 6.2, 0); // r arm
    box(0.9, 2.6, 0.9, -1.9, 6.2, 0); // l arm
    box(1.0, 0.8, 2.4, 1.7, 7.7, -0.2); // r shoulder
    box(1.0, 0.8, 2.4, -1.7, 7.7, -0.2); // l shoulder
    box(1.1, 2.4, 1.1, 0.85, 3.4, 0); // r leg upper
    box(1.1, 2.4, 1.1, -0.85, 3.4, 0);
    box(0.95, 2.0, 1.4, 0.85, 1.2, 0.1); // r leg lower
    box(0.95, 2.0, 1.4, -0.85, 1.2, 0.1);
    box(1.3, 0.35, 2.0, 0.85, 0.18, 0.2); // feet
    box(1.3, 0.35, 2.0, -0.85, 0.18, 0.2);
    box(2.0, 0.5, 0.5, 0, 5.2, -1.2, emis); // booster glow
    this._placeholderMats = [mat, emis];
    return g;
  }

  _disposeTree(obj) {
    obj.traverse((o) => {
      if (o.isMesh || o.isLineSegments) {
        o.geometry?.dispose?.();
      }
    });
    if (this._placeholderMats) {
      for (const m of this._placeholderMats) m.dispose();
      this._placeholderMats = null;
    }
  }

  /**
   * Place the stage so the mech lands inside the centre panel's rect and fills
   * it at any aspect ratio. Called on open and on resize only.
   */
  _layout() {
    const cam = this.game?.engine?.camera;
    if (!cam || !this.rig) return;
    const r = this.el.view.getBoundingClientRect();
    const cw = Math.max(1, window.innerWidth);
    const ch = Math.max(1, window.innerHeight);
    if (r.width < 4 || r.height < 4) return;

    const D = 9.0; // camera-space depth of the mech
    const halfH = Math.tan(cam.fov * 0.5 * DEG) * D;
    const halfW = halfH * (cam.aspect || cw / ch);

    const ndcX = ((r.left + r.width * 0.5) / cw) * 2 - 1;
    const ndcY = -(((r.top + r.height * 0.55) / ch) * 2 - 1);

    this.rigOffset = this.rigOffset || new THREE.Vector3();
    this.rigOffset.set(ndcX * halfW, ndcY * halfH, -D);

    // scale the mech so it occupies ~72% of the panel height
    const panelWorldH = (r.height / ch) * halfH * 2;
    const targetH = panelWorldH * 0.72;
    this.baseScale = targetH / Math.max(0.001, this.modelHeight || 9);
    this.floorScale = (targetH / 9) * 3.4;

    // backdrop covers the whole frustum a little behind the mech
    const DB = D + 46;
    const bh = Math.tan(cam.fov * 0.5 * DEG) * DB * 2.12;
    const bw = bh * (cam.aspect || cw / ch);
    this.backdrop.position.set(0, 0, -DB);
    this.backdrop.scale.set(bw, bh, 1);
  }

  // =========================================================================
  // frame
  // =========================================================================

  /**
   * @param {number} dt
   * @param {number} elapsed
   */
  update(dt, elapsed) {
    if (!this.opened) return;
    const d = clamp(dt || 0, 0, 0.1);
    if (this._statusHold > 0) this._statusHold = Math.max(0, this._statusHold - d);

    this._handleKeys();

    if (this._modelDirty) this._buildModel();

    // turntable
    this.spinVel = damp(this.spinVel, 0, 5, d);
    this.spin += (0.28 + this.spinVel) * d * (this.dragging ? 0 : 1);
    this.zoomShown = damp(this.zoomShown, this.zoom, 9, d);

    // anchor the stage to the camera and place the rig in camera space
    const cam = this.game?.engine?.camera;
    if (cam && this.stage) {
      cam.updateMatrixWorld();
      this.stage.quaternion.copy(cam.quaternion);
      this.stage.position.copy(cam.position);
      if (this.rigOffset) this.rig.position.copy(this.rigOffset);
      const s = (this.baseScale || 1) * this.zoomShown;
      this.pivot.scale.setScalar(s);
      this.pivot.rotation.y = this.spin;
      this.pivot.position.y = -((this.modelHeight || 9) * s) * 0.5;
      this.floor.position.y = this.pivot.position.y;
      this.floor.scale.setScalar((this.floorScale || 3) * this.zoomShown);
      this.floorMat.opacity = 0.45 + 0.2 * Math.sin(elapsed * 1.6);
    }

    if (this._listDirty) this._refreshAll();
    this._statsT += d;
    if (this._statsT > 0.25) {
      this._statsT = 0;
      this._renderStats();
    }
  }

  _handleKeys() {
    const input = this.game?.input;
    if (!input || !input.hit) return;
    if (input.hit('Escape') || input.hit('KeyG')) {
      this._requestClose();
      return;
    }
    const down = input.hit('ArrowDown') || input.hit('KeyS');
    const up = input.hit('ArrowUp') || input.hit('KeyW');
    if (down || up) {
      const n = this._rows.length;
      if (n) {
        this.selIndex = (this.selIndex + (down ? 1 : -1) + n) % n;
        this._syncSelection();
      }
    }
    if (input.hit('Tab')) {
      const chips = this.el.filters.children;
      let idx = 0;
      for (let i = 0; i < chips.length; i++) if (chips[i].dataset.f === this.filter) idx = i;
      idx = (idx + 1) % chips.length;
      this.filter = chips[idx].dataset.f;
      for (const c of chips) c.className = c.dataset.f === this.filter ? 'on' : '';
      this.selIndex = 0;
      this._listDirty = true;
    }
    if (input.hit('KeyF')) {
      this.sort = this.sort === 'tier' ? 'name' : this.sort === 'name' ? 'rarity' : 'tier';
      this.el.sortLab.textContent = 'SORT: ' + this.sort.toUpperCase();
      this._listDirty = true;
    }
    if (input.hit('Enter') || input.hit('NumpadEnter')) {
      this._equip(this._rows[this.selIndex]?.part);
    }
  }

  // =========================================================================
  // panels
  // =========================================================================

  _refreshAll() {
    this._listDirty = false;
    this._renderSlots();
    this._renderInventory();
    this._renderStats();
  }

  _renderSlots() {
    const slots = this.game?.loadout?.slots;
    for (let i = 0; i < this.slotRows.length; i++) {
      const row = this.slotRows[i];
      const part = slots ? slots[row.key] : null;
      const nm = partName(part);
      row.n.textContent = nm ? String(nm) : '— none —';
      row.n.style.color = nm ? W.rarityColor(part) : '';
      const wt = statBag(part)?.weight;
      row.w.textContent = typeof wt === 'number' ? fmtNum(wt) : '--';
      row.el.className = 'g-slot' + (nm ? '' : ' void') + (this.filter === row.key ? ' sel' : '');
    }
  }

  _renderInventory() {
    const inv = this.game?.loadout?.inventory;
    const slots = this.game?.loadout?.slots;
    const rows = this._rows;
    rows.length = 0;
    if (Array.isArray(inv)) {
      for (let i = 0; i < inv.length; i++) {
        const p = inv[i];
        if (!p) continue;
        const slot = p.slot || p.type || p.category || 'all';
        if (this.filter !== 'all' && slot !== this.filter) continue;
        rows.push({ idx: i, part: p, slot });
      }
    }
    const rank = (p) => {
      const r = p.rarity;
      if (typeof r === 'number') return r;
      if (typeof r === 'string') return ['common', 'uncommon', 'rare', 'epic', 'legendary', 'exotic'].indexOf(r.toLowerCase());
      if (r && typeof r === 'object' && typeof r.index === 'number') return r.index;
      return 0;
    };
    if (this.sort === 'name') rows.sort((a, b) => String(partName(a.part)).localeCompare(String(partName(b.part))));
    else if (this.sort === 'rarity') rows.sort((a, b) => rank(b.part) - rank(a.part));
    else rows.sort((a, b) => (b.part.tier || 0) - (a.part.tier || 0) || rank(b.part) - rank(a.part));

    const frag = document.createDocumentFragment();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const p = r.part;
      const col = W.rarityColor(p);
      const equipped = slots && r.slot && slots[r.slot] === p;
      const d = document.createElement('div');
      d.className = 'g-item' + (equipped ? ' equipped' : '') + (i === this.selIndex ? ' sel' : '');
      d.dataset.i = r.idx;
      d.style.setProperty('--rc', col);
      const tier = p.tier !== undefined ? 'T' + p.tier : W.rarityName(p) || '';
      const meta = this._metaLine(p);
      d.innerHTML = `<span class="pip"></span><span class="n"></span><span class="t"></span><span class="m"></span>`;
      d.children[1].textContent = String(partName(p) || 'UNKNOWN');
      d.children[2].textContent = String(tier).toUpperCase();
      d.children[3].textContent = meta;
      frag.appendChild(d);
    }
    this.el.items.replaceChildren(frag);
    if (!rows.length) {
      const d = document.createElement('div');
      d.className = 'g-item';
      d.innerHTML = `<span class="pip" style="background:#334"></span><span class="n">no salvage</span>`;
      this.el.items.appendChild(d);
    }
    this._syncSelection();
  }

  /** One-line summary: slot • weight • the two loudest affixes. */
  _metaLine(p) {
    const bag = statBag(p);
    let s = String(p.slot || p.type || '').toUpperCase();
    if (bag && typeof bag.weight === 'number') s += (s ? ' · ' : '') + 'WT ' + fmtNum(bag.weight);
    const aff = p.affixes || p.mods || p.perks;
    if (Array.isArray(aff) && aff.length) {
      for (let i = 0; i < Math.min(2, aff.length); i++) {
        const a = aff[i];
        const nm = typeof a === 'string' ? a : a?.name || a?.id || a?.key;
        if (nm) s += ' · ' + String(nm).toUpperCase();
      }
    }
    return s;
  }

  _syncSelection() {
    const kids = this.el.items.children;
    for (let i = 0; i < kids.length; i++) {
      const on = i === this.selIndex;
      if (on !== kids[i].classList.contains('sel')) kids[i].classList.toggle('sel', on);
      if (on && kids[i].scrollIntoView) kids[i].scrollIntoView({ block: 'nearest' });
    }
    const row = this._rows[this.selIndex];
    if (row) this._renderCompare(row.part);
  }

  _equip(part) {
    if (!part) return;
    const lo = this.game?.loadout;
    if (!lo || typeof lo.equip !== 'function') return;
    try {
      lo.equip(part);
      lo.recompute?.();
    } catch (err) {
      this._setStatus('EQUIP REJECTED — SLOT INCOMPATIBLE', 2.5);
      return;
    }
    this._setStatus('INSTALLED :: ' + String(partName(part) || '').toUpperCase(), 2.5);
    this._listDirty = true;
    this._modelDirty = true;
  }

  /** Transient status line; holds priority over the standing build warning. */
  _setStatus(text, hold) {
    this.el.status.textContent = text;
    this._statusHold = hold || 0;
  }

  /** Green/red deltas of a candidate part against whatever is in its slot. */
  _renderCompare(cand) {
    const lo = this.game?.loadout;
    const slot = cand?.slot || cand?.type;
    const eq = slot && lo?.slots ? lo.slots[slot] : null;
    const out = this._cmpRows;
    out.length = 0;

    let handled = false;
    if (lo && typeof lo.compare === 'function' && eq && eq !== cand) {
      try {
        const res = lo.compare(cand, eq);
        if (res && typeof res === 'object' && !Array.isArray(res)) {
          for (const k in res) {
            const v = res[k];
            if (typeof v === 'number' && isFinite(v)) out.push({ k, to: undefined, delta: v });
          }
          handled = out.length > 0;
        } else if (Array.isArray(res)) {
          for (const r of res) {
            if (!r) continue;
            const k = r.key || r.label || r.name;
            const delta = typeof r.delta === 'number' ? r.delta : undefined;
            if (k) out.push({ k, to: r.a ?? r.value, delta });
          }
          handled = out.length > 0;
        }
      } catch (err) {
        handled = false;
      }
    }

    if (!handled) {
      const a = statBag(cand);
      const b = statBag(eq);
      if (a) {
        for (const k in a) {
          const v = a[k];
          if (typeof v !== 'number' || !isFinite(v)) continue;
          if (STAT_DENY.has(k)) continue;
          const prev = b && typeof b[k] === 'number' ? b[k] : 0;
          out.push({ k, to: v, delta: v - prev });
        }
      }
    }

    out.sort((x, y) => Math.abs(y.delta || 0) - Math.abs(x.delta || 0));
    const frag = document.createDocumentFragment();
    for (let i = 0; i < Math.min(8, out.length); i++) {
      const r = out[i];
      const dv = r.delta || 0;
      // weight-like stats are better when they go down
      const lower = /weight|load|heat|recoil|reload|cost|spread/i.test(r.k);
      const good = lower ? dv < 0 : dv > 0;
      const cls = Math.abs(dv) < 1e-6 ? 'eq' : good ? 'up' : 'dn';
      const el = document.createElement('div');
      el.className = 'r';
      el.innerHTML = `<span class="k"></span><span class="v"></span><span class="d ${cls}"></span>`;
      el.children[0].textContent = humanize(r.k);
      el.children[1].textContent = r.to !== undefined ? fmtNum(r.to) : '';
      el.children[2].textContent = fmtDelta(dv);
      frag.appendChild(el);
    }
    this.el.cmp.replaceChildren(frag);
  }

  /** Bottom bar: load constraints + derived performance. */
  _renderStats() {
    const d = this.game?.loadout?.derived;
    const setLoad = (key, v, max, over) => {
      const el = this.el.loads[key];
      if (!el) return;
      const fill = el.querySelector('i.fill');
      const val = el.querySelector('.v');
      const has = typeof v === 'number' && typeof max === 'number' && max > 0;
      const t = has ? clamp(v / max, 0, 1) : 0;
      fill.style.width = (t * 100).toFixed(1) + '%';
      const txt = has ? fmtNum(v) + ' / ' + fmtNum(max) : '-- / --';
      if (val.textContent !== txt) val.textContent = txt;
      const isOver = over === true || (has && v > max);
      if (el.classList.contains('over') !== isOver) el.classList.toggle('over', isOver);
    };

    const weight = d?.weight;
    const loadLimit = d?.loadLimit ?? d?.weightLimit;
    const armsLoad = d?.armsLoad ?? d?.armLoad;
    const armsLimit = d?.armsLimit ?? d?.armsLoadLimit ?? d?.armLimit;
    const enLoad = d?.enLoad ?? d?.enCost;
    const enOut = d?.enOutput ?? d?.enSupply ?? d?.generatorOutput;

    setLoad('wt', weight, loadLimit, d?.overweight);
    setLoad('arm', armsLoad, armsLimit, d?.armsOverloaded);
    setLoad('en', enLoad, enOut, d?.enOverloaded);

    const put = (k, v, suffix) => {
      const el = this.derivedCells[k];
      if (!el) return;
      const s = typeof v === 'number' && isFinite(v) ? fmtNum(v) + (suffix || '') : '--';
      if (el.textContent !== s) el.textContent = s;
    };
    put('apMax', d?.apMax);
    put('enMax', d?.enMax);
    put('boostSpeed', d?.boostSpeed);
    put('qbThrust', d?.qbThrust);
    put('enRecharge', d?.enRecharge);
    put('acsMax', d?.acsMax);
    put('weight', weight);
    put('loadLimit', loadLimit);

    // preview panel spec strip
    const spec = this.el.vspec;
    const apS = typeof d?.apMax === 'number' ? Math.round(d.apMax) : '----';
    const wS = typeof weight === 'number' ? Math.round(weight) : '----';
    const bS = typeof d?.boostSpeed === 'number' ? Math.round(d.boostSpeed) : '---';
    const html = `AP <b>${apS}</b><br>WEIGHT <b>${wS}</b><br>BOOST <b>${bS}</b>`;
    if (spec._h !== html) {
      spec._h = html;
      spec.innerHTML = html;
    }

    if ((this._statusHold || 0) <= 0) {
      const over = d?.overweight || d?.armsOverloaded || d?.enOverloaded;
      const msg = over ? '// BUILD OVER SPEC — PERFORMANCE PENALTY APPLIED' : '';
      if (this.el.status.textContent !== msg) this.el.status.textContent = msg;
    }
  }

  // =========================================================================

  dispose() {
    this.close();
    if (this._offs) for (const off of this._offs) off?.();
    this._offs = null;
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('mousemove', this._onDrag);
    window.removeEventListener('mouseup', this._onUp);
    this.el?.view?.removeEventListener('mousedown', this._onDown);
    this.el?.view?.removeEventListener('wheel', this._onWheel);
    this.root?.removeEventListener('click', this._onClick);
    this.root?.removeEventListener('mousemove', this._onMove);
    if (this.model && this._modelOwned) this._disposeTree(this.model);
    this.backdropGeo?.dispose();
    this.backdropMat?.map?.dispose();
    this.backdropMat?.dispose();
    this.floorGeo?.dispose();
    this.floorMat?.dispose();
    this.stage = null;
    this.root?.remove();
    this.root = null;
  }
}

export default Garage;
