// Does the audio system actually make sound, and can a player ever silence it?
//
// 4000 lines across AudioDirector, Sfx, Synth and Music, and nothing has ever
// checked either question. That is the same blind spot that hid a dead loot
// loop: `LootSystem` read `p.body` in three places and never created it, so
// picking up any drop crashed the frame loop, and it survived weeks of review
// because every review looked at pictures. Audio is worse off — a screenshot
// cannot even in principle show it.
//
// Two separate questions, and they need different answers:
//
//  1. Does the graph run? Headless Chromium has no output device, but WebAudio
//     still builds and runs the graph, so node creation and gain values are
//     all observable. What is NOT observable is whether it is audible, so this
//     reports the context state honestly rather than claiming more than it can
//     see. An AudioContext that is `suspended` produces silence no matter how
//     correct everything downstream is.
//
//  2. Can a player turn it off? `setVolume` has no caller anywhere in src/,
//     and `setMuted` is called only by `toggleMute`, which itself has no
//     caller. `_saveSettings` exists, so persistence was written for a
//     settings screen that was never built.
(() => {
  const { game, debug } = window.__ACNTR__;
  const ad = game.audio || game.audioDirector;
  const out = { haveDirector: !!ad };
  if (!ad) return out;

  const ctx = ad.ctx || ad.context || ad._ctx || null;
  out.contextState = ctx ? ctx.state : 'NO CONTEXT';
  out.sampleRate = ctx ? ctx.sampleRate : null;
  out.ready = ad.ready ?? null;
  out.muted = ad.isMuted ? ad.isMuted() : (ad.muted ?? null);
  out.volumes = ad.volumes ? { ...ad.volumes } : null;

  // Is anything connected downstream of the master bus? A graph that builds
  // its buses but never attaches them to the destination is silent in a way
  // no volume number reveals.
  const buses = {};
  for (const k of ['master', 'sfx', 'weapons', 'music', 'ui', 'ambience']) {
    const n = ad[`_${k}Gain`] || ad[`${k}Gain`] || ad.buses?.[k] || null;
    if (n) buses[k] = { gain: +(n.gain?.value ?? NaN).toFixed(4), connected: n.numberOfOutputs > 0 };
  }
  out.buses = buses;

  // Fire the events the game fires and see whether the director reacts. Count
  // live source nodes before and after: a director that swallows its events
  // is silent no matter how healthy the graph looks.
  const bus = window.__ACNTR__.bus;
  const countSources = () => {
    // Most engines pool voices; look for whatever list this one keeps.
    for (const k of ['_voices', 'voices', '_active', '_playing', '_nodes']) {
      const v = ad[k] || ad.sfx?.[k];
      if (Array.isArray(v)) return { field: k, n: v.length };
    }
    return { field: null, n: null };
  };
  out.voicesBefore = countSources();

  let handlerErrors = 0;
  const fire = (ev, payload) => {
    try { bus.emit(ev, payload); } catch { handlerErrors++; }
  };
  const p = game.player?.root?.position;
  fire('sfx', { id: 'loot_pickup', rarity: 'rare', position: p });
  fire('weapon:fire', { weapon: { id: 'rifle' }, position: p, entity: game.player?.entity });
  fire('impact', { position: p, surface: 'metal' });
  fire('explosion', { position: p, radius: 12 });
  out.handlerErrors = handlerErrors;

  try { debug.step(0.3); } catch (e) { out.stepError = String(e).slice(0, 200); }
  out.voicesAfter = countSources();

  // Can a player reach any of this? Grep-equivalent, answered from the live
  // object rather than from source: the methods exist, but nothing binds them.
  out.api = {
    hasSetVolume: typeof ad.setVolume === 'function',
    hasSetMuted: typeof ad.setMuted === 'function',
    hasToggleMute: typeof ad.toggleMute === 'function',
  };
  // Prove the mute path at least WORKS, so a missing binding can be
  // distinguished from a broken implementation.
  let muteWorks = null;
  try {
    const before = ad.isMuted();
    ad.toggleMute();
    const mid = ad.isMuted();
    ad.setMuted(before);
    muteWorks = mid !== before && ad.isMuted() === before;
  } catch (e) {
    muteWorks = 'ERR ' + String(e).slice(0, 120);
  }
  out.muteRoundTripWorks = muteWorks;
  return out;
})();
