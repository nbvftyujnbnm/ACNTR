// Can a PLAYER actually equip what drops?
//
// The loot chain is now verified as far as code can drive it: enemies die,
// drops spawn, walking over one collects it, it reaches `loadout.inventory`,
// and `loadout.equip()` moves the derived stats. But every one of those steps
// was driven by calling methods directly. The only route a real player has is
// the garage screen, and nothing has ever checked that it opens, lists what
// was picked up, or equips it.
//
// That gap matters here specifically: `LootSystem` read `p.body` in three
// places and never created it, so picking up any drop crashed the frame loop,
// and it survived weeks of review because every review looked at pictures.
// The garage is the same kind of blind spot — a whole screen nothing has
// driven.
//
// So: put a known part in the inventory, open the garage the way the game
// does, and report what the DOM actually contains and whether clicking
// through it changes the build.
(() => {
  const { debug, game } = window.__ACNTR__;
  const loadout = game.loadout;
  const garage = game.garage;

  const out = {
    haveGarage: !!garage,
    haveLoadout: !!loadout,
    gameStateBefore: game.state,
  };
  if (!garage || !loadout) return out;

  // A part the player definitely owns, in a slot that definitely exists, so a
  // "nothing listed" result cannot be blamed on an empty inventory.
  const before = loadout.inventory.length;
  let seeded = null;
  try {
    seeded = game.loot?.dropAt ? null : null;
    // Roll one directly rather than killing for it — this probe is about the
    // garage, and a 0.48 drop chance would make it flaky for no reason.
    const { rollPart } = window.__ACNTR__.PartsDB || {};
    if (rollPart) seeded = rollPart(3, Math.random, null, {});
  } catch { /* fall through to whatever is already owned */ }
  if (seeded && loadout.addToInventory) loadout.addToInventory(seeded);
  out.inventorySeeded = loadout.inventory.length - before;
  out.inventorySize = loadout.inventory.length;

  // Open it the way the game does, not by calling garage.open() directly —
  // Game.openGarage() also flips game.state, and the garage's own update()
  // only runs in the 'garage' state.
  let openError = null;
  try {
    if (game.openGarage) game.openGarage();
    else garage.open();
  } catch (e) {
    openError = String(e && e.stack ? e.stack : e).slice(0, 400);
  }
  out.openError = openError;
  out.gameStateAfterOpen = game.state;

  // Let it lay out and run a frame of its own update.
  try { debug.step(0.4); } catch (e) {
    out.updateError = String(e && e.stack ? e.stack : e).slice(0, 400);
  }

  // What is actually on screen? A garage that opens but renders an empty
  // panel is the same failure as one that throws, and only the DOM can tell
  // them apart.
  const root = document.getElementById('ui-root');
  const panel = root?.querySelector('.garage, #garage, [class*="garage"]') || null;
  out.panelFound = !!panel;
  if (panel) {
    const cs = getComputedStyle(panel);
    out.panelVisible = cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.01;
    out.panelRect = (() => { const r = panel.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })();
    out.panelTextLength = (panel.textContent || '').trim().length;
    // Rows the player could click. If the inventory has parts and this is 0,
    // the screen is not showing the loot the whole loop exists to deliver.
    // `.g-slot` is what this garage actually renders — one per equipment
    // slot, carrying `data-slot`. An earlier version of this probe guessed
    // `.part, .item, li, button`, matched nothing, and reported "0 clickable
    // rows" for a screen that was rendering all ten slots correctly. A
    // selector that matches nothing looks exactly like a UI that renders
    // nothing; check the DOM before believing the count.
    const rows = panel.querySelectorAll('.g-slot[data-slot]');
    out.clickableRows = rows.length;
    out.sampleRowText = [...rows].slice(0, 6)
      .map((r) => (r.textContent || '').trim().slice(0, 46)).filter(Boolean);
  }

  // Does the equip path the UI uses actually work?
  const equipTarget = loadout.inventory[loadout.inventory.length - 1] || null;
  out.equipTarget = equipTarget
    ? { name: equipTarget.name ?? '?', slot: equipTarget.slot ?? '?', rarity: equipTarget.rarity ?? '?' }
    : null;
  const snap = () => {
    const d = loadout.derived || loadout.stats || {};
    return Object.fromEntries(Object.entries(d)
      .filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, +v.toFixed(3)]));
  };
  const s0 = snap();
  let equipError = null;
  try {
    if (garage._equip) garage._equip(equipTarget);
  } catch (e) {
    equipError = String(e && e.stack ? e.stack : e).slice(0, 400);
  }
  out.garageEquipError = equipError;
  try { debug.step(0.2); } catch { /* reported above */ }
  const s1 = snap();
  out.statsChangedByGarageEquip = Object.keys(s0).filter((k) => s0[k] !== s1[k]);
  out.equippedSlotNow = (() => {
    const slot = equipTarget?.slot;
    const eq = loadout.equipped || loadout.slots || {};
    const cur = slot ? eq[slot] : null;
    return cur ? (cur.name ?? cur.id ?? '?') : null;
  })();

  let closeError = null;
  try { (game.closeGarage || garage.close).call(game.closeGarage ? game : garage); }
  catch (e) { closeError = String(e).slice(0, 200); }
  out.closeError = closeError;
  out.gameStateAfterClose = game.state;
  return out;
})();
