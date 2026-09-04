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

await page.goto('http://localhost:5181/?vision=0&drama=0');
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

// Wait for the start lights. The car is held on the line until the green, so a
// check that stamps on the throttle immediately is checking the countdown.
await page.waitForSelector('.lights-word.go', { timeout: 20_000 });
console.log('start lights count down and go green');

// Drive it, and check the run banks nothing.
await page.keyboard.down('w');
await page.waitForTimeout(5000);
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

// The grid, with everyone's paint, number and tally on it. Only reachable with
// two browsers and a handshake in real use, which is exactly why it is worth
// checking here — a panel nobody ever looks at quietly stops working.
await page.goto('http://localhost:5181/?vision=0&drama=0&screen=lobby');
await page.waitForSelector('.lobby.is-open .lobby-players li:nth-child(4)', { timeout: 20_000 });
const grid = await page.$$eval('.lobby-players li', (rows) =>
  rows.map((row) => ({
    text: row.textContent ?? '',
    paint: (row.querySelector('.lobby-swatch') as HTMLElement | null)?.style.background ?? '',
  })),
);
if (grid.length !== 4) throw new Error(`the grid shows ${grid.length} players, not 4`);
if (new Set(grid.map((row) => row.paint)).size !== 4) {
  throw new Error('two cars are wearing the same paint — nobody could tell them apart');
}
if (!grid.some((row) => row.text.includes('win'))) throw new Error('the win tally is missing');
if (!(await page.$('[data-act="livery"]'))) throw new Error('no way to pick a paint');
if (!(await page.$('[data-act="number"]'))) throw new Error('no way to pick a number');
console.log(`lobby grid: ${grid.map((row) => row.text.trim().replace(/\s+/g, ' ')).join(' | ')}`);

// The room code, with a broker configured.
//
// `?rooms=` points at one that does not exist, on purpose: the panel has to
// paint a code the moment the lobby opens, before anybody has joined and
// whether or not the service is reachable. A host reading a code out loud
// should not be waiting on a network call, and this is the check that the code
// is on screen at all — it is the entire feature, and it is behind a config
// flag that is off by default, so nothing else would ever notice it break.
await page.goto(
  'http://localhost:5181/?vision=0&drama=0&screen=lobby&rooms=http://127.0.0.1:9/none',
);
await page.waitForSelector('.lobby.is-open .lobby-code', { timeout: 20_000 });
const roomCode = ((await page.textContent('.lobby-code')) ?? '').trim();
if (!/^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/.test(roomCode)) {
  throw new Error(`the room code reads "${roomCode}", which is not a room code`);
}
if (!(await page.$('[data-act="send-room"]'))) throw new Error('no way to send the room link');
// The invite-code path has to survive alongside it: it is the fallback for
// when there is no broker, and deleting it by accident would go unnoticed
// until the day the service went down.
if (!(await page.$('[data-act="invite"]'))) throw new Error('the invite-code fallback is gone');
console.log(`room code: ${roomCode}`);

// A room code typed into the *invite* box.
//
// This is not a hypothetical. It is what happens to anyone whose browser is
// still serving a cached build with no room field, to anyone who opens the
// fallback out of habit, and to anyone handed six characters who types them
// into whichever box is in front of them. It used to answer "that invite code
// was not readable: invalid characters" — true, useless, and silent about the
// field six lines above it.
// `screen=lobby` opens the host's side; the join screen is reached the way a
// player reaches it.
await page.goto('http://localhost:5181/?vision=0&drama=0&rooms=http://127.0.0.1:9/none');
await page.waitForSelector('[data-action="multiplayer"]', { timeout: 20_000 });
await page.click('[data-action="multiplayer"]');
await page.waitForSelector('.lobby.is-open [data-act="join"]', { timeout: 10_000 });
await page.click('[data-act="join"]');
await page.waitForSelector('[data-act="room-in"]', { timeout: 10_000 });
await page.$$eval('details', (els) => els.forEach((d) => ((d as HTMLDetailsElement).open = true)));
await page.fill('[data-act="invite-in"]', 'RMX-2XU');
await page.click('[data-act="use-invite"]');
await page.waitForTimeout(600);
const routed = ((await page.textContent('.lobby-status')) ?? '').trim();
if (/not readable|invalid/i.test(routed)) {
  throw new Error(`a room code in the invite box was rejected: "${routed}"`);
}
if (!/room/i.test(routed)) {
  throw new Error(`a room code in the invite box went somewhere unexpected: "${routed}"`);
}
console.log(`room code in the invite box: ${routed}`);

// And with no broker the lobby is exactly what it always was.
//
// An empty `?rooms=` is how that is reached now that one is configured by
// default: it outranks the built-in address, which is the same precedence the
// parameter has when it points somewhere. This is the fallback the whole
// feature sits on — a LAN with no internet, or the day the service stops being
// paid for — so it is worth a check of its own rather than an assumption.
await page.goto('http://localhost:5181/?vision=0&drama=0&screen=lobby&rooms=');
await page.waitForSelector('.lobby.is-open [data-act="invite"]', { timeout: 20_000 });
if (await page.$('.lobby-code')) throw new Error('a room code was shown with no room service');
console.log('no broker configured: the lobby falls back to invite codes');

// The update bar, which must be silent unless there is something to say.
//
// A false alarm is the worst thing this feature can do: the only action it
// offers is a reload, and a reload that changes nothing teaches people to
// ignore the bar. Two ways it has gone wrong already, both caught here — the
// signature compared tags the dev server injects and so never matched, and the
// bar's own `display: flex` outranked the browser's `[hidden] { display: none }`
// so it was on screen permanently whatever the check decided.
if (!(await page.$('.update-bar'))) throw new Error('the update bar is not in the page at all');
if (await page.isVisible('.update-bar')) {
  throw new Error('the update bar is showing with no newer build to report');
}
// And it can still be shown, so the check above is not passing for the wrong
// reason — a bar that can never appear would satisfy it just as well.
await page.$eval('.update-bar', (el) => ((el as HTMLElement).hidden = false));
if (!(await page.isVisible('.update-bar'))) {
  throw new Error('the update bar cannot be shown even when asked');
}
await page.$eval('.update-bar', (el) => ((el as HTMLElement).hidden = true));
console.log('update bar: silent, and able to speak');

console.log('OK — career, arcade and multiplayer all open from the front door.');
await browser.close();
await server.close();
