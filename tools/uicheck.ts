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
import { guardBoard } from './boardGuard.js';

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

/**
 * A leaderboard with a known record in it, served by the page's own origin.
 *
 * The world record on the HUD is the one thing here that cannot be checked
 * against no broker at all, because with no broker there is correctly nothing
 * to show. A stub rather than the deployed worker: the assertion is that the
 * name and the time reach the screen, and pointing it at a live service would
 * make that a check on whether this machine has the internet.
 *
 * Loopback, which is also the only kind of `?rooms=` the game will follow.
 */
const WORLD_RECORD = { name: 'Solveig', time: 41.62, at: Date.now() };

const server = await createServer({
  server: { port: 5181 },
  logLevel: 'error',
  plugins: [
    {
      name: 'stub-board',
      configureServer(dev) {
        dev.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/b/') && !req.url?.startsWith('/bs')) return next();
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ top: [WORLD_RECORD], boards: {} }));
        });
      },
    },
  ],
});
await server.listen();
const executablePath = findChromium();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
// Never the live board: see boardGuard.ts for the time this posted to it.
const liveBoard = await guardBoard(page, WORLD_RECORD);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const status = async () => (await page.evaluate(() => window.RSC!.status())) as Record<string, unknown>;

await page.goto('http://localhost:5181/?vision=0&drama=0');
await page.waitForFunction(() => window.RSC?.ready === true);
await page.waitForSelector('.menu.is-open');
console.log('menu opens on boot');

/*
 * How to play, from the front screen.
 *
 * It is the only route into the help text, and on a phone it is the only route
 * into the key list at all — the permanent on-screen one was cut to three
 * bindings on the strength of this screen existing, so "the button opens it and
 * Back comes out" is load-bearing rather than cosmetic.
 */
await page.click('[data-action="help"]');
await page.waitForSelector('.help-doc');
const helpText = (await page.locator('.help-doc').textContent())?.replace(/\s+/g, ' ') ?? '';
for (const wanted of ['Career', 'Arcade', 'Multiplayer', 'Handbrake', 'TILT', 'checkpoint']) {
  if (!helpText.includes(wanted)) throw new Error(`the help screen never mentions ${wanted}`);
}
/*
 * It is long, so the end of it has to be reachable.
 *
 * Checked by scrolling to the bottom and looking for the last heading, not by
 * asking whether some element overflows: `.menu` is the scroller and
 * `.help-doc` is the content, so "does this element scroll" asks the wrong one
 * and answers no for a screen that is perfectly scrollable.
 */
await page.evaluate(`(() => {
  const menu = document.querySelector('.menu');
  menu.scrollTop = menu.scrollHeight;
})()`);
const lastVisible = await page.evaluate(`(() => {
  const heads = document.querySelectorAll('.help-doc h2');
  const last = heads[heads.length - 1];
  if (!last) return false;
  const r = last.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
})()`);
if (!lastVisible) throw new Error('the help screen cannot be scrolled to its last section');
await page.click('[data-action="back"]');
await page.waitForSelector('[data-action="career"]');
console.log(`help screen opens and closes (${helpText.trim().length} characters)`);

/*
 * A gamepad, in the menus and on the controller screen.
 *
 * Headless Chrome has no pads, so one is installed behind
 * `navigator.getGamepads` and its numbers are set by hand. Every press waits on
 * the page to show it happened rather than on a duration: the pad is polled
 * once a frame, and frames here come five or six a second.
 */
await page.evaluate(`(() => {
  const buttons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false }));
  window.__pad = { id: 'uicheck pad', index: 0, connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0, 0, 0], buttons, timestamp: 0 };
  navigator.getGamepads = () => [window.__pad];
})()`);
/*
 * A tap: pressed, and released by the page itself two frames later.
 *
 * Released from here, after waiting on the result, the button was held for
 * however long a round trip took — over a second on a loaded machine — which
 * is past the menu's auto-repeat, so one press moved two rows and the checks
 * below failed for reasons that were never the navigation's. Two frames is
 * long enough for the pad's own poll to see it and far short of a repeat.
 */
const padButton = async (index: number, until: string) => {
  await page.evaluate(`(() => {
    const b = window.__pad.buttons[${index}];
    b.value = 1; b.pressed = true;
    requestAnimationFrame(() => requestAnimationFrame(() => { b.value = 0; b.pressed = false; }));
  })()`);
  await page.waitForFunction(until);
  // Seen released before the next press can count as one.
  await page.waitForFunction(`window.__pad.buttons[${index}].value === 0`);
  await page.waitForTimeout(200);
};
const focusedAction = () =>
  page.evaluate(() => (document.querySelector('.pad-focus') as HTMLElement | null)?.dataset.action ?? '');

// The first press only lights a button: A on a panel with nothing chosen
// must not press whatever happens to be first, which here is Career.
await padButton(0, `!!document.querySelector('.menu .pad-focus')`);
if (!(await page.locator('.menu.is-open [data-action="career"]').count())) {
  throw new Error('the first A press on the menu acted instead of only lighting a button');
}
// Down through the three modes to How to play, then right to Controller,
// which sits beside it: spatial, so down means down and not "next in the DOM".
const moved = (from: string) =>
  `(document.querySelector('.pad-focus')?.dataset.action ?? '') !== ${JSON.stringify(from)}`;
// Down through the modes — each must be reached in turn — then steer to
// Controller from wherever the next press lands. Steered rather than counted:
// this page draws five frames a second, so a press can be held past the
// menu's auto-repeat before the harness lets go and move twice, and a test
// that counts presses is a test of the frame rate. Which tab is nearer below
// the last mode depends on the layout; either is correct.
for (const want of ['arcade', 'multiplayer']) {
  await padButton(13, moved(await focusedAction()));
  const at = await focusedAction();
  if (at !== want) throw new Error(`D-pad down went to "${at}", expected "${want}"`);
}
const BELOW_TABS = new Set(['look', 'switch', '']);
for (let i = 0; i < 8 && (await focusedAction()) !== 'pad'; i++) {
  const at = await focusedAction();
  const press = at === 'help' ? 15 : BELOW_TABS.has(at) ? 12 : 13;
  await padButton(press, moved(at));
}
if ((await focusedAction()) !== 'pad') throw new Error('D-pad could not reach Controller from the modes');
await padButton(0, `!!document.querySelector('.pad-list')`);

// Bind the throttle to an axis by moving it, the way a trigger that the
// browser reports as an axis would.
await page.click('[data-action="pad-bind"][data-id="throttle"]');
await page.waitForSelector('.pad-row.is-waiting');
await page.evaluate(`window.__pad.axes[5] = 1`);
await page.waitForFunction(`!document.querySelector('.pad-row.is-waiting')`);
await page.evaluate(`window.__pad.axes[5] = 0`);
const bound = (await page.locator('.pad-row').nth(1).textContent())?.replace(/\s+/g, ' ') ?? '';
if (!bound.includes('Axis 5') || !bound.includes('custom')) {
  throw new Error(`binding the throttle by moving axis 5 showed "${bound.trim()}"`);
}
await page.click('[data-action="pad-reset"]');
await page.waitForFunction(`!document.querySelector('.pad-binding em')`);

// B backs out through the screen's own Back button.
await padButton(1, `!!document.querySelector('.menu.is-open [data-action="career"]')`);
await page.evaluate(`(() => {
  navigator.getGamepads = () => [];
  document.querySelectorAll('.pad-focus').forEach((el) => el.classList.remove('pad-focus'));
})()`);
console.log('a gamepad moves through the menu, binds by moving a control, and backs out with B');

// The look picker: picked on the front screen, lit there, and still picked
// after a reload, because it is a saved setting and not a URL.
await page.click('[data-action="look"][data-id="cyberpunk"]');
await page.waitForSelector('.look-choice.is-on[data-id="cyberpunk"]');
// The save is an IndexedDB write, and a reload the instant after the click
// can beat it — so wait on the stored profile saying so, not on a duration.
await page.waitForFunction(`new Promise((done) => {
  const open = indexedDB.open('rsc');
  open.onerror = () => done(false);
  open.onsuccess = () => {
    const get = open.result.transaction('profile', 'readonly').objectStore('profile').get('profile');
    get.onsuccess = () => { done(get.result?.settings?.look === 'cyberpunk'); open.result.close(); };
    get.onerror = () => done(false);
  };
})`);
await page.reload();
await page.waitForFunction(() => window.RSC?.ready === true);
await page.waitForSelector('.look-choice.is-on[data-id="cyberpunk"]');
await page.click('[data-action="look"][data-id="standard"]');
await page.waitForSelector('.look-choice.is-on[data-id="standard"]');
console.log('the look picker lights its choice and keeps it across a reload');

// Career -> garage
await page.click('[data-action="career"]');
await page.waitForSelector('.garage.is-open');
console.log('career opens the garage');

// Garage -> menu -> arcade -> drive
await page.click('[data-action="menu"]');
await page.waitForSelector('.menu.is-open');
await page.click('[data-action="arcade"]');

// Arcade asks who is driving before it will start, because its times go on a
// global board and a board of anonymous numbers is a list rather than a
// leaderboard. Asked once and remembered.
await page.waitForSelector('.name-entry input');
if (await page.locator('.menu-row').count()) throw new Error('arcade started without a name');
// An empty name is refused visibly rather than silently doing nothing.
await page.click('[data-action="save-name"]');
await page.waitForSelector('.name-entry input.is-bad');
if (await page.locator('.menu-row').count()) throw new Error('an empty name was accepted');
console.log('arcade asks for a driver name, and refuses an empty one');

await page.fill('.name-entry input', 'Checkbot');
await page.click('[data-action="save-name"]');
await page.waitForSelector('.menu-row');
const rows = await page.locator('.menu-row').count();

// The top three for each track, or an honest word about why there are none.
//
// No broker is reachable under this check, which is the case that matters: the
// strip has to *settle*, not sit on "loading" forever. Everything about the
// board fails soft on purpose — a stage list that will not open because a
// leaderboard request is hanging is a far worse bug than one with no times in
// it — and this is the assertion that keeps that true.
await page.waitForFunction(
  () => !document.querySelector('.menu-board')?.textContent?.includes('loading'),
  { timeout: 15_000 },
);
const strip = (await page.locator('.menu-board').first().textContent())?.trim();
if (!strip) throw new Error('no leaderboard strip on the arcade rows');
console.log(`leaderboard strip settles with no broker: "${strip}"`);
// Rest on a stage and the co-driver introduces it. Recorded at `speak`,
// which headless Chrome has and nobody can hear.
await page.evaluate(`(() => {
  window.__intro = [];
  const speak = speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak = (line) => { window.__intro.push(line.text); speak(line); };
})()`);
// Off the list first: the pointer is wherever "Start racing" was, which can be
// over this very row, introduced before the recorder was listening.
await page.mouse.move(2, 2);
await page.locator('.menu-row[data-id="pine-loop:day-clear"]').hover();
await page.waitForFunction(`window.__intro.some((t) => t.includes('Pine Loop'))`, undefined, { timeout: 5000 });
console.log(`co-driver introduces a stage: "${((await page.evaluate('window.__intro')) as string[])[0]}"`);
await page.locator('.menu-row[data-id="quarry-run:night"]').click();
await page.waitForFunction(() => (window.RSC!.status() as { stage: string }).stage === 'quarry-run');
console.log(`arcade lists ${rows} races and drives one`);

/*
 * Wait for the start lights. The car is held on the line until the green, so a
 * check that stamps on the throttle immediately is checking the countdown.
 *
 * Latched from inside the page rather than waited on as a selector, because the
 * green is a *transient*: it is on screen for about 1.2 s, and this page renders
 * at five or six frames a second through software WebGL, so it exists for six
 * frames. `waitForSelector` resolves and then re-checks, competing for the same
 * main thread, and misses a window that small often enough to be useless —
 * measured at 6 frames before this was written and 7 after, which is to say it
 * was always a coin toss and never a regression in whatever ran last.
 * `waitForFunction` runs on every animation frame, so latching the observation
 * catches it whenever it happens.
 */
await page.waitForFunction(
  () => {
    const w = window as unknown as { __green?: boolean };
    if (document.querySelector('.lights-word.go')) w.__green = true;
    return w.__green === true;
  },
  { timeout: 20_000 },
);
console.log('start lights count down and go green');

// The co-driver speaks through speechSynthesis, which headless Chrome has but
// cannot be heard through — so what reaches `speak` is recorded instead.
await page.evaluate(`(() => {
  window.__calls = [];
  const speak = speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak = (line) => { window.__calls.push(line.text); speak(line); };
})()`);

// Drive it, and check the run banks nothing.
await page.keyboard.down('w');
await page.waitForTimeout(5000);
// And on until the first call, which is 78 m in. Five seconds of throttle is
// usually well past it; on a loaded machine drawing four frames a second it
// was 1.9 s of race, short of the corner, and the check blamed the co-driver.
await page.waitForFunction('window.__calls && window.__calls.length > 0', undefined, { timeout: 30_000 }).catch(() => {});
await page.keyboard.up('w');
const driving = await status();
console.log('arcade run:', JSON.stringify({ stage: driving.stage, phase: driving.phase, money: driving.money, time: driving.time, recorded: driving.recorded }));
// Held until the first call above, so an empty list here means silence.
const calls = (await page.evaluate(`window.__calls`)) as string[];
if (calls.length === 0) throw new Error('the co-driver said nothing in five seconds of a stage');
console.log(`co-driver called: ${calls.map((c) => `"${c}"`).join(', ')}`);
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

/*
 * Finish it, then line up again — and check the game remembers.
 *
 * After photo mode, not before: a restart empties the ghost recorder, and the
 * replay is posed from exactly those frames.
 *
 * Arcade kept a personal best and no lap, and read the *career* record to fill
 * the HUD's PB strip, which in arcade is always empty. So a player who set a
 * record was told "no time set" on the very next run and had nothing on the
 * road to chase. Both halves are checked here because both were broken and
 * either one alone still reads as "my time did not save".
 */
// From the start line, not from wherever five seconds of held throttle left
// the car: the AI plans against the road ahead and cannot recover a run that
// began halfway up an embankment.
await page.keyboard.press('r');
await page.waitForFunction(() => (window.RSC!.status() as { phase: string }).phase === 'staging', {
  timeout: 20_000,
});
// Every award that reaches the screen, latched inside the page: each one is up
// for a couple of seconds on a page drawing five frames a second.
await page.evaluate(`(() => {
  window.__awards = [];
  const tick = () => {
    for (const a of document.querySelectorAll('.award-title')) {
      const t = a.textContent.trim();
      if (!window.__awards.includes(t)) window.__awards.push(t);
    }
    requestAnimationFrame(tick);
  };
  tick();
})()`);
const finished = (await page.evaluate(() => window.RSC!.finishWithAi())) as {
  phase?: string;
  medal?: string;
  time?: string;
};
if (finished.phase !== 'finished') throw new Error(`the AI did not finish: ${finished.phase}`);
/*
 * And it was celebrated. Arcade marked a run only through the board, so a
 * medal was never announced and nothing here noticed: this check finished an
 * arcade race and pressed R straight past whatever was or was not on screen.
 */
const medalWord = finished.medal === 'author' ? 'AUTHOR TIME' : finished.medal === 'finish' ? 'FINISHED' : finished.medal?.toUpperCase();
await page
  .waitForFunction((word) => (window as unknown as { __awards: string[] }).__awards.includes(word!), medalWord, {
    timeout: 20_000,
  })
  .catch(async () => {
    throw new Error(
      `an arcade ${finished.medal} was not celebrated; awards seen: ${JSON.stringify(await page.evaluate('window.__awards'))}`,
    );
  });
console.log(`arcade celebrates its medal: ${JSON.stringify(await page.evaluate('window.__awards'))}`);
await page.keyboard.press('r');
await page.waitForFunction(() => (window.RSC!.status() as { phase: string }).phase === 'staging', {
  timeout: 20_000,
});
const remembered = (await status()) as { ghost?: boolean };
const pb = (await page.textContent('#race-best'))?.trim() ?? '';
if (pb === 'no time set') throw new Error('an arcade record was set and the next run forgot it');
if (!remembered.ghost) throw new Error('an arcade record was set and left no ghost to chase');
console.log(`arcade remembers the run: ${pb}, ghost on the road`);
// The finish tried to post, and the guard kept it off the live board.
if (liveBoard.writes === 0) throw new Error("an arcade finish posted nothing - is the board guard still catching it?");
console.log(`board guard caught ${liveBoard.writes} write(s) to the live board`);

/*
 * And the gold one beside it.
 *
 * Two ghosts on the road at once is the thing worth checking — your own best
 * in blue and the world record in gold are separate players, separate views
 * and separate fetches, and either one quietly not being drawn looks exactly
 * like the other one working. The real gold lap comes off the board, which a
 * check cannot arrange, so the harness plays the stored lap as the record: the
 * question is whether two can be on the road together, not whose lap it is.
 */
const both = (await page.evaluate(() => window.RSC!.showRecordGhost())) as {
  ghost?: boolean;
  wrGhost?: boolean;
};
if (!both.ghost || !both.wrGhost) throw new Error('only one ghost attached');
await page.waitForFunction(
  () => {
    const drawn = (window.RSC!.status() as { ghostsDrawn: boolean[] }).ghostsDrawn;
    return drawn[0] === true && drawn[1] === true;
  },
  undefined,
  { timeout: 20_000 },
);
console.log('personal best and world record ghosts are both on the road');

// The surface readout, which is the one place a simulation id reaches the
// screen as a word. A sealed road is asphalt; tarmac is an airport.
const surfaceWord = (await page.textContent('#hud-surface'))?.trim() ?? '';
if (surfaceWord === 'tarmac') throw new Error('the HUD is still calling the road tarmac');
console.log(`surface readout: "${surfaceWord}"`);

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

// Picking host or join is not final.
//
// It used to be: hosting opens a room the moment the button is pressed and
// joining lands on a screen with a code box and nothing else, and neither had a
// way back to the other. Close is not that way — closing the panel deliberately
// leaves the lobby up behind it — so the only exit from a wrong tap was a
// reload. Checked from both screens, because they are two different teardowns:
// a guest with nothing connected, and a host with a room open.
await page.goto('http://localhost:5181/?vision=0&drama=0&rooms=http://127.0.0.1:9/none');
await page.waitForSelector('[data-action="multiplayer"]', { timeout: 20_000 });
await page.click('[data-action="multiplayer"]');
for (const screen of ['join', 'host'] as const) {
  await page.waitForSelector(`.lobby.is-open [data-act="${screen}"]`, { timeout: 10_000 });
  await page.click(`[data-act="${screen}"]`);
  await page.waitForSelector('.lobby.is-open [data-act="back"]', { timeout: 10_000 });
  await page.click('[data-act="back"]');
  await page.waitForSelector('.lobby.is-open [data-act="host"]', { timeout: 10_000 });
  if (!(await page.$('[data-act="join"]'))) {
    throw new Error(`Back from ${screen} did not reach the choice of host or join`);
  }
  if (await page.$('[data-act="back"]')) {
    throw new Error('the choice screen has a Back button, which goes nowhere');
  }
}
console.log('the lobby can go back and pick again, from either screen');

/*
 * Typing a room code must not play the game.
 *
 * Every action in `ui/controls.ts` is a bare letter on a window listener, and a
 * room code is six letters and digits — so typing one drove the game. `N` is
 * the probe because its effect is the most visible of the lot: it toggles this
 * very panel, so the lobby closed itself halfway through entering the code for
 * the room it was going to join. `T` opens the tuning panel and `R` restarts
 * the run, and both are checked here for the same money.
 */
await page.click('[data-act="join"]');
await page.waitForSelector('[data-act="room-in"]');
await page.focus('[data-act="room-in"]');
await page.keyboard.type('NTR2X9');
if (!(await page.$('.lobby.is-open'))) throw new Error('typing N in the room field closed the lobby');
if (await page.$('.tuning.is-open')) throw new Error('typing T in the room field opened the tuning panel');
const typed = await page.inputValue('[data-act="room-in"]');
if (typed !== 'NTR2X9') throw new Error(`the room field did not get what was typed: "${typed}"`);
console.log(`typing a room code stays in the room code field: "${typed}"`);

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

// The classification, and the way out of a lobby.
//
// Neither is reachable without a whole grid finishing a stage together, so
// without a check here nobody looks at either until it is broken. A race used
// to drop you back into the lobby four seconds after *you* finished, which
// threw away the only thing anybody wanted from it.
await page.goto('http://localhost:5181/?vision=0&drama=0&screen=results');
await page.waitForSelector('.lobby.is-open .lobby-results li', { timeout: 20_000 });
const table = await page.$$eval('.lobby-results li', (rows) =>
  rows.map((r) => (r.textContent ?? '').trim().replace(/\s+/g, ' ')),
);
if (table.length !== 4) throw new Error(`the classification lists ${table.length} cars, not 4`);
// Ordered by time, with the retirement last and unplaced.
if (!table[0]!.startsWith('1 ')) throw new Error(`the winner is not first: ${table[0]}`);
if (!table[3]!.startsWith('—')) throw new Error(`a retirement was given a position: ${table[3]}`);
if (!table[1]!.includes('+')) throw new Error('no gap to the winner is shown');
if (!(await page.$('[data-act="to-lobby"]'))) throw new Error('no way back to the lobby');
if (!(await page.$('[data-act="leave"]'))) throw new Error('no way to leave the lobby');
console.log(`classification: ${table.join(' | ')}`);

// The stage and conditions dropdowns must not be text-on-text.
//
// A `select` with an `rgba()` background gets its open list composited by the
// platform, not the page, so the options came out on a near-white sheet with
// this panel's light text on them — invisible, and only once opened.
await page.goto('http://localhost:5181/?vision=0&drama=0&screen=lobby');
await page.waitForSelector('.lobby-field select', { timeout: 20_000 });
// Evaluated as a string, not a function: esbuild rewrites named inner
// functions with a `__name` helper that does not exist in the page.
const contrast = (await page.evaluate(`(() => {
  const s = getComputedStyle(document.querySelector('.lobby-field select option'));
  const lum = (c) => {
    const p = (c.match(/[0-9]+/g) || ['0','0','0']).map(Number);
    return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
  };
  return { bg: s.backgroundColor, fg: s.color, gap: Math.abs(lum(s.backgroundColor) - lum(s.color)) };
})()`)) as { bg: string; fg: string; gap: number };
if (contrast.gap < 0.35) {
  throw new Error(`dropdown options are ${contrast.fg} on ${contrast.bg} — unreadable`);
}
console.log(`dropdown options: ${contrast.fg} on ${contrast.bg}`);

// The volume slider on the front screen. There was only a mute before — the M
// key, all or nothing, and on a phone with no keyboard not even that.
await page.goto('http://localhost:5181/?vision=0&drama=0');
await page.waitForSelector('.menu.is-open [data-act="volume"]', { timeout: 20_000 });
const slider = await page.locator('[data-act="volume"]').boundingBox();
// Tall enough for a thumb: a native range defaults to about eight pixels.
if (!slider || slider.height < 18) {
  throw new Error(`the volume slider is ${slider?.height ?? 0}px tall — not thumb-sized`);
}
await page.locator('[data-act="volume"]').fill('30');
await page.locator('[data-act="volume"]').dispatchEvent('input');
const reads = (await page.textContent('.menu-volume b'))?.trim();
if (reads !== '30%') throw new Error(`the volume readout says "${reads}", not 30%`);
console.log(`volume slider: ${slider.width.toFixed(0)}x${slider.height.toFixed(0)}px, reads ${reads}`);

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

/*
 * The world record, on the HUD, during the race.
 *
 * Checked at the point the stage loads rather than after a lap: the row is
 * filled by `loadStage`, so waiting for the green would only be waiting.
 *
 * Arcade and multiplayer only, and that half matters as much — a career time
 * is set in whatever that player's garage has built, so a stock-car record
 * beside it compares two different cars. Both halves are asserted below.
 */
await page.goto('http://localhost:5181/?vision=0&drama=0&rooms=http://localhost:5181');
await page.waitForFunction(() => window.RSC?.ready === true);
await page.waitForSelector('.menu.is-open');
await page.click('[data-action="arcade"]');
await page.waitForSelector('.menu-row');
await page.locator('.menu-row[data-id="quarry-run:day-clear"]').click();
await page.waitForFunction(() => (window.RSC!.status() as { stage: string }).stage === 'quarry-run');

await page.waitForFunction(
  () => (document.querySelector('.race-wr') as HTMLElement | null)?.hidden === false,
  { timeout: 15_000 },
);
const wr = (await page.locator('.race-wr').textContent())?.replace(/\s+/g, ' ').trim();
console.log(`world record on the HUD: "${wr}"`);
if (!wr?.includes('Solveig')) throw new Error(`the record has no name on it: "${wr}"`);
if (!wr?.includes('41.62')) throw new Error(`the record has the wrong time on it: "${wr}"`);

/*
 * And nothing on the race HUD sits on top of anything else.
 *
 * `mobilecheck` has asserted this at phone size for a long time and nothing
 * asserted it at desktop size, which is how the surface readout came to be
 * printed through the word CONDITION on every wide window: `.hud-tl` is 65 px
 * tall and `.damage` started at 16. Two absolutely positioned panels both
 * claiming a corner, caught on the phone and never on the desktop, because
 * only one of the two layouts was ever measured.
 *
 * Checked with both times showing, which is the tallest the left column gets.
 */
const clash = (await page.evaluate(`(() => {
  const names = ['.hud-tl', '.race-times', '.damage', '.race-top', '.minimap',
                 '.race-notes', '.race-status', '.hud-bl', '.hud-br'];
  const found = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const x = document.querySelector(names[i]);
      const y = document.querySelector(names[j]);
      if (!x || !y) continue;
      const a = x.getBoundingClientRect();
      const b = y.getBoundingClientRect();
      if (a.width === 0 || a.height === 0 || b.width === 0 || b.height === 0) continue;
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        found.push(names[i] + ' over ' + names[j]);
      }
    }
  }
  return found;
})()`)) as string[];
if (clash.length > 0) throw new Error(`race HUD pieces on top of each other: ${clash.join(', ')}`);

// And the status strip is along the bottom edge, which is the point of moving
// it off the top: a third of the screen height below the clock, not under it.
const statusBox = (await page.locator('.race-status').boundingBox())!;
const tall = await page.evaluate(() => window.innerHeight);
if (statusBox.y < tall * 0.75) {
  throw new Error(`the status strip is at y ${statusBox.y}, not near the bottom`);
}
console.log(
  `race HUD: nothing overlaps, status strip at the bottom (y ${Math.round(statusBox.y)} of ${tall})`,
);

// And a career run shows none of it, whatever the board says.
await page.keyboard.press('Escape');
await page.waitForSelector('.menu.is-open');
await page.click('[data-action="career"]');
await page.waitForSelector('.garage.is-open');
const careerWr = await page.evaluate(
  () => (document.querySelector('.race-wr') as HTMLElement | null)?.hidden !== false,
);
if (!careerWr) throw new Error('a career run is showing a stock-car world record');
console.log('career shows no world record, because a career car is not that car');

console.log('OK — career, arcade and multiplayer all open from the front door.');
await browser.close();
await server.close();
