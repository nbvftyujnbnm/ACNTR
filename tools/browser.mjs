import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * The container ships a pre-installed Chromium (build 1194) that does not match
 * the @playwright/test version's expected build, and we are not allowed to run
 * `playwright install`. So always launch against the pinned executable.
 */
export const CHROME =
  process.env.PW_CHROMIUM ||
  ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) =>
    existsSync(p)
  );

/**
 * SwiftShader is a software rasteriser — it is correct but slow, so captures use
 * generous timeouts and the in-page fps number is NOT representative of real
 * hardware. Judge performance from draw calls and triangle counts instead.
 */
export const GL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-features=DialMediaRouteProvider,Translate',
  '--js-flags=--max-old-space-size=4096',
];

export async function launch(extraArgs = []) {
  if (!CHROME) throw new Error('No Chromium found — set PW_CHROMIUM');
  return chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [...GL_ARGS, ...extraArgs],
  });
}
