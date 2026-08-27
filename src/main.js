import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { bus, EV } from './core/EventBus.js';
import { Game } from './game/Game.js';

const bootBar = document.getElementById('boot-bar');
const bootStatus = document.getElementById('boot-status');
const bootEl = document.getElementById('boot');

bus.on(EV.BOOT_PROGRESS, ({ t, label }) => {
  if (bootBar) bootBar.style.width = `${Math.round(t * 100)}%`;
  if (bootStatus && label) bootStatus.textContent = label;
});

async function main() {
  THREE.ColorManagement.enabled = true;

  const canvas = document.getElementById('viewport');
  const engine = new Engine(canvas);
  const input = new Input(canvas);

  window.__ACNTR__ = { engine, input, THREE, bus };

  const game = new Game(engine, input);
  await game.init();

  // Boot curtain out
  bus.emit(EV.BOOT_PROGRESS, { t: 1, label: 'ready' });
  await new Promise((r) => setTimeout(r, 120));
  bootEl?.classList.add('hidden');
  setTimeout(() => bootEl?.remove(), 900);

  engine.start();
  window.__ACNTR__.game = game;
  window.__ACNTR_READY__ = true;
}

main().catch((err) => {
  console.error(err);
  if (bootStatus) {
    bootStatus.textContent = 'BOOT FAILURE — see console';
    bootStatus.style.color = '#ff5b47';
  }
  window.__ACNTR_ERROR__ = String(err?.stack || err);
});
