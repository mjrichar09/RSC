/**
 * The game on a phone, driven by thumbs.
 *
 * `uicheck` drives the same flows with a keyboard at 900x600, which is exactly
 * the case that was already working. This is the one that was not: a 844x390
 * landscape viewport, touch events rather than keys, and no keyboard at all —
 * so a control that only exists as a key binding fails here, and a HUD that
 * assumes a desktop's worth of room shows it.
 *
 *   npm run mobilecheck
 *
 * The measurement that matters is the last one: a thumb on the throttle has to
 * move the car, and a thumb dragged across the steering pad has to turn it.
 * Everything else is a way of getting far enough to try.
 */

import { existsSync, readdirSync } from 'node:fs';
import { chromium, devices } from '@playwright/test';
import { createServer } from 'vite';

function findChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const exe = `${root}/${d}/chrome-linux/chrome`;
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const server = await createServer({ server: { port: 5185 }, logLevel: 'error' });
await server.listen();
const executablePath = findChromium();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

// A phone held sideways, which is the only way anybody plays a driving game.
const phone = devices['iPhone 13'];
const context = await browser.newContext({
  ...phone,
  viewport: { width: 844, height: 390 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const status = async () => (await page.evaluate(() => window.RSC!.status())) as Record<string, unknown>;
const fail = (message: string): never => {
  throw new Error(message);
};

try {
  // `drama=0` keeps a crash replay from covering the controls mid-measurement.
  await page.goto('http://localhost:5185/?drama=0&quality=low');
  await page.waitForFunction(() => window.RSC?.ready === true, { timeout: 30_000 });
  await page.waitForSelector('.menu.is-open');
  console.log('menu opens on a phone');

  // Nothing may overflow the viewport: a menu you cannot scroll to the bottom
  // of is a menu with a button you cannot press.
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  if (overflow.x > 1) fail(`the page is ${overflow.x}px wider than the screen`);

  // Touch, not click: the whole point is that this works without a mouse.
  await page.tap('[data-action="arcade"]');
  await page.waitForSelector('.menu-row');
  await page.locator('.menu-row[data-id="pine-loop:day-clear"]').tap();
  await page.waitForFunction(() => (window.RSC!.status() as { stage: string }).stage === 'pine-loop');
  console.log('arcade picks a stage by tapping');

  // The controls have to be *there*, and they only appear once something has
  // actually touched the screen — which by now it has.
  await page.waitForSelector('.touch.is-on', { timeout: 5000 });
  for (const control of ['steer', 'throttle', 'brake', 'handbrake', 'menu']) {
    const box = await page.locator(`[data-touch="${control}"]`).boundingBox();
    if (!box) fail(`no on-screen ${control}`);
    // Everybody's minimum comfortable target, and a phone is where it matters.
    if (control !== 'steer' && Math.min(box!.width, box!.height) < 44) {
      fail(`the ${control} control is ${Math.min(box!.width, box!.height).toFixed(0)}px — too small to hit`);
    }
  }
  console.log('on-screen controls appear once a finger is used');

  await page.waitForFunction(() => (window.RSC!.status() as { held: boolean }).held === false, {
    timeout: 60_000,
  });

  // Thumb on the throttle. Held down, the way a thumb is.
  const gas = (await page.locator('[data-touch="throttle"]').boundingBox())!;
  const before = (await status()).carsAt as [number, number][];
  await page.touchscreen.tap(gas.x + gas.width / 2, gas.y + gas.height / 2);
  // `tap` is a press and a release; hold it properly through CDP instead.
  const cdp = await context.newCDPSession(page);
  const at = { x: gas.x + gas.width / 2, y: gas.y + gas.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: at.x, y: at.y, id: 1 }],
  });
  await page.waitForTimeout(6000);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  const after = (await status()).carsAt as [number, number][];
  const drove = Math.hypot(after[0]![0] - before[0]![0], after[0]![1] - before[0]![1]);
  console.log(`thumb on the throttle drove ${drove.toFixed(1)} m`);
  if (drove < 5) fail('the throttle button did not move the car');

  // And the steering pad. Press in the left third, drag right, check the car
  // turns the way the thumb went.
  const pad = (await page.locator('[data-touch="steer"]').boundingBox())!;
  const from = { x: pad.x + pad.width * 0.5, y: pad.y + pad.height * 0.7 };
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: at.x, y: at.y, id: 1 }, { x: from.x, y: from.y, id: 2 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: at.x, y: at.y, id: 1 }, { x: from.x + 90, y: from.y, id: 2 }],
  });
  const steered = await page.evaluate(() => (window.RSC!.status() as { steer: number }).steer);
  await page.waitForTimeout(2500);
  const turning = await page.evaluate(() => (window.RSC!.status() as { steer: number }).steer);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  console.log(`thumb dragged right gives steer ${turning.toFixed(2)} (was ${steered.toFixed(2)})`);
  if (turning < 0.4) fail('dragging the steering pad did not steer the car');

  await page.screenshot({ path: 'shots/mobile.png' });

  // Nothing on the HUD may sit on top of anything else, and nothing may sit
  // under a thumb. Checked as geometry rather than by eye, because "the panels
  // overlap on a phone" is exactly the kind of thing a desktop screenshot
  // cannot show and nobody notices until they try to read one.
  // esbuild's name-keeping transform injects a `__name` helper into any named
  // function inside an evaluated block, and that helper does not exist in the
  // page — so this is written without local function bindings on purpose.
  const clashes = (await page.evaluate(`(() => {
    const names = ['.damage', '.hud-tl', '.minimap', '[data-touch="menu"]', '.cluster', '.touch-pedals'];
    const rects = names.map((s) => {
      const el = document.querySelector(s);
      return el ? el.getBoundingClientRect() : null;
    });
    const found = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        if (!a || !b) continue;
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
          found.push(names[i] + ' over ' + names[j]);
        }
      }
    }
    return found;
  })()`)) as string[];
  if (clashes.length > 0) fail(`HUD pieces on top of each other: ${clashes.join(', ')}`);

  // The steering pad is deliberately huge and deliberately under the HUD — it
  // takes the whole left third so a thumb never has to aim. That is only safe
  // while everything drawn over it lets the touch through.
  const blocking = (await page.evaluate(`(() => {
    const pad = document.querySelector('[data-touch="steer"]').getBoundingClientRect();
    const bad = [];
    document.querySelectorAll('#hud *').forEach((el) => {
      if (el.closest('.touch')) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (!(r.left < pad.right && pad.left < r.right && r.top < pad.bottom && pad.top < r.bottom)) return;
      if (getComputedStyle(el).pointerEvents !== 'none') bad.push(el.className || el.tagName);
    });
    return bad;
  })()`)) as string[];
  if (blocking.length > 0) fail(`swallowing steering touches: ${[...new Set(blocking)].join(', ')}`);
  console.log('nothing on the HUD overlaps anything else, or blocks the steering pad');

  // The menus. A panel taller than a landscape phone with no way to scroll is
  // a stage list whose bottom half does not exist.
  await page.locator('[data-touch="menu"]').tap();
  await page.waitForSelector('.menu.is-open, .garage.is-open', { timeout: 5000 });
  const panels = (await page.evaluate(`(() => {
    const out = [];
    ['.menu-inner', '.garage-inner', '.lobby-inner'].forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      out.push({
        sel,
        offscreen: Math.max(0, Math.round(r.bottom - window.innerHeight)),
        scrollable: style.overflowY === 'auto' || style.overflowY === 'scroll' || el.scrollHeight <= el.clientHeight + 1,
      });
    });
    return out;
  })()`)) as { sel: string; offscreen: number; scrollable: boolean }[];
  for (const panel of panels) {
    if (panel.offscreen > 2 && !panel.scrollable) {
      fail(`${panel.sel} runs ${panel.offscreen}px off the bottom with no way to scroll to it`);
    }
  }
  console.log(`menus fit or scroll: ${panels.map((p) => p.sel).join(', ') || 'none open'}`);

  // The garage becomes three views on a phone rather than one long stack.
  //
  // Stacked, the two things a player comes to the garage for — the repair bill
  // and the stage list — were the furthest apart on the page, several screens
  // of scrolling between them. Worth checking here because the desktop layout
  // shows all three at once and would never notice this breaking.
  // Into the garage, which is where the tabs are. The menu is what opens on the
  // pause button; career is one tap further in.
  if (await page.$('[data-action="career"]')) {
    await page.locator('[data-action="career"]').tap();
    await page.waitForSelector('.garage.is-open', { timeout: 8000 });
  }
  if (await page.$('.garage.is-open')) {
    const tabs = await page.$$('.garage-tabs button');
    if (tabs.length !== 3) fail(`the garage shows ${tabs.length} tabs on a phone, not 3`);
    const shown = async () =>
      page.evaluate(`(() => Array.from(document.querySelectorAll('.garage-cols > section'))
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => el.getAttribute('data-tab')))()`) as Promise<string[]>;
    if ((await shown()).length !== 1) {
      fail(`the garage is showing ${(await shown()).length} panels at once on a phone`);
    }
    // And each tab reaches its own panel.
    for (const want of ['repairs', 'car', 'stages']) {
      await page.locator(`.garage-tabs button[data-id="${want}"]`).tap();
      const now = await shown();
      if (now.length !== 1 || now[0] !== want) {
        fail(`tapping "${want}" showed ${JSON.stringify(now)}`);
      }
    }
    console.log('garage: three tabs, one panel at a time, each reachable');
  }
  await page.screenshot({ path: 'shots/mobile-menu.png' });

  // Portrait. There is no layout for it and there should not be — a portrait
  // phone is narrower than the car is on screen — so the one thing that has to
  // happen is that the player is told which way up to hold it.
  //
  // A second context rather than resizing this one. `setViewportSize` drives
  // the browser window, and headless Chrome refuses it outright — "to resize
  // minimized/maximized/fullscreen window, restore it to normal state first" —
  // so this check has been killing the whole run before it could report
  // anything. A context is created at the size it wants and never resized.
  const upright = await browser.newContext({
    ...phone,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const tall = await upright.newPage();
  await tall.goto('http://localhost:5185/?drama=0&quality=low', { waitUntil: 'domcontentloaded' });
  await tall.waitForSelector('#view', { timeout: 20_000 });
  // The touch layer stays off until something touches it — a desktop with a
  // mouse should never get thumb controls — so the prompt does not exist until
  // the player has actually touched the screen. One tap is what a real player
  // does first anyway.
  // A `pointerdown` with `pointerType: 'touch'`, which is exactly what
  // `main.ts` listens for. Dispatched rather than aimed, because in portrait
  // the menu covers the canvas and the point is only to tell the game a finger
  // exists — which on a real phone the first tap does anyway.
  await tall.evaluate(`(() => {
    window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  })()`);
  await tall.waitForSelector('.rotate-me.is-on', { timeout: 15_000 }).catch(() => {
    fail('a portrait phone gets no prompt to turn it');
  });
  console.log('portrait asks for the phone to be turned');
  await upright.close();

  console.log('OK — it plays on a phone. shots/mobile.png');
} finally {
  await browser.close();
  await server.close();
}
