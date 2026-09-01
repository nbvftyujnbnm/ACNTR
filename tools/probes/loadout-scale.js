// Are the PlayerController NOMINAL constants in the same units as the values
// Loadout actually derives? Speed plateaued at exactly 0.6505 of assaultMax,
// which is the clamp floor of statMul(), so at least one of them is not.
(() => {
  const g = window.__ACNTR__.debug.game;
  const d = g.loadout?.derived || {};
  const c = g.controller;
  const NOMINAL = { boostSpeed: 340, qbThrust: 400, enRecharge: 1650, enMax: 4000 };

  const pick = {};
  for (const k of ['boostSpeed', 'boostSpeedClean', 'qbThrust', 'enRecharge', 'enMax',
    'weight', 'loadLimit', 'enLoad', 'enOutput']) {
    if (k in d) pick[k] = +Number(d[k]).toFixed(2);
  }

  // What statMul does with each, and whether it lands on a clamp bound.
  const ratios = {};
  for (const [k, nom] of Object.entries(NOMINAL)) {
    const v = d[k];
    if (typeof v !== 'number' || !isFinite(v)) { ratios[k] = 'absent'; continue; }
    ratios[k] = { value: +v.toFixed(2), nominal: nom, raw: +(v / nom).toFixed(4) };
  }

  return {
    derivedKeys: Object.keys(d).sort(),
    derived: pick,
    ratios,
    mul: c ? { ...c._mul } : null,
    tune: c ? {
      walkSpeed: c.tune.walkSpeed, boostSpeed: c.tune.boostSpeed,
      assaultMax: c.tune.assaultMax, qbThrust: c.tune.qbThrust,
    } : null,
  };
})();
