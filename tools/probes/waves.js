// Does the mission actually progress?
//
// The HUD reads "THREATS 04 / WAVE 01", and nothing has ever checked that the
// second number can become 02. `EncounterDirector` carries a phase machine —
// idle, spawning, fighting, breather, complete — and a wave table, but a
// director that spawns wave 1 and then sits in `fighting` forever is a game
// with no loop, and it would look completely healthy in every screenshot this
// project has taken. That is precisely how the loot pickup crash survived for
// weeks.
//
// Method: start the mission, then repeatedly kill everything that spawns and
// watch the phase and wave index. Killing is done through the damage system,
// the same path a real player's shots take, so the death bookkeeping the
// director depends on actually runs. The loop is bounded in SIMULATED time so
// a stuck director reports as stuck instead of hanging the probe.
(() => {
  const { game, debug } = window.__ACNTR__;
  const enemies = game.enemies;
  const dir = enemies?.encounter;
  if (!dir) return { error: 'no EncounterDirector on EnemyManager' };

  debug.setHudVisible(false);
  debug.resetState();
  debug.placePlayerInOpenGround({ ahead: 70 });
  debug.step(0.3);

  const out = {
    waveCount: Array.isArray(dir.waves) ? dir.waves.length : null,
    phaseAtStart: dir.phase,
    waveIndexAtStart: dir.waveIndex,
    autoStart: dir.autoStart,
    startDelay: dir.startDelay,
  };

  // Make sure the director knows who the player is; several of its checks are
  // relative to the player and it is set externally.
  try { dir.setPlayer?.(game.player?.entity || game.player); } catch { /* optional */ }

  const timeline = [];
  let simT = 0;
  let lastKey = '';
  const SLICE = 0.25;
  const LIMIT = 240; // simulated seconds
  let kills = 0;
  let stepError = null;

  while (simT < LIMIT) {
    try { debug.step(SLICE); } catch (e) {
      stepError = String(e && e.stack ? e.stack : e).slice(0, 400);
      break;
    }
    simT += SLICE;

    // Kill everything alive, the way a player would.
    for (const e of (enemies.list || []).slice()) {
      if (!e || e.alive === false || !e.stats) continue;
      const hp = e.stats.apMax ?? e.stats.ap ?? 100000;
      try {
        game.damage?.applyDamage?.(e, { amount: hp * 4, type: 'kinetic', source: game.player?.entity });
        if (e.alive !== false) { e.stats.ap = 0; e.onDeath?.(); }
        kills++;
      } catch { /* counted by the absence of progress */ }
    }

    const key = `${dir.phase}#${dir.waveIndex}`;
    if (key !== lastKey) {
      timeline.push({ t: +simT.toFixed(1), phase: dir.phase, wave: dir.waveIndex, kills });
      lastKey = key;
    }
    if (dir.phase === 'complete') break;
  }

  out.stepError = stepError;
  out.simulatedSeconds = +simT.toFixed(1);
  out.totalKills = kills;
  out.phaseAtEnd = dir.phase;
  out.waveIndexAtEnd = dir.waveIndex;
  out.timeline = timeline;
  // The single question: did the wave index ever move, and did the mission
  // reach its end state?
  out.wavesAdvanced = dir.waveIndex > out.waveIndexAtStart;
  out.reachedComplete = dir.phase === 'complete';
  if (!out.wavesAdvanced) {
    out.verdict = `STUCK: still on wave ${dir.waveIndex} in phase "${dir.phase}" after `
      + `${out.simulatedSeconds}s and ${kills} kills`;
  } else if (!out.reachedComplete) {
    out.verdict = `PROGRESSES but did not finish: reached wave ${dir.waveIndex} of `
      + `${out.waveCount} in ${out.simulatedSeconds}s`;
  } else {
    out.verdict = `COMPLETE: ${out.waveCount} waves in ${out.simulatedSeconds}s, ${kills} kills`;
  }
  return out;
})();
