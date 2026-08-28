/**
 * The three doors, in a real browser.
 *
 *   npm run uicheck
 *
 * Everything the game can do is now reached through the start menu, so a menu
 * that fails to open is a game that cannot be played at all — and no unit test
 * would notice, because the menu is DOM and the flows it starts are the whole
 * application wired together. This drives it the way a player does: click the
 * buttons, check the game arrived where the button said it would.
 *
 * It also checks the one rule that makes arcade arcade: that a race there
 * charges nothing and banks nothing.
 */

import { existsSync, readdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

/** The same preinstalled-Chromium lookup the other browser tools use. */
function findChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const exe = `${root}/${d}/chrome-linux/chrome`;
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const server = await createServer({ server: { port: 5181 }, logLevel: 'error' });
await server.listen();
const executablePath = findChromium();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const status = async () => (await page.evaluate(() => window.RSC!.status())) as Record<string, unknown>;

await page.goto('http://localhost:5181/?vision=0');
await page.waitForFunction(() => window.RSC?.ready === true);
await page.waitForSelector('.menu.is-open');
console.log('menu opens on boot');

// Career -> garage
await page.click('[data-action="career"]');
await page.waitForSelector('.garage.is-open');
console.log('career opens the garage');

// Garage -> menu -> arcade -> drive
await page.click('[data-action="menu"]');
await page.waitForSelector('.menu.is-open');
await page.click('[data-action="arcade"]');
await page.waitForSelector('.menu-row');
const rows = await page.locator('.menu-row').count();
await page.locator('.menu-row[data-id="quarry-run:night"]').click();
await page.waitForFunction(() => (window.RSC!.status() as { stage: string }).stage === 'quarry-run');
console.log(`arcade lists ${rows} races and drives one`);

// Drive it, and check the run banks nothing.
await page.keyboard.down('w');
await page.waitForTimeout(4000);
await page.keyboard.up('w');
const driving = await status();
console.log('arcade run:', JSON.stringify({ stage: driving.stage, phase: driving.phase, money: driving.money, time: driving.time, recorded: driving.recorded }));
if (driving.phase !== 'running') throw new Error('the arcade race never started');
if (driving.money !== 1500) throw new Error('arcade charged an entry fee');

// Photo mode: pause the world, pose the car from the recording, hide the HUD.
await page.keyboard.press('p');
await page.waitForSelector('.replay-keys');
const paused = await status();
await page.waitForTimeout(600);
const later = await status();
if (paused.worldTime !== later.worldTime) throw new Error('the world kept running in photo mode');
if (await page.locator('#hud.in-replay').count() === 0) throw new Error('the HUD stayed up');
// The camera turns in eighths, and the chrome can be hidden for the shot.
await page.keyboard.press('BracketRight');
await page.keyboard.press('h');
if (await page.locator('#hud.no-chrome').count() === 0) throw new Error('H did not hide the bar');
await page.keyboard.press('h');
await page.keyboard.press('p');
await page.waitForSelector('.replay-keys', { state: 'detached' });
console.log('photo mode pauses the world, hides the HUD, and gives it all back');

// Escape from an arcade race goes back to the front door.
await page.keyboard.press('Escape');
await page.waitForSelector('.menu.is-open');
console.log('escape from arcade returns to the menu');

// And multiplayer opens the lobby.
await page.click('[data-action="multiplayer"]');
await page.waitForSelector('.lobby.is-open');
console.log('multiplayer opens the lobby');

console.log('OK — career, arcade and multiplayer all open from the front door.');
await browser.close();
await server.close();
