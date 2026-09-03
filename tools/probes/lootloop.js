// Does the LOOTER half of "looter shooter" actually work?
//
// Every review pass on this project has graded pictures. Nobody has once
// checked the loop the genre is named after: kill something, have it drop
// parts, pick them up, get them into the inventory, equip one, and have the
// mech's numbers actually change. The wiring READS correct —
// EnemyManager emits LOOT_DROP on death, LootSystem listens and spawns
// pickups, _collect emits LOOT_PICKUP, and HUD/Garage/Audio all subscribe —
// but on this project "the wiring reads correct" has never once been evidence
// that a thing works. Two enemies-invisible bugs, a plume chain broken in
// four places, and a loadout whose multipliers were all pinned at their clamp
// floors all read correct too.
//
// So walk the whole chain and report where it stops. Each stage is reported
// separately, because "no loot appeared" has at least five distinct causes
// and they need completely different fixes.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  const bus = game.bus || window.__ACNTR__.bus;

  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.resetState();
  debug.placePlayerInOpenGround({ ahead: 70 });
  debug.step(0.5);

  const loot = game.loot;
  const loadout = game.loadout;
  const out = {
    haveLootSystem: !!loot,
    haveLoadout: !!loadout,
    inventoryBefore: loadout?.inventory?.length ?? null,
    // What the mech's derived numbers are before anything changes, so an
    // equip that silently does nothing is visible as a no-op rather than
    // being taken on trust.
    statsBefore: (() => {
      const d = loadout?.derived || loadout?.stats || null;
      if (!d) return null;
      return Object.fromEntries(Object.entries(d)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => [k, +v.toFixed(2)]));
    })(),
  };

  // ---- 0. does the SPAWN PATH work at all, independent of luck? ----------
  // `mt` drops on a 0.48 chance roll, so a single kill that yields nothing is
  // the drop table working, not a bug — a one-kill test very nearly got a
  // healthy system reported as broken. Separate the two questions: call
  // `dropAt` directly, which skips the chance roll entirely, so this stage
  // fails ONLY if materialising a pickup is genuinely broken.
  const here = debug.aheadOfPlayer(6, 0, new THREE.Vector3());
  let directErr = null;
  let direct = null;
  try {
    direct = loot?.dropAt?.(here);
  } catch (err) {
    directErr = String(err && err.stack ? err.stack : err).slice(0, 400);
  }
  out.directDropReturned = !!direct;
  out.directDropError = directErr;
  out.pickupsAfterDirectDrop = loot?._active?.length ?? null;
  loot?.clear?.();

  // ---- 1. does a death emit a drop, and does a pickup appear? -------------
  // KILL A POPULATION, NOT ONE ENEMY. `mt` drops on a 0.48 roll, so a single
  // kill yields nothing about half the time and a one-sample test cannot tell
  // a broken drop from an unlucky one. Twelve kills makes a total miss a
  // 0.52^12 = 0.03% event, so zero drops here really does mean broken.
  const KILLS = 12;
  const spawned = [];
  for (let i = 0; i < KILLS; i++) {
    const spot = debug.aheadOfPlayer(18 + (i % 4) * 6, ((i % 5) - 2) * 7, new THREE.Vector3());
    const en = debug.spawnEnemyOnGround('mt', spot.x, spot.z, 1, 0);
    if (en) spawned.push(en);
  }
  debug.step(0.3);
  const e = spawned[0] || null;
  out.enemiesSpawnedForKilling = spawned.length;
  out.enemyPos = e?.root?.position?.toArray?.().map((n) => +n.toFixed(1)) ?? null;
  out.expectedDropsFrom12Mts = '≈5.8 (0.48 chance × 12)';

  // Count pickups before, so a drop is measured as a DELTA — the level may
  // already contain loot and an absolute count would read as success.
  const countPickups = () => (loot?._live?.length ?? loot?.pickups?.length
    ?? loot?._active?.length ?? null);
  out.pickupsBeforeKill = countPickups();

  let dropEvents = 0;
  let pickupEvents = 0;
  const offDrop = bus?.on?.('loot:drop', () => { dropEvents++; });
  const offPick = bus?.on?.('loot:pickup', () => { pickupEvents++; });

  // Kill it the way the game does — through the damage path, not by setting
  // a flag. A death that skips the damage system also skips whatever emits
  // the drop, which would make this probe agree with itself and prove
  // nothing.
  const targets = (game.enemies?.list || []).filter((x) => x && x.alive !== false);
  const killErrors = [];
  for (const ent of targets) {
    try {
      const hp = ent.stats?.apMax ?? ent.stats?.ap ?? 100000;
      game.damage?.applyDamage?.(ent, { amount: hp * 4, type: 'kinetic', source: game.player.entity });
      if (ent.alive !== false && ent.stats) {
        // Fall back to draining AP directly if the damage system has a
        // different entry point, and say so, so the result is not silently
        // measuring a different thing than the game does.
        out.usedDirectApDrain = true;
        ent.stats.ap = 0;
        ent.onDeath?.();
      }
    } catch (err) {
      killErrors.push(String(err && err.stack ? err.stack : err).slice(0, 300));
    }
  }
  out.killsAttempted = targets.length;
  out.killErrors = killErrors.slice(0, 3);
  // Step in slices and catch a throw from inside update(), so a crash in the
  // loot animation path is reported here rather than killing the whole probe
  // and taking every other answer with it.
  let updateError = null;
  for (let i = 0; i < 8; i++) {
    try { debug.step(0.25); } catch (err) {
      updateError = String(err && err.stack ? err.stack : err).slice(0, 500);
      break;
    }
  }
  out.updateError = updateError;

  out.dropEventsFired = dropEvents;
  out.enemiesStillAlive = (game.enemies?.list || []).filter((x) => x && x.alive !== false).length;
  out.pickupsAfterKill = countPickups();

  // ---- 2. can the player actually collect one? ---------------------------
  // Walk the mech onto the drop rather than teleporting the pickup, so the
  // real collection radius and the real update order are exercised.
  const live = loot?._live || loot?.pickups || loot?._active || [];
  const first = live[0];
  out.firstPickupPos = first?.root?.position?.toArray?.().map((n) => +n.toFixed(1)) ?? null;
  if (first?.root) {
    const q = first.root.position;
    debug.placePlayerOnGround(q.x, q.z, debug.yaw());
    debug.step(2.0);
  }
  out.pickupEventsFired = pickupEvents;
  out.pickupsAfterWalk = countPickups();
  out.inventoryAfter = loadout?.inventory?.length ?? null;

  // ---- 3. does equipping something change the mech? ----------------------
  const inv = loadout?.inventory || [];
  const cand = inv[inv.length - 1] || null;
  out.equipCandidate = cand ? { name: cand.name ?? cand.id ?? '?', slot: cand.slot ?? '?', rarity: cand.rarity ?? '?' } : null;
  if (cand && loadout?.equip) {
    try {
      loadout.equip(cand, cand.slot);
      loadout.recompute?.();
      out.equipped = true;
    } catch (err) {
      out.equipError = String(err).slice(0, 200);
    }
  }
  debug.step(0.5);
  out.statsAfter = (() => {
    const d = loadout?.derived || loadout?.stats || null;
    if (!d) return null;
    return Object.fromEntries(Object.entries(d)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => [k, +v.toFixed(2)]));
  })();
  // The single question the whole probe exists to answer at this stage: did
  // any derived number move? A loadout that accepts an equip and changes
  // nothing is the exact shape of the bug that pinned every multiplier at its
  // clamp floor for weeks.
  out.statsChanged = (() => {
    const a = out.statsBefore; const b = out.statsAfter;
    if (!a || !b) return null;
    return Object.keys(a).filter((k) => a[k] !== b[k]);
  })();

  offDrop?.(); offPick?.();
  return out;
})();
