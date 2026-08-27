import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { clamp, lerp, damp, smoothstep, TAU } from '../core/MathUtils.js';
import * as W from './Widgets.js';
import './hud.css';

/**
 * HUD — the ACNTR combat interface.
 *
 * Two layers, deliberately split by what they are good at:
 *   • a 2D canvas overlay for everything that tracks world space (reticle,
 *     target brackets, off-screen indicators, damage numbers, radar, compass,
 *     speed tape) — hundreds of moving markers as DOM nodes would tank the
 *     frame rate;
 *   • DOM/CSS for static chrome (mission log, status cluster, weapon panel,
 *     overlays) where crisp text and responsive layout are far easier.
 *
 * Every read of game state is optional-chained with a sane fallback: the HUD
 * has to render correctly while the systems around it are half-built.
 *
 * Allocation policy: `update()` allocates nothing. Damage numbers, hit markers
 * and directional damage arcs are pooled; colours come from precomputed ramps;
 * DOM text is only written when the formatted value actually changed.
 */

// module-scope scratch — never allocate in the frame loop
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v4 = new THREE.Vector4();
const _proj = { x: 0, y: 0, dist: 0, behind: false, onScreen: false, ok: false };
const _edge = { x: 0, y: 0, ang: 0 };
const _sp = { x: 0, y: 0, visible: false };

const SLOT_KEYS = ['rArm', 'lArm', 'rShoulder', 'lShoulder'];
const SLOT_LABELS = ['R-ARM', 'L-ARM', 'R-SHLD', 'L-SHLD'];

const DN_POOL = 80; // damage numbers
const ARC_POOL = 12; // directional damage arcs
const HM_POOL = 10; // hit markers

/** First finite number found across a list of candidate property names. */
function num(obj, ...keys) {
  if (!obj) return undefined;
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return undefined;
}
/** First non-empty string found across a list of candidate property names. */
function str(obj, ...keys) {
  if (!obj) return undefined;
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (typeof v === 'string' && v.length) return v;
  }
  return undefined;
}

export class HUD {
  /**
   * @param {HTMLElement} rootEl  #ui-root
   * @param {object} game         the Game instance (read-only from here)
   */
  constructor(rootEl, game) {
    this.game = game;
    this.parent = rootEl || document.body;

    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.dpr = clamp(window.devicePixelRatio || 1, 1, 2);

    // --- animated / smoothed HUD state ------------------------------------
    this.time = 0;
    this.boot = 0; // 0..1 boot-up progress
    this.missionTime = 0;
    this.kills = 0;
    this.salvage = 0;
    this.paused = false;
    this.gameOver = false;
    this.complete = false;

    this.lock = 0; // smoothed lock progress
    this.lockFlash = 0;
    this.wasLocked = false;
    this.bloom = 0; // reticle spread bloom from firing
    this.apGhost = 1;
    this.apGhostHold = 0;
    this.apShown = 1;
    this.enShown = 1;
    this.acsShown = 0;
    this.hurt = 0; // full-screen damage flash
    this.staggerFlash = 0;
    this.speedShown = 0;
    this.altShown = 0;
    this.altTimer = 0;
    this.prevStaggered = false;
    this.prevEnRecovering = false;

    // --- pools -------------------------------------------------------------
    this.dn = new Array(DN_POOL);
    for (let i = 0; i < DN_POOL; i++) {
      this.dn[i] = { active: false, pos: new THREE.Vector3(), txt: '', life: 0, ttl: 1.05, direct: false, kill: false, dx: 0, size: 14 };
    }
    this.dnHead = 0;

    this.arcs = new Array(ARC_POOL);
    for (let i = 0; i < ARC_POOL; i++) this.arcs[i] = { active: false, x: 0, z: 0, life: 0, ttl: 1.3, mag: 1 };
    this.arcHead = 0;

    this.hits = new Array(HM_POOL);
    for (let i = 0; i < HM_POOL; i++) this.hits[i] = { active: false, life: 0, ttl: 0.28, kill: false };
    this.hitHead = 0;

    this.entState = new WeakMap();

    // --- mission log --------------------------------------------------------
    this.logLines = [];
    this.logQueue = [];
    this.maxLogLines = 9;

    // --- cached DOM values (avoid touching the DOM when nothing changed) ----
    this.cache = {
      ap: -1, apMax: -1, acs: -1, en: -1, thr: -1, wave: -1, slv: -1,
      clk: '', apCol: '', acsCol: '', vig: -1, pause: null, tip: '',
    };
    this.slotCache = new Array(4);
    for (let i = 0; i < 4; i++) this.slotCache[i] = { name: '', state: '', ammo: '', p: -1, heat: -1, chg: -1, cls: '' };

    this._buildDom();
    this._bind();
    this._resize();
    this.startBoot();
  }

  // =========================================================================
  // construction
  // =========================================================================

  _buildDom() {
    const root = document.createElement('div');
    root.className = 'acntr-hud booting';
    root.innerHTML = `
      <canvas class="hud-canvas"></canvas>

      <div class="hud-log">
        <div class="hdr"><span class="tag">System Log</span><span class="sig">CH.02 // SEC</span></div>
        <div class="lines"></div>
      </div>

      <div class="hud-obj">
        <div class="op">Operation</div>
        <div class="sub">SECTOR 07 // TEST RANGE</div>
        <div class="rows">
          <div class="row"><span class="k">Mission</span><span class="v" data-k="clk">00:00.0</span></div>
          <div class="row hot"><span class="k">Threats</span><span class="v" data-k="thr">00</span></div>
          <div class="row"><span class="k">Wave</span><span class="v" data-k="wave">01</span></div>
          <div class="row"><span class="k">Salvage</span><span class="v" data-k="slv">00</span></div>
        </div>
      </div>

      <div class="hud-status">
        <div class="ap-head">
          <span class="lab">AP</span>
          <span class="val" data-k="ap">0000</span>
          <span class="max" data-k="apmax">/ 0000</span>
          <span class="warn">Integrity Critical</span>
        </div>
        <div class="bar ap"><i class="ghost"></i><i class="fill"></i><b class="seg"></b><b class="tip"></b></div>
        <div class="row2 acs"><span class="k">ACS</span><div class="bar acs"><i class="fill"></i><b class="seg" style="--seg:7px"></b></div><span class="n" data-k="acs">0%</span></div>
        <div class="row2 en"><span class="k">EN</span><div class="bar en"><i class="fill"></i><b class="seg" style="--seg:11px"></b></div><span class="n" data-k="en">0%</span></div>
        <div class="flags">
          <span data-f="grnd">GRND</span><span data-f="bst">BOOST</span><span data-f="qb">QB</span><span data-f="ab">A-BOOST</span><span data-f="lock">LOCK</span>
        </div>
      </div>

      <div class="hud-weapons">
        <div class="whdr"><span class="tag">Armament</span><span class="sig">FCS-041</span></div>
      </div>

      <div class="hud-slam"><div class="t">Staggered</div><div class="s">ACS overload</div><div class="bar"></div></div>

      <div class="hud-vig"></div>
      <div class="hud-crt"></div>
      <div class="hud-flicker"></div>
      <div class="hud-bootwipe"></div>

      <div class="hud-over pause">
        <div class="panel">
          <div class="ttl">System Paused</div>
          <div class="sub">Click to resume // pointer lock released</div>
          <dl class="keys">
            <dt>W A S D</dt><dd>Translate</dd>
            <dt>SPACE</dt><dd>Boost / Ascend</dd>
            <dt>SHIFT</dt><dd>Quick Boost</dd>
            <dt>CTRL</dt><dd>Assault Boost</dd>
            <dt>LMB / RMB</dt><dd>R-Arm / L-Arm</dd>
            <dt>Q / E</dt><dd>R-Shoulder / L-Shoulder</dd>
            <dt>TAB</dt><dd>Hard Lock</dd>
            <dt>G</dt><dd>Assembly (Garage)</dd>
            <dt>R</dt><dd>Repair Kit</dd>
          </dl>
        </div>
      </div>

      <div class="hud-over fail">
        <div class="panel">
          <div class="ttl">Mission Failed</div>
          <div class="sub">AC combat data lost // core destroyed</div>
          <div class="results">
            <div class="cell"><div class="k">Time</div><div class="v" data-k="f-time">00:00.0</div></div>
            <div class="cell"><div class="k">Kills</div><div class="v" data-k="f-kills">00</div></div>
            <div class="cell"><div class="k">Salvage</div><div class="v" data-k="f-slv">00</div></div>
          </div>
          <div class="hud-btn" data-a="retry">Retry Sortie</div>
        </div>
      </div>

      <div class="hud-over win">
        <div class="panel">
          <div class="ttl">Mission Accomplished</div>
          <div class="sub">All hostiles neutralized // returning to hangar</div>
          <div class="results">
            <div class="cell"><div class="k">Time</div><div class="v" data-k="w-time">00:00.0</div></div>
            <div class="cell"><div class="k">Kills</div><div class="v" data-k="w-kills">00</div></div>
            <div class="cell"><div class="k">Salvage</div><div class="v" data-k="w-slv">00</div></div>
          </div>
          <div class="hud-btn" data-a="continue">Continue</div>
        </div>
      </div>
    `;
    this.parent.appendChild(root);
    this.root = root;

    const q = (s) => root.querySelector(s);
    this.canvas = q('.hud-canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true });

    this.el = {
      log: q('.hud-log .lines'),
      status: q('.hud-status'),
      ap: q('[data-k="ap"]'),
      apMax: q('[data-k="apmax"]'),
      apFill: q('.bar.ap > i.fill'),
      apGhost: q('.bar.ap > i.ghost'),
      apTip: q('.bar.ap > b.tip'),
      acsFill: q('.bar.acs > i.fill'),
      acsN: q('[data-k="acs"]'),
      enFill: q('.bar.en > i.fill'),
      enN: q('[data-k="en"]'),
      clk: q('[data-k="clk"]'),
      thr: q('[data-k="thr"]'),
      wave: q('[data-k="wave"]'),
      slv: q('[data-k="slv"]'),
      weapons: q('.hud-weapons'),
      slam: q('.hud-slam'),
      slamT: q('.hud-slam .t'),
      slamS: q('.hud-slam .s'),
      vig: q('.hud-vig'),
      pause: q('.hud-over.pause'),
      fail: q('.hud-over.fail'),
      win: q('.hud-over.win'),
      flags: {},
    };
    root.querySelectorAll('.flags span').forEach((s) => {
      this.el.flags[s.dataset.f] = s;
    });

    // weapon rows — built once, mutated in place
    this.wrows = [];
    for (let i = 0; i < 4; i++) {
      const row = document.createElement('div');
      row.className = 'wrow empty';
      row.innerHTML = `<span class="slot">${SLOT_LABELS[i]}</span><span class="nm">— empty —</span><span class="st mono">----</span><span class="am mono">--<i>/--</i></span><span class="ring"></span><span class="strip"><i></i></span>`;
      this.el.weapons.appendChild(row);
      this.wrows.push({
        row,
        nm: row.querySelector('.nm'),
        st: row.querySelector('.st'),
        am: row.querySelector('.am'),
        ring: row.querySelector('.ring'),
        strip: row.querySelector('.strip > i'),
      });
    }

    // interactive buttons re-enable pointer events (the rest of #ui-root is inert)
    this._onClick = (e) => {
      const a = e.target && e.target.dataset && e.target.dataset.a;
      if (a === 'retry') {
        this.hideGameOver();
        try {
          this.game?.restart?.();
        } catch (err) {
          /* restart is owned elsewhere; never let the UI die with it */
        }
      } else if (a === 'continue') {
        this.el.win.classList.remove('show');
        this.complete = false;
        try {
          this.game?.input?.requestLock?.();
        } catch (err) {
          /* ignore */
        }
      }
    };
    root.addEventListener('click', this._onClick);
  }

  _bind() {
    this._offs = [];
    const on = (ev, fn) => this._offs.push(bus.on(ev, fn));

    on('mission:log', (p) => this.log(p));
    on(EV.LOOT_PICKUP, (p) => {
      this.salvage++;
      const part = p?.part || p?.item || p;
      const nm = str(part, 'name', 'displayName', 'id') || 'UNKNOWN PART';
      const rr = W.rarityName(part);
      this.log({ text: `SALVAGE ACQUIRED :: ${nm}${rr ? ' [' + rr.toUpperCase() + ']' : ''}`, color: W.rarityColor(part) });
    });
    on(EV.PART_EQUIPPED, (p) => {
      const part = p?.part || p;
      const nm = str(part, 'name', 'displayName', 'id');
      if (nm) this.log({ text: `ASSEMBLY UPDATED :: ${nm}`, color: W.COL.cyan });
    });

    on(EV.DAMAGE_DEALT, (p) => this._onDamage(p));
    on(EV.PLAYER_HIT, (p) => this._onPlayerHit(p));
    on(EV.ENTITY_KILLED, (p) => {
      const ent = p?.entity || p?.target || p;
      if (ent && ent === this.game?.player) return;
      this.kills++;
      this._pushHit(true);
      const nm = str(ent, 'name', 'archetype') || 'HOSTILE';
      this.log({ text: `TARGET DESTROYED :: ${String(nm).toUpperCase()}`, color: W.COL.amber });
    });
    on(EV.STAGGER, (p) => {
      const ent = p?.entity || p?.target || p;
      if (ent === this.game?.player) {
        this.staggerFlash = 1;
        this.slam('Staggered', 'ACS overload — impact resistance zeroed', false);
      } else if (ent) {
        const st = this._ent(ent);
        if (st) st.flare = 1;
      }
    });
    on(EV.WEAPON_FIRED, () => {
      this.bloom = Math.min(1.4, this.bloom + 0.36);
    });
    on(EV.EN_EMPTY, () => {
      this.slam('EN Empty', 'Generator output depleted — recovery', true);
    });
    on(EV.QUICK_BOOST, () => {
      this.bloom = Math.min(1.4, this.bloom + 0.2);
    });
    on(EV.MISSION_COMPLETE, (p) => this.showComplete(p));
    on(EV.GAME_START, () => this.startBoot());
    on(EV.GAME_OVER, () => this.showGameOver());

    this._onResize = () => this._resize();
    this._offs.push(bus.on('engine:resize', this._onResize));
    window.addEventListener('resize', this._onResize);
  }

  _resize() {
    const eng = this.game?.engine;
    const w = Math.max(1, eng?.width || window.innerWidth);
    const h = Math.max(1, eng?.height || window.innerHeight);
    // NOTE: use the display DPR, not engine.pixelRatio — the engine scales that
    // down for adaptive resolution and a blurry HUD is an instant fail.
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    const c = this.canvas;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.lineCap = 'butt';
    this.ctx.lineJoin = 'miter';

    // Responsive instrument geometry, recomputed only on resize. The constants
    // are chosen so nothing collides at 4:3, 16:9 or 21:9 — the compass never
    // reaches the mission log, the radar clears the objective block above it,
    // and the speed tape sits below the radar and above the weapon panel.
    const vmin = Math.min(w, h);
    this.ui = {
      compW: Math.min(560, Math.max(300, w * 0.3)),
      compY: Math.max(20, h * 0.032),
      radarR: clamp(vmin * 0.085, 52, 84),
      radarX: w - clamp(w * 0.075, 78, 132),
      radarY: clamp(h * 0.3, 175, 300),
      tapeX: w - clamp(w * 0.028, 34, 58),
      tapeH: clamp(h * 0.26, 150, 260),
      tapeY: h * 0.56,
      reticleScale: clamp(vmin / 900, 0.72, 1.25),
      safeX: Math.min(96, w * 0.08),
      safeY: Math.min(84, h * 0.09),
    };
  }

  // =========================================================================
  // public API
  // =========================================================================

  /** Replay the power-on sequence (sweep-in + scanline wipe). */
  startBoot() {
    this.boot = 0;
    this.root.classList.remove('booting');
    void this.root.offsetWidth; // force reflow so the animation restarts
    this.root.classList.add('booting');
    this.log({ text: 'FCS ONLINE // AC SYSTEMS NOMINAL', color: W.COL.cyan });
    this.log({ text: 'COMBAT LINK ESTABLISHED', color: W.COL.dim });
  }

  /**
   * Append a line to the mission terminal.
   * @param {string|{text:string,color?:string,level?:string}} payload
   */
  log(payload) {
    if (payload == null) return;
    const isObj = typeof payload === 'object';
    const t = isObj ? String(payload.text ?? payload.message ?? payload.msg ?? '') : String(payload);
    if (!t) return;
    const level = isObj ? payload.level : undefined;
    this.logQueue.push({
      text: t.toUpperCase(),
      color: isObj ? payload.color : undefined,
      level: level === 'warn' || level === 'crit' ? level : undefined,
      stamp: W.clockStr(this.missionTime),
    });
    if (this.logQueue.length > 24) this.logQueue.shift();
  }

  /** Big centre-screen warning slam. */
  slam(title, sub, amber) {
    const e = this.el.slam;
    this.el.slamT.textContent = title;
    this.el.slamS.textContent = sub || '';
    e.classList.toggle('amber', !!amber);
    e.classList.remove('show');
    void e.offsetWidth;
    e.classList.add('show');
  }

  /**
   * Pointer lock lost → dimmed pause card. The overlay keeps pointer-events
   * off so the click that re-locks still reaches the WebGL canvas underneath.
   * Actual visibility is reconciled in `update()` against `input.locked`, so
   * the card is also correct on the very first frame (before any lock event).
   */
  setPaused(b) {
    this.paused = !!b;
  }

  showGameOver() {
    if (this.gameOver) return;
    this.gameOver = true;
    this.el.pause.classList.remove('show');
    this._setText(this.root.querySelector('[data-k="f-time"]'), W.clockStr(this.missionTime));
    this._setText(this.root.querySelector('[data-k="f-kills"]'), W.pad(this.kills, 2));
    this._setText(this.root.querySelector('[data-k="f-slv"]'), W.pad(this.salvage, 2));
    this.el.fail.classList.add('show');
    this.log({ text: 'CRITICAL DAMAGE — AC DISABLED', level: 'crit' });
  }

  hideGameOver() {
    this.gameOver = false;
    this.el.fail.classList.remove('show');
  }

  /** Mission accomplished results card. */
  showComplete(p) {
    if (this.complete) return;
    this.complete = true;
    const time = typeof p?.time === 'number' ? p.time : this.missionTime;
    const kills = typeof p?.kills === 'number' ? p.kills : this.kills;
    const slv = typeof p?.salvage === 'number' ? p.salvage : this.salvage;
    this._setText(this.root.querySelector('[data-k="w-time"]'), W.clockStr(time));
    this._setText(this.root.querySelector('[data-k="w-kills"]'), W.pad(kills, 2));
    this._setText(this.root.querySelector('[data-k="w-slv"]'), W.pad(slv, 2));
    this.el.win.classList.add('show');
    this.log({ text: 'MISSION ACCOMPLISHED', color: W.COL.amber });
  }

  // =========================================================================
  // frame
  // =========================================================================

  /**
   * @param {number} dt seconds
   * @param {number} elapsed seconds since boot
   */
  update(dt, elapsed) {
    const d = clamp(dt || 0, 0, 0.1);
    this.time += d;
    this.boot = Math.min(1, this.boot + d * 1.15);

    const game = this.game;
    const state = game?.state;
    const playing = state === 'playing';
    if (playing) this.missionTime += d;

    // hide the combat HUD while the garage owns the screen
    const inGarage = state === 'garage';
    if (this._garageHidden !== inGarage) {
      this._garageHidden = inGarage;
      this.root.classList.toggle('off', inGarage);
    }

    // Safety net for the assembly key: Game may also map G, and openGarage()
    // guards on state, so a double-call is harmless.
    const input = game?.input;
    if (playing && input?.hit?.('KeyG')) {
      try {
        game.openGarage?.();
      } catch (err) {
        /* garage is optional */
      }
    }

    // pause card follows the real pointer-lock state
    const locked = typeof input?.locked === 'boolean' ? input.locked : !this.paused;
    const showPause = playing && !locked && !this.gameOver && !this.complete;
    if (showPause !== this.cache.pause) {
      this.cache.pause = showPause;
      this.el.pause.classList.toggle('show', showPause);
    }

    this._updateLog(d);
    this._updateStatus(d);
    this._updateWeapons(d);
    this._updateObjective(d);
    this._drawCanvas(d);
  }

  // ---- mission terminal ----------------------------------------------------

  _updateLog(dt) {
    // pull one queued line at a time; type it out
    const typing = this.logLines.length ? this.logLines[this.logLines.length - 1] : null;
    if ((!typing || typing.shown >= typing.text.length) && this.logQueue.length) {
      const q = this.logQueue.shift();
      const el = document.createElement('div');
      el.className = 'ln' + (q.level ? ' ' + q.level : '');
      if (q.color) el.style.color = q.color;
      el.innerHTML = `<span class="t">${q.stamp} </span><span class="b"></span>`;
      this.el.log.appendChild(el);
      const line = { el, body: el.querySelector('.b'), text: q.text, shown: 0 };
      this.logLines.push(line);
      while (this.logLines.length > this.maxLogLines) {
        const old = this.logLines.shift();
        old.el.remove();
      }
      // age the older lines so the newest reads brightest
      for (let i = 0; i < this.logLines.length; i++) {
        const age = this.logLines.length - 1 - i;
        const cl = this.logLines[i].el.classList;
        cl.toggle('old', age >= 3 && age < 6);
        cl.toggle('older', age >= 6);
      }
    }

    const cur = this.logLines.length ? this.logLines[this.logLines.length - 1] : null;
    if (cur && cur.shown < cur.text.length) {
      cur.shown = Math.min(cur.text.length, cur.shown + dt * 78);
      const n = Math.floor(cur.shown);
      if (n !== cur.lastN) {
        cur.lastN = n;
        cur.body.textContent = cur.text.slice(0, n);
      }
    }
  }

  // ---- player status cluster ----------------------------------------------

  _updateStatus(dt) {
    const st = this.game?.player?.stats;
    const cs = this.game?.controller?.state;
    const apMax = Math.max(1, st?.apMax ?? 1);
    const ap = clamp(st?.ap ?? apMax, 0, apMax);
    const apT = ap / apMax;
    const acsMax = Math.max(1, st?.acsMax ?? 1);
    const acsT = clamp((st?.acs ?? 0) / acsMax, 0, 1);
    const enMax = Math.max(1, st?.enMax ?? 1);
    const enT = clamp((st?.en ?? enMax) / enMax, 0, 1);
    const staggered = !!st?.staggered;
    const enRec = !!cs?.enRecovering;

    // damage ghost: hold, then bleed down to the real value
    if (apT >= this.apGhost) {
      this.apGhost = apT;
      this.apGhostHold = 0;
    } else {
      this.apGhostHold += dt;
      if (this.apGhostHold > 0.42) this.apGhost = Math.max(apT, this.apGhost - dt * 0.55);
    }
    this.apShown = damp(this.apShown, apT, 22, dt);
    this.enShown = damp(this.enShown, enT, 26, dt);
    this.acsShown = damp(this.acsShown, acsT, 20, dt);

    const e = this.el;
    this._setW(e.apFill, this.apShown);
    this._setW(e.apGhost, this.apGhost);
    const tip = (this.apShown * 100).toFixed(2) + '%';
    if (tip !== this.cache.tip) {
      this.cache.tip = tip;
      e.apTip.style.left = tip;
    }
    this._setW(e.acsFill, this.acsShown);
    this._setW(e.enFill, this.enShown);

    const apInt = Math.round(ap);
    if (apInt !== this.cache.ap) {
      this.cache.ap = apInt;
      e.ap.textContent = W.pad(apInt, 4);
    }
    const apMaxInt = Math.round(apMax);
    if (apMaxInt !== this.cache.apMax) {
      this.cache.apMax = apMaxInt;
      e.apMax.textContent = '/ ' + W.pad(apMaxInt, 4);
    }
    const acsPct = Math.round(acsT * 100);
    if (acsPct !== this.cache.acs) {
      this.cache.acs = acsPct;
      e.acsN.textContent = W.itoa(acsPct) + '%';
    }
    const enPct = Math.round(enT * 100);
    if (enPct !== this.cache.en) {
      this.cache.en = enPct;
      e.enN.textContent = W.itoa(enPct) + '%';
    }

    // fill colour follows the integrity ramp
    const apCol = W.AP_RAMP.get(apT);
    if (apCol !== this.cache.apCol) {
      this.cache.apCol = apCol;
      e.apFill.style.background = apCol;
    }
    const acsCol = W.ACS_RAMP.get(acsT);
    if (acsCol !== this.cache.acsCol) {
      this.cache.acsCol = acsCol;
      e.acsFill.style.background = acsCol;
    }

    const cls = e.status.classList;
    cls.toggle('low', apT < 0.35);
    cls.toggle('crit', apT < 0.16);
    cls.toggle('en-recover', enRec);
    cls.toggle('acs-break', staggered);

    // flags
    this._flag('grnd', cs?.grounded, '');
    this._flag('bst', cs?.boosting, '');
    this._flag('qb', (cs?.qbTimer ?? 0) > 0, 'amber');
    this._flag('ab', cs?.assaultBoost, 'amber');
    this._flag('lock', this.game?.targeting?.hardLock, 'red');

    // stagger / EN-empty edges
    if (staggered && !this.prevStaggered) {
      this.staggerFlash = 1;
      this.slam('Staggered', 'ACS overload — impact resistance zeroed', false);
    }
    this.prevStaggered = staggered;
    if (enRec && !this.prevEnRecovering) this.log({ text: 'EN RESERVE DEPLETED — RECOVERY CYCLE', level: 'warn' });
    this.prevEnRecovering = enRec;

    // low-AP screen tint + hit flash
    this.hurt = Math.max(0, this.hurt - dt * 1.6);
    this.staggerFlash = Math.max(0, this.staggerFlash - dt * 1.4);
    const lowPulse = apT < 0.3 ? (0.5 + 0.5 * Math.sin(this.time * 7.5)) * (1 - apT / 0.3) * 0.45 : 0;
    const vig = clamp(this.hurt * 0.85 + lowPulse + this.staggerFlash * 0.35, 0, 1);
    if (Math.abs(vig - (this.cache.vig ?? -1)) > 0.01) {
      this.cache.vig = vig;
      this.el.vig.style.opacity = vig.toFixed(3);
    }
  }

  _flag(key, on, mod) {
    const el = this.el.flags[key];
    if (!el) return;
    const want = on ? 'on ' + (mod || '') : '';
    if (el._cls !== want) {
      el._cls = want;
      el.className = want;
    }
  }

  _setW(el, t) {
    const p = (clamp(t, 0, 1) * 100).toFixed(2) + '%';
    if (el._w !== p) {
      el._w = p;
      el.style.width = p;
    }
  }

  _setText(el, s) {
    if (!el) return;
    if (el._t !== s) {
      el._t = s;
      el.textContent = s;
    }
  }

  // ---- weapon panel --------------------------------------------------------

  _updateWeapons(dt) {
    const slots = this.game?.weapons?.slots;
    for (let i = 0; i < 4; i++) {
      const row = this.wrows[i];
      const c = this.slotCache[i];
      const wpn = slots ? slots[SLOT_KEYS[i]] : null;

      if (!wpn) {
        if (c.cls !== 'wrow empty') {
          c.cls = 'wrow empty';
          row.row.className = c.cls;
          this._setText(row.nm, '— empty —');
          this._setText(row.st, '----');
          row.am.innerHTML = '--<i>/--</i>';
          row.ring.style.setProperty('--p', 0);
          row.strip.style.width = '0%';
          c.name = c.state = c.ammo = '';
          c.p = c.heat = c.chg = -1;
        }
        continue;
      }

      const def = wpn.def || wpn.spec || wpn.data || null;
      const name = (str(wpn, 'name', 'displayName') || str(def, 'name', 'displayName') || str(wpn, 'id') || str(def, 'id') || 'WEAPON').toString();

      const magMax = num(wpn, 'magSize', 'magazineSize', 'clipSize', 'ammoMax', 'magMax') ?? num(def, 'magSize', 'magazine', 'clipSize', 'ammoMax', 'mag');
      const ammo = num(wpn, 'ammo', 'magAmmo', 'rounds', 'currentAmmo', 'clip', 'mag');
      const reserve = num(wpn, 'reserve', 'ammoReserve', 'totalAmmo', 'stock');

      let reload = num(wpn, 'reloadProgress');
      if (reload === undefined) {
        const rt = num(wpn, 'reloadTimer', 'reloadT', 'reloading');
        const rd = num(wpn, 'reloadTime') ?? num(def, 'reloadTime', 'reload');
        if (rt !== undefined && rd) reload = clamp(1 - rt / rd, 0, 1);
      }
      const reloading = (wpn.reloading === true) || (reload !== undefined && reload < 0.999 && reload >= 0);

      let charge = num(wpn, 'chargeProgress', 'charge', 'chargeT');
      const chargeMax = num(wpn, 'chargeMax') ?? num(def, 'chargeTime', 'chargeMax');
      if (charge !== undefined && chargeMax && charge > 1.001) charge = clamp(charge / chargeMax, 0, 1);
      const chargeable = charge !== undefined || !!(def && (def.chargeable || def.chargeTime));

      let heat = num(wpn, 'heat');
      const heatMax = num(wpn, 'heatMax') ?? num(def, 'heatMax');
      if (heat !== undefined && heatMax) heat = clamp(heat / heatMax, 0, 1);
      const overheat = wpn.overheated === true || wpn.overheat === true || (heat !== undefined && heat >= 0.995);

      const deploying = wpn.deploying === true || (num(wpn, 'deployT', 'deployTimer') ?? 0) > 0;
      const cooling = (num(wpn, 'cooldown', 'fireTimer', 'cd') ?? 0) > 0;

      let stateWord = str(wpn, 'state', 'status');
      if (!stateWord) {
        if (overheat) stateWord = 'OVERHEAT';
        else if (deploying) stateWord = 'DEPLOYING';
        else if (reloading) stateWord = 'RELOADING';
        else if (ammo === 0) stateWord = 'EMPTY';
        else if (charge !== undefined && charge > 0.02) stateWord = charge >= 0.999 ? 'CHARGED' : 'CHARGING';
        else stateWord = 'READY';
      }
      stateWord = stateWord.toUpperCase();

      const active = cooling || (charge !== undefined && charge > 0.02);
      let cls = 'wrow';
      if (overheat) cls += ' overheat';
      else if (reloading) cls += ' reloading';
      if (charge !== undefined && charge >= 0.999) cls += ' charged';
      if (active) cls += ' active';
      if (cls !== c.cls) {
        c.cls = cls;
        row.row.className = cls;
      }

      if (name !== c.name) {
        c.name = name;
        this._setText(row.nm, name);
      }
      if (stateWord !== c.state) {
        c.state = stateWord;
        this._setText(row.st, stateWord);
      }

      let ammoStr;
      if (ammo === undefined) ammoStr = '∞';
      else if (magMax !== undefined) ammoStr = W.itoa(Math.max(0, Math.round(ammo))) + '/' + W.itoa(Math.round(magMax));
      else if (reserve !== undefined) ammoStr = W.itoa(Math.max(0, Math.round(ammo))) + '/' + W.itoa(Math.round(reserve));
      else ammoStr = W.itoa(Math.max(0, Math.round(ammo)));
      if (ammoStr !== c.ammo) {
        c.ammo = ammoStr;
        const slash = ammoStr.indexOf('/');
        row.am.innerHTML = slash < 0 ? ammoStr : `${ammoStr.slice(0, slash)}<i>${ammoStr.slice(slash)}</i>`;
      }

      // ring shows reload; when charging it shows charge in white
      const ringP = charge !== undefined && charge > 0.02 ? charge : reloading && reload !== undefined ? reload : reloading ? 0.5 : ammo !== undefined && magMax ? clamp(ammo / magMax, 0, 1) : 1;
      if (Math.abs(ringP - c.p) > 0.008) {
        c.p = ringP;
        row.ring.style.setProperty('--p', ringP.toFixed(3));
      }
      const ringCol = charge !== undefined && charge > 0.02 ? '#ffffff' : reloading ? W.COL.amber : overheat ? W.COL.red : W.COL.cyan;
      if (ringCol !== c.ringCol) {
        c.ringCol = ringCol;
        row.ring.style.setProperty('--rc', ringCol);
      }

      const stripT = charge !== undefined && charge > 0.02 ? charge : heat !== undefined ? heat : 0;
      if (Math.abs(stripT - c.heat) > 0.008) {
        c.heat = stripT;
        row.strip.style.width = (stripT * 100).toFixed(1) + '%';
      }
      const stripCls = charge !== undefined && charge > 0.02 ? 'chg' : '';
      if (stripCls !== c.stripCls) {
        c.stripCls = stripCls;
        row.strip.className = stripCls;
      }
    }
  }

  // ---- top-right objective readout ----------------------------------------

  _updateObjective(dt) {
    this._objT = (this._objT || 0) + dt;
    if (this._objT < 0.1) return; // 10 Hz is plenty for text that changes slowly
    this._objT = 0;

    const clk = W.clockStr(this.missionTime);
    if (clk !== this.cache.clk) {
      this.cache.clk = clk;
      this.el.clk.textContent = clk;
    }
    const list = this.game?.enemies?.list;
    let live = 0;
    if (list) for (let i = 0; i < list.length; i++) if (list[i]?.alive !== false) live++;
    if (live !== this.cache.thr) {
      this.cache.thr = live;
      this.el.thr.textContent = W.pad(live, 2);
    }
    const wave = (this.game?.enemies?.waveIndex ?? 0) + 1;
    if (wave !== this.cache.wave) {
      this.cache.wave = wave;
      this.el.wave.textContent = W.pad(wave, 2);
    }
    if (this.salvage !== this.cache.slv) {
      this.cache.slv = this.salvage;
      this.el.slv.textContent = W.pad(this.salvage, 2);
    }
  }

  // =========================================================================
  // canvas layer
  // =========================================================================

  _drawCanvas(dt) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    ctx.clearRect(0, 0, w, h);
    if (this._garageHidden) return;

    const cam = this.game?.engine?.camera;
    this.camera = cam;
    if (cam) {
      cam.getWorldDirection(_fwd);
      _right.setFromMatrixColumn(cam.matrixWorld, 0);
    }

    ctx.lineWidth = 1;
    ctx.textBaseline = 'alphabetic';

    const b = smoothstep(0, 1, this.boot);
    if (b < 1) {
      // power-on wipe: instruments resolve out of a horizontal band
      ctx.save();
      const half = lerp(0.02, 0.62, b) * h;
      ctx.beginPath();
      ctx.rect(0, h * 0.5 - half, w, half * 2);
      ctx.clip();
    }

    this._drawCompass(dt);
    this._drawRadar(dt);
    this._drawSpeedTape(dt);
    this._drawTargets(dt);
    this._drawDamageNumbers(dt);
    this._drawReticle(dt);
    this._drawDamageArcs(dt);
    this._drawFrameMarks();

    if (b < 1) {
      ctx.restore();
      // scan bar riding the wipe edge
      const y = h * 0.5 - lerp(0.02, 0.62, b) * h;
      ctx.strokeStyle = W.CYAN_FADE.get(1 - b);
      W.hline(ctx, 0, w, y);
      W.hline(ctx, 0, w, h - y);
    }
  }

  // ---- projection ----------------------------------------------------------

  /**
   * World point → screen px. Handles points behind the camera by mirroring so
   * off-screen indicators still point the right way.
   */
  _project(wp, out) {
    const cam = this.camera;
    out.ok = false;
    if (!cam || !wp) return out;
    _v4.set(wp.x, wp.y, wp.z, 1);
    _v4.applyMatrix4(cam.matrixWorldInverse);
    out.dist = -_v4.z;
    _v4.applyMatrix4(cam.projectionMatrix);
    const ww = _v4.w;
    if (Math.abs(ww) < 1e-6) return out;
    let nx = _v4.x / ww;
    let ny = _v4.y / ww;
    out.behind = ww < 0;
    if (out.behind) {
      nx = -nx;
      ny = -ny;
    }
    out.x = (nx * 0.5 + 0.5) * this.w;
    out.y = (-ny * 0.5 + 0.5) * this.h;
    out.onScreen = !out.behind && nx > -1 && nx < 1 && ny > -1 && ny < 1;
    out.ok = true;
    return out;
  }

  /** Pixels-per-metre at a given distance (used to size world-tracking boxes). */
  _focal() {
    const cam = this.camera;
    if (!cam) return this.h;
    return this.h / (2 * Math.tan((cam.fov * Math.PI) / 360));
  }

  // ---- reticle -------------------------------------------------------------

  _drawReticle(dt) {
    const ctx = this.ctx;
    const cx = Math.round(this.w * 0.5);
    const cy = Math.round(this.h * 0.5);
    const s = this.ui.reticleScale;
    const tgt = this.game?.targeting;
    const raw = clamp(tgt?.lockProgress ?? 0, 0, 1);
    const hard = !!tgt?.hardLock;
    this.lock = damp(this.lock, raw, 18, dt);
    const t = this.lock;

    if (raw > 0.995 && !this.wasLocked) this.lockFlash = 1;
    this.wasLocked = raw > 0.995;
    this.lockFlash = Math.max(0, this.lockFlash - dt * 3.4);

    // weapon spread → reticle aperture
    this.bloom = Math.max(0, this.bloom - dt * 2.6);
    let spread = 0;
    const slots = this.game?.weapons?.slots;
    if (slots) {
      for (let i = 0; i < 4; i++) {
        const wp = slots[SLOT_KEYS[i]];
        if (!wp) continue;
        const sp = num(wp, 'spread', 'currentSpread', 'bloom') ?? num(wp.def, 'spread');
        if (sp !== undefined) spread = Math.max(spread, sp);
      }
    }
    const spreadPx = Math.tan(clamp(spread, 0, 0.4)) * this._focal() * 0.5;

    const col = hard ? W.COL.hot : t > 0.03 ? W.ACS_RAMP.get(0.3 + t * 0.55) : 'rgba(140,205,220,0.62)';
    const soft = hard ? 'rgba(255,106,42,0.22)' : t > 0.03 ? 'rgba(255,176,56,0.2)' : 'rgba(111,242,255,0.16)';

    const ease = t * t * (3 - 2 * t);
    const outer = (lerp(54, 25, ease) + this.bloom * 9) * s;
    const rot = (1 - ease) * 0.62 + (hard ? Math.sin(this.time * 0.9) * 0.05 : 0);

    // soft under-stroke for glow, then the hairline
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = soft;
    W.brackets(ctx, cx, cy, outer, outer * 0.4, rot);
    ctx.lineWidth = 1;
    ctx.strokeStyle = col;
    W.brackets(ctx, cx, cy, outer, outer * 0.4, rot);

    // inner box + cross
    const inner = 11 * s;
    ctx.strokeStyle = hard ? W.COL.red : 'rgba(150,225,240,0.5)';
    W.rectSharp(ctx, cx - inner, cy - inner, inner * 2, inner * 2);
    ctx.strokeStyle = col;
    ctx.beginPath();
    const g0 = 4 * s;
    const g1 = 8.5 * s;
    ctx.moveTo(cx - g1, cy + 0.5);
    ctx.lineTo(cx - g0, cy + 0.5);
    ctx.moveTo(cx + g0, cy + 0.5);
    ctx.lineTo(cx + g1, cy + 0.5);
    ctx.moveTo(cx + 0.5, cy - g1);
    ctx.lineTo(cx + 0.5, cy - g0);
    ctx.moveTo(cx + 0.5, cy + g0);
    ctx.lineTo(cx + 0.5, cy + g1);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.fillRect(cx, cy, 1, 1);

    // ballistic spread / drop aperture — four ticks that widen with dispersion
    const ap = Math.max(spreadPx, outer * 0.45) + this.bloom * 6 * s;
    if (ap > inner * 1.6) {
      ctx.strokeStyle = 'rgba(140,205,220,0.34)';
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = Math.PI * 0.25 + (i * Math.PI) / 2;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        ctx.moveTo(cx + dx * ap, cy + dy * ap);
        ctx.lineTo(cx + dx * (ap + 5 * s), cy + dy * (ap + 5 * s));
      }
      ctx.stroke();
      // drop indicator — a short vertical stem below centre
      ctx.strokeStyle = 'rgba(140,205,220,0.24)';
      W.vline(ctx, cx, cy + inner + 3, cy + inner + 3 + ap * 0.42);
    }

    // hard-lock furniture
    if (hard) {
      ctx.strokeStyle = 'rgba(255,77,61,0.75)';
      W.tickRing(ctx, cx, cy, outer + 8 * s, 12, 4 * s, this.time * 0.5);
      W.setMono(ctx, 9 * s, 1.6);
      W.text(ctx, 'HARD LOCK', cx, cy - outer - 13 * s, W.COL.red, 'center');
    } else if (t > 0.05 && t < 0.995) {
      W.setMono(ctx, 9 * s, 1.6);
      W.text(ctx, 'ACQUIRING', cx, cy - outer - 13 * s, 'rgba(255,176,56,0.8)', 'center');
    }

    // lock snap flash
    if (this.lockFlash > 0) {
      const f = this.lockFlash;
      const r = lerp(24, 92, 1 - f) * s;
      ctx.strokeStyle = W.WHITE_FADE.get(f * 0.9);
      ctx.lineWidth = lerp(1, 2.4, f);
      W.brackets(ctx, cx, cy, r, r * 0.34, 0);
      ctx.lineWidth = 1;
      ctx.strokeStyle = W.RED_FADE.get(f * 0.55);
      W.arcSeg(ctx, cx, cy, r * 1.1, 0, TAU);
    }

    // hit markers
    for (let i = 0; i < HM_POOL; i++) {
      const m = this.hits[i];
      if (!m.active) continue;
      m.life += dt;
      if (m.life >= m.ttl) {
        m.active = false;
        continue;
      }
      const a = 1 - m.life / m.ttl;
      const r0 = (m.kill ? 9 : 7) * s + (1 - a) * 5;
      const r1 = r0 + (m.kill ? 12 : 8) * s;
      ctx.strokeStyle = m.kill ? W.RED_FADE.get(a) : W.WHITE_FADE.get(a);
      ctx.lineWidth = m.kill ? 2 : 1.4;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const ang = Math.PI * 0.25 + (k * Math.PI) / 2 + (m.kill ? 0.4 : 0);
        const dx = Math.cos(ang);
        const dy = Math.sin(ang);
        ctx.moveTo(cx + dx * r0, cy + dy * r0);
        ctx.lineTo(cx + dx * r1, cy + dy * r1);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // ---- target boxes --------------------------------------------------------

  _drawTargets(dt) {
    const ctx = this.ctx;
    const game = this.game;
    const list = game?.targeting?.candidates || game?.enemies?.list;
    if (!list || !list.length) return;
    const focal = this._focal();
    const locked = game?.targeting?.target || null;
    const player = game?.player;
    const ppos = player?.root?.position;
    const w = this.w;
    const h = this.h;
    const sx = this.ui.safeX;
    const sy = this.ui.safeY;

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.alive === false || !e.root) continue;
      const st = this._ent(e);
      if (!st) continue;

      // stagger edge detection + flare decay
      const stag = !!e.stats?.staggered;
      if (stag && !st.prevStag) st.flare = 1;
      st.prevStag = stag;
      st.flare = Math.max(0, st.flare - dt * 1.9);

      let aim = e.root.position;
      if (typeof e.getAimPoint === 'function') {
        try {
          aim = e.getAimPoint(_v3) || _v3;
        } catch (err) {
          aim = e.root.position;
        }
      } else {
        _v3.copy(e.root.position);
        _v3.y += (e.collider?.height ?? 8) * 0.5;
        aim = _v3;
      }

      const p = this._project(aim, _proj);
      if (!p.ok) continue;
      const dist = ppos ? ppos.distanceTo(e.root.position) : p.dist;
      const isLocked = e === locked;

      if (!p.onScreen || p.x < sx * 0.4 || p.x > w - sx * 0.4 || p.y < sy * 0.4 || p.y > h - sy * 0.4) {
        this._drawOffscreen(p, dist, isLocked);
        continue;
      }

      const hRad = (e.collider?.height ?? 8) * 0.5;
      let half = clamp((hRad * focal) / Math.max(4, p.dist), 11, 190);
      const flare = st.flare;
      if (flare > 0) half *= 1 + flare * flare * 0.55;

      const apMax = Math.max(1, e.stats?.apMax ?? 1);
      const apT = clamp((e.stats?.ap ?? apMax) / apMax, 0, 1);
      const acsMax = Math.max(1, e.stats?.acsMax ?? 1);
      const acsT = clamp((e.stats?.acs ?? 0) / acsMax, 0, 1);

      const base = isLocked ? W.COL.red : stag ? W.COL.amber : 'rgba(150,225,240,0.62)';
      const bx = Math.round(p.x);
      const by = Math.round(p.y);
      const halfY = half;
      const halfX = half * 0.86;

      // bracket frame
      ctx.lineWidth = isLocked ? 1.6 : 1;
      ctx.strokeStyle = base;
      W.brackets(ctx, bx, by, halfX, halfX * 0.34, 0, halfY);
      if (isLocked) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,77,61,0.45)';
        W.brackets(ctx, bx, by, halfX + 4, (halfX + 4) * 0.26, 0, halfY + 4);
        W.edgeTicks(ctx, bx, by, halfX, halfY, 5);
      }
      ctx.lineWidth = 1;

      // stagger flare: expanding ring + call-out
      if (flare > 0) {
        const f = flare;
        ctx.strokeStyle = W.AMBER_FADE.get(f);
        ctx.lineWidth = lerp(1, 3, f);
        W.brackets(ctx, bx, by, halfX + (1 - f) * 40, 10, (1 - f) * 0.5, halfY + (1 - f) * 40);
        ctx.lineWidth = 1;
        W.setLabel(ctx, 12, 4, 700);
        W.fringeText(ctx, 'STAGGER', bx, by - halfY - 16, W.WHITE_FADE.get(Math.min(1, f * 1.6)), 1, 'center');
      }

      // gauges under the box: ACS above AP
      const gw = halfX * 2;
      const gx = bx - halfX;
      let gy = by + halfY + 4;
      if (acsT > 0.005) {
        const pulse = acsT > 0.72 ? 0.6 + 0.4 * Math.sin(this.time * 16) : 1;
        W.microBar(ctx, gx, gy, gw, 2, acsT, stag ? W.WHITE_FADE.get(pulse) : W.ACS_RAMP.get(acsT), 'rgba(255,176,56,0.12)');
        gy += 3;
      }
      W.microBar(ctx, gx, gy, gw, 2, apT, W.AP_RAMP.get(apT), 'rgba(111,242,255,0.14)');

      // locked target read-out
      if (isLocked) {
        const nm = (str(e, 'name', 'archetype', 'id') || 'HOSTILE').toUpperCase();
        W.setMono(ctx, 10, 1.2);
        W.text(ctx, nm, bx + halfX + 8, by - 3, '#ffd8d2', 'left');
        W.setMono(ctx, 11, 1.6);
        W.text(ctx, W.metres(dist) + 'M', bx + halfX + 8, by + 11, W.COL.amber, 'left');
        ctx.strokeStyle = 'rgba(255,77,61,0.4)';
        W.vline(ctx, bx + halfX + 4, by - 12, by + 14);
      } else if (dist < 400) {
        W.setMono(ctx, 9, 1);
        W.text(ctx, W.metres(dist), bx, by + halfY + 20, 'rgba(150,190,205,0.5)', 'center');
      }
    }
  }

  /** Off-screen / behind-camera target pointer pinned to the screen edge. */
  _drawOffscreen(p, dist, isLocked) {
    const ctx = this.ctx;
    const cx = this.w * 0.5;
    const cy = this.h * 0.5;
    W.edgeClamp(p.x, p.y, cx, cy, this.w * 0.5 - this.ui.safeX, this.h * 0.5 - this.ui.safeY, _edge);
    const col = isLocked ? W.COL.red : 'rgba(255,176,56,0.72)';
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    W.chevron(ctx, _edge.x, _edge.y, _edge.ang, isLocked ? 9 : 7, col);
    // tail bracket so it reads as an instrument, not a game arrow
    const bx = _edge.x - Math.cos(_edge.ang) * 12;
    const by = _edge.y - Math.sin(_edge.ang) * 12;
    ctx.strokeStyle = isLocked ? 'rgba(255,77,61,0.5)' : 'rgba(255,176,56,0.35)';
    W.arcSeg(ctx, bx, by, 7, _edge.ang - 1.05, _edge.ang + 1.05);
    W.setMono(ctx, 9, 0.8);
    const tx = _edge.x - Math.cos(_edge.ang) * 24;
    const ty = _edge.y - Math.sin(_edge.ang) * 24;
    W.text(ctx, W.metres(dist), tx, ty + 3, isLocked ? '#ffd8d2' : 'rgba(255,176,56,0.7)', 'center');
  }

  /** Per-entity HUD state (stagger flare). WeakMap so dead enemies drop out. */
  _ent(e) {
    if (!e || typeof e !== 'object') return null;
    let s = this.entState.get(e);
    if (!s) {
      s = { flare: 0, prevStag: false };
      this.entState.set(e, s);
    }
    return s;
  }

  // ---- damage numbers ------------------------------------------------------

  _onDamage(p) {
    if (!p) return;
    const info = p.info || p.damage || p;
    const victim = p.entity || p.target || p.victim || info.entity || info.target || null;
    const player = this.game?.player;
    const amount = num(info, 'amount', 'damage', 'value') ?? 0;
    if (amount <= 0) return;

    if (victim && victim === player) {
      this._onPlayerHit(p);
      return;
    }
    // only surface damage the player caused
    const src = info.source || p.source;
    if (src && player && src !== player) return;

    const pt = info.point || p.point || victim?.root?.position;
    if (!pt) return;
    const direct = !!(info.direct || p.direct);
    const n = this.dn[this.dnHead];
    this.dnHead = (this.dnHead + 1) % DN_POOL;
    n.active = true;
    n.pos.copy(pt);
    n.life = 0;
    n.direct = direct;
    n.kill = !!(p.kill || info.kill);
    n.ttl = direct ? 1.25 : 0.95;
    n.txt = String(Math.max(1, Math.round(amount)));
    n.size = direct ? 22 : 14;
    n.dx = (Math.random() - 0.5) * 26;
    this._pushHit(false);
  }

  _onPlayerHit(p) {
    const info = p?.info || p?.damage || p || null;
    const amount = num(info, 'amount', 'damage', 'value') ?? 0;
    const st = this.game?.player?.stats;
    const apMax = Math.max(1, st?.apMax ?? 1);
    this.hurt = clamp(this.hurt + 0.28 + (amount / apMax) * 2.2, 0, 1);

    // directional indicator — remember the attacker in world space so the arc
    // stays anchored while the player turns
    const ppos = this.game?.player?.root?.position;
    let sx = 0;
    let sz = 0;
    const src = info?.source || p?.source || p?.attacker;
    const from = src?.root?.position || info?.point || p?.point;
    if (ppos && from) {
      sx = from.x - ppos.x;
      sz = from.z - ppos.z;
    }
    if (sx === 0 && sz === 0) return;
    const a = this.arcs[this.arcHead];
    this.arcHead = (this.arcHead + 1) % ARC_POOL;
    a.active = true;
    a.life = 0;
    a.ttl = 1.35;
    a.x = sx;
    a.z = sz;
    a.mag = clamp(0.35 + (amount / apMax) * 4, 0.35, 1);
  }

  _pushHit(kill) {
    const m = this.hits[this.hitHead];
    this.hitHead = (this.hitHead + 1) % HM_POOL;
    m.active = true;
    m.life = 0;
    m.ttl = kill ? 0.45 : 0.26;
    m.kill = kill;
  }

  _drawDamageNumbers(dt) {
    const ctx = this.ctx;
    for (let i = 0; i < DN_POOL; i++) {
      const n = this.dn[i];
      if (!n.active) continue;
      n.life += dt;
      if (n.life >= n.ttl) {
        n.active = false;
        continue;
      }
      n.pos.y += dt * 2.6;
      const p = this._project(n.pos, _proj);
      if (!p.ok || !p.onScreen) continue;
      const k = n.life / n.ttl;
      const a = 1 - k * k;
      const pop = n.direct ? 1 + Math.exp(-n.life * 16) * 0.75 : 1 + Math.exp(-n.life * 20) * 0.3;
      const size = n.size * pop * clamp(60 / Math.max(20, p.dist), 0.55, 1.35);
      const x = p.x + n.dx;
      const y = p.y - k * 26;
      W.setMono(ctx, size, n.direct ? 1.4 : 0.6);
      if (n.direct) {
        W.fringeText(ctx, n.txt, x, y, W.WHITE_FADE.get(a), 1.2, 'center');
        W.setMono(ctx, size * 0.4, 2.4);
        W.text(ctx, 'DIRECT', x, y + size * 0.52, W.AMBER_FADE.get(a * 0.9), 'center');
      } else {
        W.text(ctx, n.txt, x + 1, y + 1, W.INK_FADE.get(a * 0.7), 'center');
        W.text(ctx, n.txt, x, y, W.CYAN_FADE.get(a), 'center');
      }
    }
  }

  _drawDamageArcs(dt) {
    const ctx = this.ctx;
    const cx = this.w * 0.5;
    const cy = this.h * 0.5;
    const r = Math.min(this.w, this.h) * 0.33;
    // screen-space bearing of the attacker relative to where we are looking
    const camYaw = Math.atan2(_fwd.x, _fwd.z);
    for (let i = 0; i < ARC_POOL; i++) {
      const a = this.arcs[i];
      if (!a.active) continue;
      a.life += dt;
      if (a.life >= a.ttl) {
        a.active = false;
        continue;
      }
      const fade = 1 - a.life / a.ttl;
      const yaw = Math.atan2(a.x, a.z);
      let d = yaw - camYaw;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      const ang = -Math.PI * 0.5 + d; // screen angle, 0 = up
      const span = 0.34 + a.mag * 0.2;
      ctx.lineWidth = lerp(2, 7, a.mag) * fade;
      ctx.strokeStyle = W.RED_FADE.get(fade * 0.85);
      W.arcSeg(ctx, cx, cy, r, ang - span, ang + span);
      ctx.lineWidth = 1;
      ctx.strokeStyle = W.RED_FADE.get(fade * 0.5);
      W.arcSeg(ctx, cx, cy, r + 6, ang - span * 0.6, ang + span * 0.6);
    }
  }

  // ---- compass -------------------------------------------------------------

  _drawCompass(dt) {
    const ctx = this.ctx;
    const cx = Math.round(this.w * 0.5);
    const y = Math.round(this.ui.compY);
    const half = this.ui.compW * 0.5;
    const SPAN = 70; // degrees visible across the strip
    const bearing = (Math.atan2(_fwd.x, -_fwd.z) * 180) / Math.PI;
    const pxPerDeg = (half * 2) / SPAN;

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - half, y - 14, half * 2, 34);
    ctx.clip();

    ctx.strokeStyle = 'rgba(111,242,255,0.16)';
    W.hline(ctx, cx - half, cx + half, y + 9);

    const start = Math.floor((bearing - SPAN * 0.5) / 5) * 5;
    for (let d = start; d <= bearing + SPAN * 0.5 + 5; d += 5) {
      let rel = d - bearing;
      const x = cx + rel * pxPerDeg;
      const dd = ((d % 360) + 360) % 360;
      const major = dd % 30 === 0;
      const fade = 1 - Math.abs(rel) / (SPAN * 0.5);
      ctx.strokeStyle = W.CYAN_FADE.get(clamp(fade, 0, 1) * (major ? 0.62 : 0.3));
      W.vline(ctx, x, y + 9, y + 9 - (major ? 8 : 4));
      if (major) {
        const lbl = dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : W.pad(dd, 3);
        W.setMono(ctx, dd % 90 === 0 ? 11 : 9, 1);
        W.text(ctx, lbl, x, y - 4, dd % 90 === 0 ? W.CYAN_FADE.get(clamp(fade, 0, 1)) : W.CYAN_FADE.get(clamp(fade, 0, 1) * 0.6), 'center');
      }
    }

    // hostile bearings under the strip
    const list = this.game?.enemies?.list;
    const ppos = this.game?.player?.root?.position;
    const locked = this.game?.targeting?.target;
    if (list && ppos) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || e.alive === false || !e.root) continue;
        const b2 = (Math.atan2(e.root.position.x - ppos.x, -(e.root.position.z - ppos.z)) * 180) / Math.PI;
        let rel = b2 - bearing;
        while (rel > 180) rel -= 360;
        while (rel < -180) rel += 360;
        if (Math.abs(rel) > SPAN * 0.5 + 2) continue;
        const x = cx + rel * pxPerDeg;
        const lockedOne = e === locked;
        ctx.strokeStyle = lockedOne ? W.COL.red : 'rgba(255,176,56,0.75)';
        W.chevron(ctx, x, y + 15, -Math.PI * 0.5, lockedOne ? 6 : 4.5, lockedOne ? W.COL.red : 'rgba(255,176,56,0.7)');
      }
    }
    ctx.restore();

    // centre index
    ctx.strokeStyle = W.COL.cyan;
    W.chevron(ctx, cx, y + 12, -Math.PI * 0.5, 5, W.COL.cyan);
    ctx.strokeStyle = 'rgba(111,242,255,0.4)';
    W.vline(ctx, cx, y + 9, y + 20);
    W.setMono(ctx, 10, 1.4);
    W.text(ctx, W.pad(Math.round(((bearing % 360) + 360) % 360), 3), cx, y + 32, 'rgba(190,226,236,0.8)', 'center');

    // strip end caps
    ctx.strokeStyle = 'rgba(111,242,255,0.3)';
    ctx.beginPath();
    ctx.moveTo(W.snap(cx - half), y + 3);
    ctx.lineTo(W.snap(cx - half), y + 9);
    ctx.moveTo(W.snap(cx + half), y + 3);
    ctx.lineTo(W.snap(cx + half), y + 9);
    ctx.stroke();
  }

  // ---- radar ---------------------------------------------------------------

  _drawRadar(dt) {
    const ctx = this.ctx;
    const cx = Math.round(this.ui.radarX);
    const cy = Math.round(this.ui.radarY);
    const r = this.ui.radarR;
    const RANGE = 260;

    ctx.strokeStyle = 'rgba(111,242,255,0.2)';
    W.arcSeg(ctx, cx, cy, r, 0, TAU);
    ctx.strokeStyle = 'rgba(111,242,255,0.1)';
    W.arcSeg(ctx, cx, cy, r * 0.66, 0, TAU);
    W.arcSeg(ctx, cx, cy, r * 0.33, 0, TAU);
    ctx.strokeStyle = 'rgba(111,242,255,0.14)';
    W.hline(ctx, cx - r, cx + r, cy);
    W.vline(ctx, cx, cy - r, cy + r);

    // sweep
    const sweep = (this.time * 1.15) % TAU;
    ctx.strokeStyle = 'rgba(111,242,255,0.3)';
    W.line(ctx, cx, cy, cx + Math.cos(sweep - Math.PI * 0.5) * r, cy + Math.sin(sweep - Math.PI * 0.5) * r);

    // player
    ctx.strokeStyle = W.COL.cyan;
    W.chevron(ctx, cx, cy, -Math.PI * 0.5, 5, W.COL.cyan);

    const list = this.game?.enemies?.list;
    const ppos = this.game?.player?.root?.position;
    if (list && ppos) {
      // radar is camera-relative: forward is up
      const fx = _fwd.x;
      const fz = _fwd.z;
      const fl = Math.hypot(fx, fz) || 1;
      const rx = _right.x;
      const rz = _right.z;
      const rl = Math.hypot(rx, rz) || 1;
      const locked = this.game?.targeting?.target;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || e.alive === false || !e.root) continue;
        const dx = e.root.position.x - ppos.x;
        const dz = e.root.position.z - ppos.z;
        const dy = e.root.position.y - ppos.y;
        let fwdC = (dx * fx + dz * fz) / fl;
        let rgtC = (dx * rx + dz * rz) / rl;
        let px = (rgtC / RANGE) * r;
        let py = (-fwdC / RANGE) * r;
        const len = Math.hypot(px, py);
        const clampedOut = len > r;
        if (clampedOut) {
          px = (px / len) * r;
          py = (py / len) * r;
        }
        const isLocked = e === locked;
        const col = isLocked ? W.COL.red : e.stats?.staggered ? W.COL.amber : 'rgba(255,110,80,0.85)';
        if (clampedOut) {
          ctx.strokeStyle = col;
          W.chevron(ctx, cx + px, cy + py, Math.atan2(py, px), 4, col);
        } else {
          ctx.fillStyle = col;
          ctx.fillRect(Math.round(cx + px) - 1.5, Math.round(cy + py) - 1.5, 3, 3);
          // elevation tick
          const ev = clamp(dy / 60, -1, 1);
          if (Math.abs(ev) > 0.05) {
            ctx.strokeStyle = isLocked ? 'rgba(255,77,61,0.7)' : 'rgba(255,110,80,0.5)';
            W.vline(ctx, cx + px, cy + py, cy + py - ev * 9);
          }
          if (isLocked) {
            ctx.strokeStyle = W.COL.red;
            W.rectSharp(ctx, cx + px - 4, cy + py - 4, 8, 8);
          }
        }
      }
    }

    W.setMono(ctx, 9, 1.2);
    W.text(ctx, 'RNG ' + W.itoa(RANGE) + 'M', cx, cy + r + 13, 'rgba(150,190,205,0.45)', 'center');
    W.setLabel(ctx, 9, 3, 700);
    W.text(ctx, 'SCAN', cx, cy - r - 8, 'rgba(111,242,255,0.55)', 'center');
  }

  // ---- speed tape + altitude ----------------------------------------------

  _drawSpeedTape(dt) {
    const ctx = this.ctx;
    const x = Math.round(this.ui.tapeX);
    const cy = Math.round(this.ui.tapeY);
    const h2 = this.ui.tapeH * 0.5;

    const cs = this.game?.controller?.state;
    let spd = num(cs, 'speed');
    if (spd === undefined) {
      const v = this.game?.player?.velocity;
      spd = v ? Math.hypot(v.x, v.y, v.z) : 0;
    }
    this.speedShown = damp(this.speedShown, spd, 12, dt);
    const s = this.speedShown;

    const PPU = h2 / 55; // px per m/s (±55 window)
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 42, cy - h2, 56, h2 * 2);
    ctx.clip();

    const first = Math.floor((s - 55) / 5) * 5;
    for (let v = first; v <= s + 55; v += 5) {
      if (v < 0) continue;
      const y = cy + (s - v) * PPU;
      const major = v % 25 === 0;
      const fade = 1 - Math.abs(y - cy) / h2;
      ctx.strokeStyle = W.CYAN_FADE.get(clamp(fade, 0, 1) * (major ? 0.55 : 0.26));
      W.hline(ctx, x - (major ? 13 : 7), x, y);
      if (major) {
        W.setMono(ctx, 9, 0.6);
        W.text(ctx, W.itoa(v), x - 17, y + 3, W.CYAN_FADE.get(clamp(fade, 0, 1) * 0.6), 'right');
      }
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(111,242,255,0.28)';
    W.vline(ctx, x, cy - h2, cy + h2);

    // current-value bug
    const bw = 42;
    ctx.fillStyle = 'rgba(5,9,13,0.8)';
    ctx.fillRect(x - bw, cy - 9, bw, 18);
    ctx.strokeStyle = W.COL.cyan;
    W.rectSharp(ctx, x - bw, cy - 9, bw, 18);
    W.setMono(ctx, 13, 0.6);
    W.text(ctx, W.itoa(Math.round(s)), x - 5, cy + 5, '#e6fbff', 'right');
    W.setLabel(ctx, 8, 2.4, 600);
    W.text(ctx, 'M/S', x + 6, cy + 4, 'rgba(150,190,205,0.6)', 'left');

    // altitude — queried at 6 Hz because groundHeight may be a real trace
    this.altTimer += dt;
    if (this.altTimer > 0.16) {
      this.altTimer = 0;
      const pp = this.game?.player?.root?.position;
      if (pp) {
        let g = 0;
        try {
          g = this.game?.physics?.groundHeight?.(pp.x, pp.z) ?? 0;
        } catch (err) {
          g = 0;
        }
        if (!isFinite(g)) g = 0;
        this.altTarget = Math.max(0, pp.y - g);
      }
    }
    this.altShown = damp(this.altShown, this.altTarget || 0, 10, dt);
    W.setLabel(ctx, 8, 2.6, 600);
    W.text(ctx, 'ALT', x + 6, cy + h2 + 16, 'rgba(150,190,205,0.5)', 'left');
    W.setMono(ctx, 12, 0.8);
    W.text(ctx, W.pad(Math.round(this.altShown), 4), x - 2, cy + h2 + 17, '#cdeef8', 'right');

    const grounded = !!this.game?.controller?.state?.grounded;
    W.setMono(ctx, 8.5, 1.4);
    W.text(ctx, grounded ? 'GRND CONTACT' : 'AIRBORNE', x - 2, cy + h2 + 30, grounded ? 'rgba(150,190,205,0.45)' : 'rgba(255,176,56,0.7)', 'right');
  }

  /** Corner registration marks — cheap, and they sell the "instrument" read. */
  _drawFrameMarks() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const m = 12;
    const L = 16;
    ctx.strokeStyle = 'rgba(111,242,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(m, m + L);
    ctx.lineTo(m, m);
    ctx.lineTo(m + L, m);
    ctx.moveTo(w - m - L, m);
    ctx.lineTo(w - m, m);
    ctx.lineTo(w - m, m + L);
    ctx.moveTo(m, h - m - L);
    ctx.lineTo(m, h - m);
    ctx.lineTo(m + L, h - m);
    ctx.moveTo(w - m - L, h - m);
    ctx.lineTo(w - m, h - m);
    ctx.lineTo(w - m, h - m - L);
    ctx.stroke();
  }

  // =========================================================================

  dispose() {
    if (this._offs) for (const off of this._offs) off?.();
    this._offs = null;
    window.removeEventListener('resize', this._onResize);
    this.root?.removeEventListener('click', this._onClick);
    this.root?.remove();
    this.root = null;
    this.ctx = null;
    this.canvas = null;
    this.logLines.length = 0;
    this.logQueue.length = 0;
  }
}

export default HUD;
