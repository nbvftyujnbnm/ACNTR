// Does every key the game binds actually DO something?
//
// This sweep only became possible once `debug.tapKeys` existed. Every
// discrete action here is written against `input.hit()`, which reads
// `input.pressed`; `debug.holdKeys` only ever touched `input.keys`, which is
// what `input.down()` reads. So no pose or probe could exercise a one-shot
// binding at all, and the whole class went unverified — which is how
// `toggleMute` came to have no caller anywhere in the codebase without
// anyone noticing.
//
// The garage key is the one that matters most. This is a LOOTER shooter: if
// G does not open the assembly screen, every part the player collects is
// unreachable, and no amount of visual polish makes up for it. It is bound in
// HUD.update — which runs in lateUpdate — rather than anywhere obvious, and
// its own comment says "Game may also map G", which Game does not. That is
// exactly the shape of a binding that quietly stops working.
//
// Each case tags the state it must work in, because several of these are
// state-gated and the update path returns early (clearing `pressed`) in some
// states but not others.
(() => {
  const { game, debug } = window.__ACNTR__;
  const results = [];
  const note = (key, where, expected, ok, detail) =>
    results.push({ key, where, expected, ok, ...(detail ? { detail } : {}) });

  const toPlaying = () => {
    if (game.state === 'garage') { game.closeGarage?.(); debug.step(0.2); }
    return game.state;
  };

  // ---- G opens the garage -------------------------------------------------
  toPlaying();
  const stateBeforeG = game.state;
  debug.tapKeys(['KeyG']);
  debug.step(0.2);
  note('KeyG', 'playing', 'opens the garage', game.state === 'garage',
       `state ${stateBeforeG} -> ${game.state}`);

  // ---- Escape / G close it again -----------------------------------------
  if (game.state === 'garage') {
    debug.tapKeys(['Escape']);
    debug.step(0.25);
    note('Escape', 'garage', 'closes the garage', game.state === 'playing',
         `state -> ${game.state}`);
  } else {
    note('Escape', 'garage', 'closes the garage', false, 'never got into the garage to try');
  }

  // ---- garage navigation --------------------------------------------------
  // These move a selection index rather than changing state, so read whatever
  // cursor the garage keeps and check it MOVES.
  toPlaying();
  debug.tapKeys(['KeyG']);
  debug.step(0.25);
  const g = game.garage;
  const cursor = () => {
    // `selIndex` is the real field. An earlier version of this list omitted
    // it and reported the arrow keys as unjudgeable for a cursor that was
    // moving perfectly well — the same failure mode as the garage probe that
    // guessed `.part`/`.item` selectors and reported "0 rows" for a screen
    // rendering all ten. Guessing a field name is a hypothesis, not a reading.
    for (const k of ['selIndex', 'sel', 'selected', '_sel', 'index', '_index', 'cursor', '_cursor', 'slotIndex']) {
      if (typeof g?.[k] === 'number') return { field: k, v: g[k] };
    }
    return { field: null, v: null };
  };
  const c0 = cursor();
  if (c0.field) {
    debug.tapKeys(['ArrowDown']); debug.step(0.1);
    const c1 = cursor();
    note('ArrowDown', 'garage', `moves ${c0.field}`, c1.v !== c0.v, `${c0.v} -> ${c1.v}`);
    debug.tapKeys(['ArrowUp']); debug.step(0.1);
    const c2 = cursor();
    note('ArrowUp', 'garage', `moves ${c0.field} back`, c2.v !== c1.v, `${c1.v} -> ${c2.v}`);
  } else {
    note('ArrowDown/Up', 'garage', 'moves a selection', null,
         'no numeric cursor field found on Garage — cannot judge');
  }

  // Tab switches the filter, F does something, Enter equips. Check each moves
  // SOME observable state rather than asserting a specific field, since the
  // point is to catch a binding that is inert, not to pin the implementation.
  const snapshot = () => {
    const panel = document.getElementById('ui-root')?.querySelector('[class*="garage"]');
    // CONTENT, not length. KeyF cycles the sort label through 'SORT: TIER',
    // 'SORT: NAME', 'SORT: RARITY' — and the first two are the same LENGTH, so
    // a length-based snapshot reported the key as inert when it was working.
    // Hash the actual text instead.
    if (!panel) return 'no-panel';
    const t = (panel.textContent || '') + '\u0000' + panel.innerHTML.length;
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
    return 'h' + h.toString(36);
  };
  // Enter FIRST, and asserted on the LOADOUT rather than on the panel.
  // Ordering matters: run it after Tab and KeyF and the filter has moved to a
  // category holding none of the starter parts, so `_rows` is empty and the
  // test measures its own setup rather than the binding. Asserting on the
  // panel had the same problem from the other end — the selection can land on
  // a part that is already equipped — in which case a correct equip changes nothing on screen and
  // the test is measuring its own setup. Read the slot instead, and skip
  // honestly when there is nothing to prove.
  {
    const rows = g?._rows || [];
    const part = rows[g?.selIndex]?.part;
    const slot = part?.slot;
    const before = slot ? (game.loadout?.slots?.[slot]?.name ?? null) : null;
    if (!part) {
      note('Enter', 'garage', 'equips the selection', null,
           `no selectable row (rows ${rows.length}, selIndex ${g?.selIndex})`);
    } else if (before === part.name) {
      note('Enter', 'garage', 'equips the selection', null,
           `selection "${part.name}" is already equipped in ${slot} — nothing to prove`);
    } else {
      debug.tapKeys(['Enter']);
      debug.step(0.2);
      const after = slot ? (game.loadout?.slots?.[slot]?.name ?? null) : null;
      note('Enter', 'garage', 'equips the selection', after === part.name,
           `${slot}: ${before} -> ${after}`);
    }
  }

  for (const [key, what] of [['Tab', 'switches the filter'], ['KeyF', 'cycles the sort']]) {
    const before = snapshot();
    debug.tapKeys([key]);
    debug.step(0.2);
    const after = snapshot();
    note(key, 'garage', what, before !== after, `panel ${before} -> ${after}`);
  }

  // ---- audio keys, in both states ----------------------------------------
  const a = game.audio;
  for (const where of ['garage', 'playing']) {
    if (where === 'playing') toPlaying(); else if (game.state !== 'garage') { debug.tapKeys(['KeyG']); debug.step(0.2); }
    const m0 = a.isMuted();
    debug.tapKeys(['KeyM']);
    note('KeyM', where, 'toggles mute', a.isMuted() !== m0, `${m0} -> ${a.isMuted()}`);
    a.setMuted(false);
    const v0 = a.getVolume('master');
    debug.tapKeys(['Minus']);
    note('Minus', where, 'lowers master volume', a.getVolume('master') < v0,
         `${v0.toFixed(2)} -> ${a.getVolume('master').toFixed(2)}`);
    debug.tapKeys(['Equal']);
    note('Equal', where, 'raises master volume', a.getVolume('master') > v0 - 0.001,
         `-> ${a.getVolume('master').toFixed(2)}`);
  }

  toPlaying();
  return {
    failing: results.filter((r) => r.ok === false),
    unjudgeable: results.filter((r) => r.ok === null),
    passing: results.filter((r) => r.ok === true).map((r) => `${r.key} (${r.where})`),
  };
})();
