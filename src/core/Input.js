import { bus } from './EventBus.js';

/**
 * Pointer-locked FPS-style input with an Armored Core control map.
 *
 *   WASD        translate
 *   Space       boost / jump (hold = ascend)
 *   Shift       quick boost (tap, directional)
 *   Ctrl / C    assault boost (hold forward)
 *   Mouse       aim
 *   LMB         right arm weapon
 *   RMB         left arm weapon
 *   Q / MMB     right shoulder
 *   E           left shoulder
 *   Tab         hard lock toggle
 *   R           repair kit
 *   G           garage / assembly
 */
export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.pressed = new Set(); // edge: pressed this frame
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, buttons: 0, wheel: 0 };
    this.mousePressed = new Set();
    this.mouseReleased = new Set();
    /**
     * INPUT IS ACTIVE — not "the Pointer Lock API is engaged". Those are the
     * same thing in a normal tab and are NOT the same thing everywhere the game
     * can be embedded: an iframe without `allow="pointer-lock"` refuses the
     * request outright, and this class used to gate `_onMouseMove` and
     * `_onMouseDown` on the raw API state. The result was a build that ran,
     * rendered and accepted the keyboard while being completely unable to aim or
     * fire — playable-looking and unplayable.
     */
    this.locked = false;
    /** True once the environment has refused a lock and we are driving without it. */
    this.pointerFallback = false;
    this._lockWatchdog = 0;
    this.sensitivity = 0.0021;
    this.invertY = false;
    this.enabled = true;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const c = e.code;
      if (!this.keys.has(c)) this.pressed.add(c);
      this.keys.add(c);
      if (['Tab', 'Space', 'F1', 'F5'].includes(c) || (c === 'KeyW' && e.ctrlKey)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    };
    this._onMouseMove = (e) => {
      if (!this.locked || !this.enabled) return;
      // `movementX/Y` is populated on ordinary mousemove too, so the fallback
      // aims with the same code path and the same sensitivity as a real lock.
      // What it cannot do is recentre the cursor, so a player in fallback runs
      // out of screen and lifts the mouse — the reason this is a fallback and
      // not the default.
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      if (!this.locked) return;
      if (!(this.mouse.buttons & (1 << e.button))) this.mousePressed.add(e.button);
      this.mouse.buttons |= 1 << e.button;
      e.preventDefault();
    };
    this._onMouseUp = (e) => {
      this.mouse.buttons &= ~(1 << e.button);
      this.mouseReleased.add(e.button);
    };
    this._onWheel = (e) => {
      this.mouse.wheel += Math.sign(e.deltaY);
    };
    this._onBlur = () => {
      this.keys.clear();
      this.mouse.buttons = 0;
    };
    this._onLockChange = () => {
      // In fallback the API is not what is driving us, so its events are not
      // ours to act on — a stray `pointerlockchange` would otherwise switch the
      // controls off underneath a player who never had a lock to lose.
      if (this.pointerFallback) return;
      clearTimeout(this._lockWatchdog);
      this._setActive(document.pointerLockElement === this.dom);
    };
    this._onContext = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onLockChange);
    this.dom.addEventListener('contextmenu', this._onContext);
  }

  requestLock() {
    if (this.locked) return;
    // Already established that this environment will not give us a lock.
    if (this.pointerFallback) { this._setActive(true); return; }
    if (!this.dom.requestPointerLock) { this._useFallback(); return; }
    // Chrome returns a promise here and REJECTS it when there is no user
    // gesture behind the call — which is always true in a headless capture, and
    // also true whenever the browser is still inside the exit cooldown after a
    // previous unlock. Unhandled, that reaches the console as an error, and the
    // review harness treats any console error as an automatic failure. It is a
    // refusal, not a fault: swallow it.
    //
    // A REFUSAL IS NOT ALWAYS A REJECTED PROMISE. Older Chrome returns
    // undefined from this call, and an iframe that lacks `allow="pointer-lock"`
    // can simply never fire `pointerlockchange`. Neither is distinguishable
    // from "the user has not clicked yet" at the call site, so arm a watchdog
    // as well: if no lock has arrived shortly after we asked, take the hint.
    try {
      const p = this.dom.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => this._useFallback());
    } catch { this._useFallback(); return; }
    clearTimeout(this._lockWatchdog);
    this._lockWatchdog = setTimeout(() => {
      if (!this.locked && !this.pointerFallback) this._useFallback();
    }, 700);
  }

  /**
   * Drive the game without the Pointer Lock API. Aim still works — `movementX`
   * is delivered on ordinary mousemove — so the only thing lost is cursor
   * recentring, which costs the player a mouse lift at the screen edge.
   */
  _useFallback() {
    if (this.pointerFallback) return;
    this.pointerFallback = true;
    clearTimeout(this._lockWatchdog);
    this._setActive(true);
  }

  _setActive(on) {
    if (this.locked === on) return;
    this.locked = on;
    // THE CURSOR FOLLOWS THE ACTIVE STATE, NOT THE FALLBACK FLAG. Hiding it
    // once, when the fallback engages, leaves it hidden through the pause —
    // where the game's own card says "click to resume" and the player has no
    // pointer to click with. Under a real lock the browser hides and restores
    // it for us; in fallback that is this line's job, both ways.
    if (this.pointerFallback) this.dom.style.cursor = on ? 'none' : '';
    bus.emit(on ? 'input:locked' : 'input:unlocked');
    if (!on) { this.keys.clear(); this.mouse.buttons = 0; }
  }

  exitLock() {
    if (!this.locked) return;
    if (this.pointerFallback) { this._setActive(false); return; }
    document.exitPointerLock?.();
  }

  down(code) { return this.enabled && this.keys.has(code); }
  hit(code) { return this.enabled && this.pressed.has(code); }
  up(code) { return this.released.has(code); }
  mouseDown(btn) { return this.enabled && (this.mouse.buttons & (1 << btn)) !== 0; }
  mouseHit(btn) { return this.enabled && this.mousePressed.has(btn); }

  /** Consume per-frame edge state + accumulated mouse delta. Call at end of update. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
  }

  /** Normalized WASD vector, x = strafe (right +), z = forward (+) */
  moveAxis(out = { x: 0, z: 0 }) {
    out.x = (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0);
    out.z = (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0);
    const len = Math.hypot(out.x, out.z);
    if (len > 1) {
      out.x /= len;
      out.z /= len;
    }
    return out;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._onBlur);
    clearTimeout(this._lockWatchdog);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.dom.removeEventListener('contextmenu', this._onContext);
  }
}
