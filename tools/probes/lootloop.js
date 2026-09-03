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

  // ---- 1. does a death emit a drop, and does a pickup appear? -------------
  const spot = debug.aheadOfPlayer(18, 0, new THREE.Vector3());
  const e = debug.spawnEnemyOnGround('mt', spot.x, spot.z, 1, 0);
  debug.step(0.3);
  out.enemySpawned = !!e;
  out.enemyPos = e?.root?.position?.toArray?.().map((n) => +n.toFixed(1)) ?? null;

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
  const ent = e || (game.enemies?.list || [])[0];
  if (ent) {
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
  }
  debug.step(2.0);

  out.dropEventsFired = dropEvents;
  out.enemyAliveAfter = ent ? ent.alive !== false : null;
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
