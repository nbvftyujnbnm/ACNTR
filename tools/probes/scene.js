// Compact hard facts about the live scene. Kept terse on purpose — long JSON
// gets truncated by the runner, and a truncated diagnostic is worse than none.
(() => {
  const { game, THREE } = window.__ACNTR__;
  const r3 = (n) => (typeof n === 'number' ? +n.toFixed(3) : n);
  const v3 = (v) => (v ? `${r3(v.x)},${r3(v.y)},${r3(v.z)}` : null);

  const box = new THREE.Box3().setFromObject(game.player.root);
  const size = box.getSize(new THREE.Vector3());

  let dir = 0, point = 0, hemi = 0, shadowed = 0, spot = 0;
  game.scene.traverse((o) => {
    if (!o.isLight) return;
    if (o.isDirectionalLight) dir++;
    else if (o.isPointLight) point++;
    else if (o.isHemisphereLight) hemi++;
    else if (o.isSpotLight) spot++;
    if (o.castShadow) shadowed++;
  });

  const mats = new Set();
  game.player.root.traverse((o) => {
    if (o.isMesh && o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
  });
  const matSummary = [...mats].map((m) => {
    const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].filter((k) => m[k]);
    return `${(m.name || m.type).slice(0, 22)} m=${r3(m.metalness)} r=${r3(m.roughness)} env=${r3(m.envMapIntensity)} emI=${r3(m.emissiveIntensity)} [${maps.join('|') || 'NO MAPS'}]`;
  });

  const fog = game.scene.fog;
  const rend = game.engine.renderer;

  return {
    mechSize: v3(size),
    mechFeetY: r3(box.min.y),
    rootY: r3(game.player.root.position.y),
    groundUnderPlayer: r3(game.physics?.groundHeight?.(0, 0)),
    collider: game.player.collider
      ? `r=${r3(game.player.collider.radius)} h=${r3(game.player.collider.height)} c=${v3(game.player.collider.center)}`
      : null,
    lights: `dir=${dir} point=${point} hemi=${hemi} spot=${spot} shadowCasters=${shadowed}`,
    sunDir: v3(game.sky?.sunDirection),
    sunColor: game.sky?.sunColor?.getHexString?.(),
    fog: fog ? `${fog.type} col=${fog.color?.getHexString()} density=${fog.density?.toFixed(6)} near=${fog.near} far=${fog.far}` : 'NONE',
    env: game.scene.environment ? 'PMREM ok' : 'MISSING',
    background: game.scene.background?.isTexture ? 'texture' : (game.scene.background?.getHexString?.() ?? 'none'),
    toneMapping: rend.toneMapping,
    exposure: r3(rend.toneMappingExposure),
    pipelineKeys: game.pipeline?.params ? Object.keys(game.pipeline.params).join(',') : 'none',
    bloom: JSON.stringify(game.pipeline?.params?.bloom ?? null),
    grade: JSON.stringify(game.pipeline?.params?.grade ?? null).slice(0, 300),
    matCount: mats.size,
    mats: matSummary.slice(0, 10),
    stats: game.debug.stats(),
  };
})();
