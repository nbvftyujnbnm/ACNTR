/**
 * Minimal synchronous event bus shared by every subsystem.
 * Subsystems must not import each other directly for cross-cutting signals —
 * they emit here and listen here. Keeps module ownership clean.
 */
class EventBus {
  constructor() {
    this._map = new Map();
  }

  on(type, fn) {
    let set = this._map.get(type);
    if (!set) this._map.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    const set = this._map.get(type);
    if (set) set.delete(fn);
  }

  emit(type, payload) {
    const set = this._map.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] handler for "${type}" threw`, err);
      }
    }
  }

  clear() {
    this._map.clear();
  }
}

export const bus = new EventBus();
export default bus;

/**
 * Canonical event names. Keep this list authoritative so subsystems built in
 * isolation still line up.
 */
export const EV = {
  // lifecycle
  BOOT_PROGRESS: 'boot:progress',
  GAME_START: 'game:start',
  GAME_OVER: 'game:over',
  MISSION_COMPLETE: 'mission:complete',
  PAUSE: 'game:pause',
  RESUME: 'game:resume',

  // combat
  DAMAGE_DEALT: 'combat:damage',
  STAGGER: 'combat:stagger',
  IMPACT: 'combat:impact',
  ENTITY_KILLED: 'combat:killed',
  WEAPON_FIRED: 'combat:fired',
  PLAYER_HIT: 'combat:playerHit',
  LOCK_STATE: 'combat:lockState',

  // movement
  QUICK_BOOST: 'move:quickBoost',
  ASSAULT_BOOST: 'move:assaultBoost',
  LANDED: 'move:landed',
  EN_EMPTY: 'move:enEmpty',

  // loot / progression
  LOOT_DROP: 'loot:drop',
  LOOT_PICKUP: 'loot:pickup',
  PART_EQUIPPED: 'loot:equipped',
  BUILD_CHANGED: 'loot:buildChanged',

  // camera / feedback
  SHAKE: 'cam:shake',
  HITSTOP: 'cam:hitstop',

  // audio
  SFX: 'audio:sfx',
};
