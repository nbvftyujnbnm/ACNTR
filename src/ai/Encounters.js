import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import * as M from '../core/MathUtils.js';

/**
 * Encounters.js — mission scripting for the arena.
 *
 * Five beats, each teaching a different thing before the set piece:
 *   1. CONTACT     MT patrol, dropship insertion        → learn the basics
 *   2. AIR PATROL  flyer pack, warp-in                  → learn to look up
 *   3. STRONGPOINT MTs + tank + sniper on the tower     → learn cover & flanking
 *   4. INTERCEPT   the rival AC duel                    → the skill check
 *   5. OUROBOROS   the boss                             → everything at once
 *
 * The director never spawns on top of the player: arrivals happen at distance,
 * with a dropship fly-in or a warp flash + landing shockwave so the player always
 * gets a cue before anything shoots.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Mission definition
// ---------------------------------------------------------------------------

export const MISSION_NAME = 'OPERATION WATCHPOINT — SECTOR 7 REFINERY';

export const MISSION_WAVES = [
  {
    id: 'contact',
    objective: 'ELIMINATE MT PATROL',
    intro: [
      'MISSION START — ' + MISSION_NAME,
      'SWEEP THE SECTOR. ALL HOSTILES ARE VALID TARGETS.',
    ],
    arrivalLog: 'HOSTILE DROPSHIP INBOUND — MT PATROL',
    delivery: 'dropship',
    clearAt: 0.0,
    breather: 5.0,
    groups: [{ archetype: 'mt', tier: 1, count: 4, squad: 'patrol-a', minDist: 85, prefer: 'ground' }],
  },
  {
    id: 'air',
    objective: 'DOWN THE DRONE FLIGHT',
    arrivalLog: 'MULTIPLE AIRBORNE CONTACTS — LD-2 FLIGHT',
    delivery: 'warp',
    clearAt: 0.2,
    breather: 5.5,
    groups: [
      { archetype: 'flyer', tier: 1, count: 3, squad: 'flight-a', minDist: 90, prefer: 'air', altitude: 26 },
      { archetype: 'flyer', tier: 2, count: 2, squad: 'flight-b', minDist: 110, prefer: 'air', altitude: 34 },
    ],
  },
  {
    id: 'strongpoint',
    objective: 'BREAK THE STRONGPOINT',
    arrivalLog: 'FORTIFIED POSITION DETECTED — ARTILLERY AND LONG-RANGE SUPPORT',
    delivery: 'mixed',
    clearAt: 0.2,
    breather: 6.5,
    groups: [
      { archetype: 'sniper', tier: 2, count: 1, squad: 'overwatch', minDist: 150, prefer: 'perch', delivery: 'warp' },
      { archetype: 'tank', tier: 2, count: 1, squad: 'strong-a', minDist: 95, prefer: 'ground', delivery: 'dropship' },
      { archetype: 'mt', tier: 2, count: 4, squad: 'strong-a', minDist: 85, prefer: 'ground', delivery: 'dropship' },
    ],
  },
  {
    id: 'intercept',
    objective: 'DEFEAT AC "ASHFALL"',
    arrivalLog: 'WARNING — INDEPENDENT MERCENARY INBOUND. AC "ASHFALL".',
    delivery: 'warp',
    clearAt: 0.0,
    breather: 7.0,
    groups: [{ archetype: 'ac', tier: 3, count: 1, squad: 'ashfall', minDist: 95, prefer: 'ground' }],
  },
  {
    id: 'ouroboros',
    objective: 'DESTROY IB-C01 OUROBOROS',
    arrivalLog: 'MASSIVE ENERGY SIGNATURE — IB-C01 OUROBOROS IS AWAKE.',
    delivery: 'boss',
    clearAt: 0.0,
    breather: 0,
    boss: true,
    groups: [
      { archetype: 'boss', tier: 3, count: 1, squad: 'ouroboros', minDist: 120, prefer: 'ground' },
      { archetype: 'mt', tier: 3, count: 2, squad: 'ouroboros-escort', minDist: 100, prefer: 'ground', delay: 3.5 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Dropship — a cheap procedural insertion cue
// ---------------------------------------------------------------------------

/**
 * A boxy VTOL that flies in from outside the arena, hovers, drops its cargo and
 * leaves. Purely a telegraph: it has no collision and cannot be damaged, but it
 * tells the player exactly where trouble is about to land.
 */
class Dropship {
  constructor(scene, assets) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.visible = false;

    const hull = new THREE.Mesh(assets.hull, assets.body);
    hull.castShadow = true;
    this.root.add(hull);

    const nose = new THREE.Mesh(assets.nose, assets.body);
    nose.position.set(0, 0.3, -7.5);
    this.root.add(nose);

    const finL = new THREE.Mesh(assets.fin, assets.body);
    finL.position.set(-5.4, 0.6, 2.2);
    this.root.add(finL);
    const finR = finL.clone();
    finR.position.x = 5.4;
    this.root.add(finR);

    this.engines = [];
    for (let i = 0; i < 4; i++) {
      const e = new THREE.Mesh(assets.engine, assets.glow);
      e.position.set(i < 2 ? -5.4 : 5.4, -0.9, i % 2 ? 3.6 : -1.4);
      this.root.add(e);
      this.engines.push(e);
    }
    const belly = new THREE.Mesh(assets.belly, assets.glow);
    belly.position.y = -1.9;
    belly.rotation.x = -Math.PI / 2;
    this.root.add(belly);

    scene?.add(this.root);

    this.active = false;
    this.t = 0;
    this.phase = 'in';
    this.from = new THREE.Vector3();
    this.hover = new THREE.Vector3();
    this.to = new THREE.Vector3();
    this.onDrop = null;
    this.dropTimer = 0;
    this.dropsLeft = 0;
  }

  launch(hoverPos, dropCount, onDrop) {
    this.active = true;
    this.root.visible = true;
    this.t = 0;
    this.phase = 'in';
    this.hover.copy(hoverPos);

    // enter from outside the arena along a random bearing, exit on the far side
    const a = Math.random() * Math.PI * 2;
    const R = 300;
    this.from.set(hoverPos.x + Math.cos(a) * R, hoverPos.y + 120, hoverPos.z + Math.sin(a) * R);
    this.to.set(hoverPos.x - Math.cos(a) * R, hoverPos.y + 140, hoverPos.z - Math.sin(a) * R);
    this.root.position.copy(this.from);
    this.dropsLeft = dropCount;
    this.dropTimer = 0.55;
    this.onDrop = onDrop || null;
    bus.emit(EV.SFX, { id: 'dropship', position: this.root.position });
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const p = this.root.position;

    if (this.phase === 'in') {
      const k = M.smootherstep(0, 1, M.clamp(this.t / 4.2, 0, 1));
      p.lerpVectors(this.from, this.hover, k);
      p.y += Math.sin(k * Math.PI) * 26; // arc in rather than a straight line
      if (k >= 1) {
        this.phase = 'hover';
        this.t = 0;
      }
    } else if (this.phase === 'hover') {
      p.y = this.hover.y + Math.sin(this.t * 2.4) * 0.6;
      this.dropTimer -= dt;
      if (this.dropTimer <= 0 && this.dropsLeft > 0) {
        this.dropTimer = 0.45;
        this.dropsLeft--;
        _v.copy(p);
        _v.y -= 3;
        _v.x += (Math.random() - 0.5) * 7;
        _v.z += (Math.random() - 0.5) * 7;
        this.onDrop?.(_v);
      }
      if (this.dropsLeft <= 0 && this.t > 1.6) {
        this.phase = 'out';
        this.t = 0;
      }
    } else {
      const k = M.smoothstep(0, 1, M.clamp(this.t / 4.5, 0, 1));
      p.lerpVectors(this.hover, this.to, k);
      if (k >= 1) this.retire();
    }

    // face travel direction
    _v2.copy(this.phase === 'in' ? this.hover : this.to).sub(p);
    _v2.y = 0;
    if (_v2.lengthSq() > 1) this.root.rotation.y = Math.atan2(-_v2.x, -_v2.z);
    this.root.rotation.z = Math.sin(this.t * 1.4) * 0.06;
  }

  retire() {
    this.active = false;
    this.root.visible = false;
    this.onDrop = null;
  }

  dispose() {
    this.scene?.remove(this.root);
  }
}

// ---------------------------------------------------------------------------
// EncounterDirector
// ---------------------------------------------------------------------------

export class EncounterDirector {
  /** @param {import('./EnemyManager.js').EnemyManager} manager */
  constructor(manager) {
    this.manager = manager;
    this.scene = manager?.scene || null;
    this.waves = MISSION_WAVES;
    this.waveIndex = 0;
    this.phase = 'idle'; // idle | spawning | fighting | breather | complete
    this.player = null;
    this.autoStart = true;
    this.startDelay = 3.0;

    this._timer = 0;
    this._queue = []; // pending spawn instructions for the active wave
    this._waveSpawned = 0;
    this._waveTag = -1;
    this._landing = []; // entities dropped in mid-air, awaiting a landing thump
    this._victoryTimer = -1;
    this._introDone = false;

    this._ships = [];
    this._shipAssets = null;
    this._rng = M.mulberry32(0xace0f);
  }

  setPlayer(p) {
    this.player = p || null;
  }

  // -- assets ---------------------------------------------------------------

  _ensureShipAssets() {
    if (this._shipAssets) return this._shipAssets;
    const body = new THREE.MeshStandardMaterial({ color: 0x33383f, metalness: 1, roughness: 0.5 });
    const glow = new THREE.MeshBasicMaterial({
      color: 0x7fd8ff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this._shipAssets = {
      hull: new THREE.BoxGeometry(9, 4, 16),
      nose: new THREE.BoxGeometry(5.5, 2.6, 4),
      fin: new THREE.BoxGeometry(2.4, 3.4, 5),
      engine: new THREE.CylinderGeometry(1.5, 1.9, 2.2, 10),
      belly: new THREE.PlaneGeometry(7, 12),
      body,
      glow,
    };
    return this._shipAssets;
  }

  _getShip() {
    for (let i = 0; i < this._ships.length; i++) if (!this._ships[i].active) return this._ships[i];
    if (this._ships.length >= 3) return null;
    const s = new Dropship(this.scene, this._ensureShipAssets());
    this._ships.push(s);
    return s;
  }

  // -- spawn point selection -------------------------------------------------

  /**
   * Pick somewhere to put a hostile: never on the player, preferring the level's
   * authored spawn points and falling back to a ring around the arena.
   */
  _pickSpawn(prefer, minDist, out) {
    const level = this.manager?.level;
    const pts = level?.spawnPoints;
    const playerPos = this.player?.root?.position;

    if (prefer === 'perch') {
      if (this._findPerch(out, minDist)) return out;
    }

    if (pts && pts.length) {
      let best = null;
      let bestScore = -1e9;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p) continue;
        let d = 1e4;
        if (playerPos) {
          const dx = p.x - playerPos.x;
          const dz = p.z - playerPos.z;
          d = Math.sqrt(dx * dx + dz * dz);
        }
        if (d < minDist) continue;
        // prefer points that are "just far enough" so fights stay in the arena
        let score = -Math.abs(d - minDist * 1.25) + this._rng() * 40;
        if (prefer === 'perch') score += p.y * 3;
        if (prefer === 'air') score += 10;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      if (best) {
        out.copy(best);
        out.x += (this._rng() - 0.5) * 12;
        out.z += (this._rng() - 0.5) * 12;
        return out;
      }
    }

    // fallback ring around the player (or the origin)
    const arena = level?.arenaRadius || 240;
    const r = Math.min(arena * 0.72, Math.max(minDist * 1.15, 90));
    const a = this._rng() * Math.PI * 2;
    const cx = playerPos ? playerPos.x : 0;
    const cz = playerPos ? playerPos.z : 0;
    let x = cx + Math.cos(a) * r;
    let z = cz + Math.sin(a) * r;
    // keep it inside the arena
    const rr = Math.sqrt(x * x + z * z);
    if (rr > arena * 0.85) {
      x *= (arena * 0.85) / rr;
      z *= (arena * 0.85) / rr;
    }
    const g = this.manager?.physics?.groundHeight?.(x, z) ?? 0;
    out.set(x, g, z);
    return out;
  }

  /** Find a rooftop for the sniper: high authored spawn point, or a structure top. */
  _findPerch(out, minDist) {
    const level = this.manager?.level;
    const pts = level?.spawnPoints;
    const playerPos = this.player?.root?.position;
    let best = null;
    let bestY = 14;
    if (pts) {
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p || p.y < bestY) continue;
        if (playerPos && p.distanceTo(playerPos) < minDist) continue;
        best = p;
        bestY = p.y;
      }
    }
    if (best) {
      out.copy(best);
      out.y += 2;
      return true;
    }

    // probe downward from high altitude to find something to stand on
    const physics = this.manager?.physics;
    const arena = level?.arenaRadius || 240;
    if (physics?.raycast) {
      for (let i = 0; i < 10; i++) {
        const a = this._rng() * Math.PI * 2;
        const r = arena * (0.35 + this._rng() * 0.4);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (playerPos) {
          const dx = x - playerPos.x;
          const dz = z - playerPos.z;
          if (dx * dx + dz * dz < minDist * minDist) continue;
        }
        _v.set(x, 220, z);
        _v2.set(0, -1, 0);
        const hit = physics.raycast(_v, _v2, 400);
        if (!hit || hit.hit === false || !hit.point) continue;
        const ground = physics.groundHeight?.(x, z) ?? 0;
        if (hit.point.y - ground > 16) {
          out.copy(hit.point);
          out.y += 3;
          return true;
        }
      }
    }

    // last resort: hover high — the sniper archetype can hold altitude
    this._pickSpawn('ground', minDist, out);
    out.y += 30;
    return true;
  }

  // -- wave flow -------------------------------------------------------------

  /** Queue every group of a wave; delivery decides how each group arrives. */
  _beginWave(index) {
    const wave = this.waves[index];
    if (!wave) {
      this._complete();
      return;
    }
    this.waveIndex = index;
    this._waveTag = index;
    this._waveSpawned = 0;
    this._queue.length = 0;
    this.phase = 'spawning';
    this._timer = 0;

    if (wave.intro && !this._introDone) {
      this._introDone = true;
      for (let i = 0; i < wave.intro.length; i++) this.log(wave.intro[i]);
    }
    this.log(`OBJECTIVE: ${wave.objective}`);
    if (wave.arrivalLog) this.log(wave.arrivalLog);
    bus.emit('mission:wave', { index, id: wave.id, objective: wave.objective, boss: !!wave.boss });

    for (let g = 0; g < wave.groups.length; g++) {
      const grp = wave.groups[g];
      this._queue.push({
        group: grp,
        delivery: grp.delivery || wave.delivery || 'warp',
        delay: grp.delay ?? g * 0.6,
        done: false,
      });
    }
  }

  _spawnGroup(item) {
    const grp = item.group;
    const delivery = item.delivery;
    const manager = this.manager;
    if (!manager) return;

    const minDist = grp.minDist ?? 80;
    this._pickSpawn(grp.prefer || 'ground', minDist, _v3);

    if (delivery === 'dropship') {
      const ship = this._getShip();
      if (ship) {
        _v.copy(_v3);
        _v.y += 34;
        const self = this;
        ship.launch(_v, grp.count, function (dropPos) {
          self._materialise(grp, dropPos, true);
        });
        return;
      }
      // no ship available — fall through to a warp-in
    }

    if (delivery === 'boss') {
      this._bossArrival(grp, _v3);
      return;
    }

    // warp-in: stagger a flash per unit around the anchor point
    for (let i = 0; i < grp.count; i++) {
      const a = (i / Math.max(1, grp.count)) * Math.PI * 2 + this._rng() * 0.6;
      const r = grp.count > 1 ? 9 + this._rng() * 9 : 0;
      _v.set(_v3.x + Math.cos(a) * r, _v3.y + (grp.altitude || 0), _v3.z + Math.sin(a) * r);
      if (grp.prefer !== 'air' && grp.prefer !== 'perch') {
        _v.y = (this.manager?.physics?.groundHeight?.(_v.x, _v.z) ?? _v3.y) + 1;
      }
      this._materialise(grp, _v, false);
    }
  }

  /** Actually create the enemy, with the arrival flash / landing hook. */
  _materialise(grp, pos, fromAir) {
    const manager = this.manager;
    if (!manager) return null;
    const e = manager.spawn(grp.archetype, grp.tier, pos, { squad: grp.squad });
    if (!e) return null;
    e.waveTag = this._waveTag;
    this._waveSpawned++;

    // arrival cue: a vertical flash column, a burst ring and a light explosion
    manager.vfx?.explosion?.(pos, 4.5, { color: 0x8fd8ff, energy: true, light: true });
    manager.telegraphs?.burst?.(pos, 14, 0.55, 0x8fd8ff);
    _v2.copy(pos);
    _v2.y += 40;
    manager.telegraphs?.line?.(e.id * 8 + 7, pos, _v2, 0x8fd8ff, 0.6, 0.5);
    bus.emit(EV.SFX, { id: 'warp_in', position: pos });

    if (fromAir || pos.y > (manager.physics?.groundHeight?.(pos.x, pos.z) ?? 0) + 4) {
      e.velocity.y = -6;
      this._landing.push(e);
    }
    return e;
  }

  _bossArrival(grp, pos) {
    const manager = this.manager;
    _v.copy(pos);
    const g = manager?.physics?.groundHeight?.(_v.x, _v.z) ?? 0;
    _v.y = g;
    manager?.telegraphs?.burst?.(_v, 60, 1.4, 0xff2d6f);
    manager?.vfx?.explosion?.(_v, 26, { color: 0xff2d6f, energy: true });
    manager?.vfx?.shockwave?.(_v, 48);
    bus.emit(EV.SHAKE, { intensity: 1.6, duration: 1.6 });
    bus.emit(EV.SFX, { id: 'boss_arrival', position: _v });
    _v.y = g + 40;
    const e = this._materialise(grp, _v, true);
    if (e) e.velocity.y = -14;
  }

  // -- frame -----------------------------------------------------------------

  update(dt, elapsed) {
    for (let i = 0; i < this._ships.length; i++) this._ships[i].update(dt);
    this._updateLandings();

    if (this._victoryTimer >= 0) {
      this._victoryTimer -= dt;
      if (this._victoryTimer <= 0) {
        this._victoryTimer = -1;
        this._complete();
      }
      return;
    }

    switch (this.phase) {
      case 'idle': {
        if (!this.autoStart || !this.player) return;
        this._timer += dt;
        if (this._timer >= this.startDelay) this._beginWave(0);
        break;
      }

      case 'spawning': {
        this._timer += dt;
        let pending = 0;
        for (let i = 0; i < this._queue.length; i++) {
          const item = this._queue[i];
          if (item.done) continue;
          if (this._timer >= item.delay) {
            item.done = true;
            this._spawnGroup(item);
          } else pending++;
        }
        // wait for dropships to finish unloading before calling the wave live
        let shipsBusy = false;
        for (let i = 0; i < this._ships.length; i++) {
          if (this._ships[i].active && this._ships[i].dropsLeft > 0) shipsBusy = true;
        }
        if (!pending && !shipsBusy) {
          this.phase = 'fighting';
          this._timer = 0;
        }
        break;
      }

      case 'fighting': {
        this._timer += dt;
        const remaining = this._waveAlive();
        const wave = this.waves[this.waveIndex];
        const threshold = Math.floor((wave?.clearAt ?? 0) * this._waveSpawned);
        if (remaining <= threshold) {
          if (wave?.boss) return; // the boss ends the mission, not the wave loop
          this.phase = 'breather';
          this._timer = 0;
          this.log('SECTOR CLEAR — HOLD POSITION');
          bus.emit('mission:waveClear', { index: this.waveIndex });
        }
        break;
      }

      case 'breather': {
        this._timer += dt;
        const wave = this.waves[this.waveIndex];
        if (this._timer >= (wave?.breather ?? 5)) {
          if (this.waveIndex + 1 < this.waves.length) this._beginWave(this.waveIndex + 1);
          else this._complete();
        }
        break;
      }

      default:
        break;
    }
  }

  /** Air-dropped units thump the ground on arrival — the landing shockwave cue. */
  _updateLandings() {
    for (let i = this._landing.length - 1; i >= 0; i--) {
      const e = this._landing[i];
      if (!e?.alive) {
        this._landing.splice(i, 1);
        continue;
      }
      const grounded = e.brain?.bb?.grounded;
      const g = this.manager?.physics?.groundHeight?.(e.root.position.x, e.root.position.z) ?? 0;
      if (grounded || e.root.position.y <= g + 0.6) {
        this._landing.splice(i, 1);
        _v.copy(e.root.position);
        this.manager?.vfx?.shockwave?.(_v, (e.collider?.radius || 2) * 5);
        this.manager?.telegraphs?.burst?.(_v, (e.collider?.radius || 2) * 6, 0.5, 0xffc98a);
        this.manager?.vfx?.smoke?.(_v, UP, 1.6);
        bus.emit(EV.SHAKE, { intensity: 0.18, duration: 0.22 });
        bus.emit(EV.SFX, { id: 'mech_land', position: _v });
      }
    }
  }

  _waveAlive() {
    const list = this.manager?.list;
    if (!list) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e?.alive && e.waveTag === this._waveTag) n++;
    }
    return n;
  }

  // -- events ----------------------------------------------------------------

  onEnemyKilled(entity) {
    if (!entity) return;
    if (entity.isBoss) {
      this.log('IB-C01 OUROBOROS DESTROYED');
      this._victoryTimer = 3.2; // let the death sequence play before the banner
      return;
    }
    if (entity.archetype === 'ac') this.log('AC "ASHFALL" DESTROYED — SALVAGE RECOVERED');
    const remaining = this._waveAlive();
    if (this.phase === 'fighting' && remaining > 0 && remaining <= 2) {
      this.log(`HOSTILES REMAINING: ${remaining}`);
    }
  }

  _complete() {
    if (this.phase === 'complete') return;
    this.phase = 'complete';
    this.log('MISSION COMPLETE — ALL OBJECTIVES ACHIEVED');
    bus.emit(EV.MISSION_COMPLETE, { mission: MISSION_NAME, waves: this.waves.length });
  }

  /** Mission-log line for the HUD. */
  log(text) {
    bus.emit('mission:log', { text });
  }

  // -- lifecycle -------------------------------------------------------------

  reset() {
    this.waveIndex = 0;
    this.phase = 'idle';
    this._timer = 0;
    this._queue.length = 0;
    this._landing.length = 0;
    this._waveSpawned = 0;
    this._waveTag = -1;
    this._victoryTimer = -1;
    this._introDone = false;
    for (let i = 0; i < this._ships.length; i++) this._ships[i].retire();
  }

  dispose() {
    for (let i = 0; i < this._ships.length; i++) this._ships[i].dispose();
    this._ships.length = 0;
    const a = this._shipAssets;
    if (a) {
      a.hull.dispose();
      a.nose.dispose();
      a.fin.dispose();
      a.engine.dispose();
      a.belly.dispose();
      a.body.dispose();
      a.glow.dispose();
      this._shipAssets = null;
    }
    this._landing.length = 0;
    this._queue.length = 0;
  }
}

export default EncounterDirector;
