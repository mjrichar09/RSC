/**
 * Two browsers, one race.
 *
 * Everything else about the netcode is tested headlessly over a loopback wire,
 * which is the right way to test a protocol. This tests the part a loopback
 * cannot: that two real pages exchange two codes, open a real WebRTC data
 * channel, and that what one of them drives, the other one sees.
 *
 *   npm run netcheck
 *
 * It drives the lobby through its own DOM rather than through a back door, so
 * a broken button fails this too.
 */

import { existsSync, readdirSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';
import { createServer } from 'vite';

/** The same preinstalled-Chromium lookup the screenshot harness uses. */
function findChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse()) {
    const exe = `${root}/${dir}/chrome-linux/chrome`;
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const WAIT = { timeout: 60_000 };

/** The game's own status JSON, which is cheaper to check than a screenshot. */
async function status(page: Page): Promise<Record<string, unknown>> {
  return (await page.evaluate(() => window.RSC!.status())) as Record<string, unknown>;
}

async function openLobby(page: Page): Promise<void> {
  await page.waitForFunction(() => window.RSC?.ready === true, WAIT);
  await page.keyboard.press('n');
  await page.waitForSelector('.lobby.is-open', WAIT);
}

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5178 }, logLevel: 'error' });
  await server.listen();
  // Small and plain: two pages rendering a full-size scene through software
  // WebGL run at a few frames a second, and the simulation is capped at a
  // quarter-second per frame, so a big window makes this a test of SwiftShader.
  const url = 'http://localhost:5178/?vision=0';

  const executablePath = findChromium();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      // Two pages, both racing: without these Chromium throttles the one that
      // is not in front down to about a frame a second, and the "host" sits
      // still while the test blames the netcode.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Headless Chromium hides local IPs behind mDNS names that nothing in a
      // test rig can resolve, so the two pages would gather candidates they
      // could never use. This is the flag that lets loopback WebRTC work.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });

  const fail = (message: string): never => {
    throw new Error(message);
  };

  try {
    const host = await browser.newPage({ viewport: { width: 480, height: 320 } });
    const guest = await browser.newPage({ viewport: { width: 480, height: 320 } });
    for (const page of [host, guest]) {
      page.on('pageerror', (error) => console.error('page error:', error.message));
      // Only one page can be in front, and Chromium does not run
      // requestAnimationFrame for a hidden one at all — so without this the
      // "host" advances about half a second of simulation in four seconds of
      // wall clock and the test blames the network for it.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await page.goto(url);
    }

    await openLobby(host);
    await openLobby(guest);

    // Host: make an invite. The code lives inside a folded-away `details` now,
    // because the path a player takes is a share sheet rather than a
    // select-and-copy — so it is read from the DOM rather than clicked on.
    await host.click('[data-act="host"]');
    await host.click('[data-act="invite"]');
    await host.waitForSelector('[data-act="code"]', { ...WAIT, state: 'attached' });
    const link = await host.$eval('[data-act="code"]', (el) => (el as HTMLTextAreaElement).value);
    console.log(`invite link: ${link.length} characters`);

    // Guest: open the link. This is the whole of the joiner's side now — no
    // screen to find, no code to paste — so it is what the check should drive.
    await guest.goto(link);
    await guest.waitForFunction(() => window.RSC?.ready === true, WAIT);
    try {
      await guest.waitForSelector('[data-act="code"]', { ...WAIT, state: 'attached' });
    } catch (error) {
      console.error('guest lobby says:', await guest.innerText('.lobby-inner'));
      throw error;
    }
    const reply = await guest.$eval('[data-act="code"]', (el) => (el as HTMLTextAreaElement).value);
    console.log(`reply code:  ${reply.length} characters`);

    // Host: take it. The one-tap path reads the clipboard, which a headless
    // browser will not grant, so this drives the by-hand fallback — which is
    // the path that has to keep working when a browser refuses the easy one.
    await host.click('.lobby-raw summary >> nth=1');
    await host.fill('[data-act="reply"]', reply);
    await host.click('[data-act="accept"]');
    await host.waitForSelector('.lobby-players li:nth-child(2)', WAIT);
    console.log('connected: the guest is on the grid');

    await host.click('[data-act="start"]');
    for (const page of [host, guest]) {
      await page.waitForFunction(() => (window.RSC!.status() as { cars: number }).cars === 2, WAIT);
      // The start lights hold the car on the line, and the countdown runs on
      // frame time — two pages sharing one software renderer take minutes of
      // wall clock to get through four seconds of it. Waited on as state
      // rather than as the green lamp on screen, which shows for a second and
      // a half and is a coin toss to catch. Without this the host presses the
      // throttle against the handbrake and the netcode gets the blame.
      await page.waitForFunction(() => (window.RSC!.status() as { held: boolean }).held === false, {
        timeout: 120_000,
      });
    }

    // Drive the host's car and watch it move on the guest's screen. This is the
    // whole point: snapshots crossing a real data channel.
    type Ground = [number, number];
    const gap = (a: Ground, b: Ground) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const before = (await status(guest)).carsAt as Ground[];
    await host.keyboard.down('w');
    await host.waitForTimeout(8000);
    await host.keyboard.up('w');
    await guest.waitForTimeout(500);

    const hostState = await status(host);
    const guestState = await status(guest);
    const after = guestState.carsAt as Ground[];

    console.log('host: ', JSON.stringify(hostState));
    console.log('guest:', JSON.stringify({ carsAt: after, net: guestState.net }));

    // The host is car 0 in its own world and car 1 in the guest's.
    const drove = gap((hostState.carsAt as Ground[])[0]!, before[1]!);
    const seen = gap(after[1]!, before[1]!);
    console.log(`host drove ${drove.toFixed(1)} m; the guest saw ${seen.toFixed(1)} m of it`);

    if (seen < 3) fail('the guest never saw the host move — no snapshots got through');
    // Some lag is the interpolation delay doing its job; a lot of it is a bug.
    if (Math.abs(seen - drove) > 4) fail(`the guest is ${(drove - seen).toFixed(1)} m out of date`);

    // And now the other way. This half was missing, which is how "the joiner's
    // car does not move on the host's screen" could be true without any test
    // noticing: the guest's inputs go *up* the wire and are applied by the host,
    // which is a different path from snapshots coming down it.
    const hostBefore = (await status(host)).carsAt as Ground[];
    const guestBefore = (await status(guest)).carsAt as Ground[];
    await guest.keyboard.down('w');
    await guest.waitForTimeout(8000);
    await guest.keyboard.up('w');
    await host.waitForTimeout(500);

    const hostAfter = (await status(host)).carsAt as Ground[];
    const guestAfter = (await status(guest)).carsAt as Ground[];
    // The guest is car 0 in its own world and car 1 in the host's.
    const guestDrove = gap(guestAfter[0]!, guestBefore[0]!);
    const hostSaw = gap(hostAfter[1]!, hostBefore[1]!);
    console.log(`guest drove ${guestDrove.toFixed(1)} m; the host saw ${hostSaw.toFixed(1)} m of it`);

    if (hostSaw < 3) fail('the host never saw the guest move — the guest inputs never arrived');
    console.log('OK — two browsers, one race, both directions.');
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
