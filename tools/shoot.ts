/**
 * Visual harness.
 *
 * Boots the game in headless Chromium, drives it from scripted traces, and
 * stitches every frame into ONE labelled composite PNG.
 *
 *   npm run shoot
 *   npm run shoot -- --grid=2x2 --cells=launch@2,slalom@6,handbrake@5.6,circle@8
 *   npm run shoot -- --out=camera --cell=circle@8 --grid=1x1
 *
 * Composites rather than image bursts is a deliberate cost decision: four
 * variants side by side answer a comparison question for the price of one
 * image. See "Verification efficiency" in the plan.
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

// 640x360 per cell is deliberately small: it is enough to answer "is this laid
// out right", and detail beyond that answers no question worth the bytes.
const [CELL_W, CELL_H] = arg('size', '640x360').split('x').map(Number) as [number, number];

// A cell is `<stage-id>@<seconds>`, or `trace:<name>@<seconds>` for the
// proving ground. Stage cells are driven by the AI so the frame is repeatable.
const cellSpec = arg('cells', 'pine-loop@22,quarry-run@26,north-pass@30,pine-loop@44');
/** Driver commitment for stage cells, so a frame can catch the car at real pace. */
const grip = arg('grip', '0.6');
/** `--loosen=15000` works the nose mounts loose, in N·s, then runs `--after` seconds. */
const loosenArg = arg('loosen', '');
const afterArg = arg('after', '');
/** `--vision=0.6` scales the windscreen effect; `vis<N>:` does it per cell. */
const visionArg = arg('vision', '');
/** `--sign=2` centres the camera on that corner board. */
const signArg = arg('sign', '');
/** `--zoom=9` pulls the camera in, for questions about the car itself. */
const zoomArg = arg('zoom', '');
/** `--brakes=650` preheats the brake discs, in °C, for the glow. */
const brakesArg = arg('brakes', '');
/** `--variant=night-rain` shoots the stage under those conditions. */
const variantArg = arg('variant', '');
/** `--cars=4` fills the grid, for looking at a multiplayer start. */
const carsArg = arg('cars', '');
/** `--boil=0.95` puts the coolant near boiling, for the steam. */
const boilArg = arg('boil', '');
/** `--knock=6` lays down the marker poles nearest the car. */
const knockArg = arg('knock', '');
const [gridCols, gridRows] = arg('grid', '2x2').split('x').map(Number) as [number, number];
const outName = arg('out', 'composite');

const cells = cellSpec.split(',').map((spec) => {
  const [name, t] = spec.split('@');
  const seconds = Number(t ?? '3');
  const isTrace = name!.startsWith('trace:');
  // `ghost:` seeds a recorded AI lap first, so the frame shows the chase.
  const withGhost = name!.startsWith('ghost:');
  // `crash:<stage>:<seconds>@<t>` drives into the bank before the frame, and a
  // cell may name its own variant as `<stage>/<variant>`.
  const crashMatch = /^crash(\d+(?:\.\d+)?)?:(.+)$/.exec(name!);
  const crashFor = crashMatch ? Number(crashMatch[1] ?? '2') : 0;
  // `hot<°C>:<stage>` preheats the discs for that cell alone, so one composite
  // can answer "what does each temperature look like".
  const hotMatch = /^hot(\d+):(.+)$/.exec(name!);
  const hotFor = hotMatch ? hotMatch[1]! : brakesArg;
  // `loose<N·s>x<seconds>:<stage>` works the nose mounts loose for that cell
  // and then runs on, so one composite can show attached, dragging and gone.
  // `wreck<N·s>:<stage>` beats the car up before the frame.
  // `vis<0-100>:<stage>` sets the windscreen strength as a percentage, so one
  // composite can ladder it.
  const visMatch = /^vis(\d+):(.+)$/.exec(name!);
  const visionFor = visMatch ? (Number(visMatch[1]) / 100).toFixed(2) : visionArg;
  const wreckMatch = /^wreck(\d+):(.+)$/.exec(name!);
  const looseMatch = /^loose(\d+)(?:x(\d+(?:\.\d+)?))?:(.+)$/.exec(name!);
  const looseFor = looseMatch ? looseMatch[1]! : loosenArg;
  const afterFor = looseMatch ? (looseMatch[2] ?? '2') : afterArg;

  // `garage` shoots the stage-select screen itself, which is the only place
  // the variant list is visible.
  // `menu` and `menu:arcade` shoot the front door and the arcade list.
  const menuMatch = /^menu(?::(\w+))?$/.exec(name!);
  if (menuMatch) {
    return {
      url: menuMatch[1] ? `/?screen=${menuMatch[1]}` : '/',
      label: menuMatch[1] ? `menu · ${menuMatch[1]}` : 'menu',
    };
  }

  // `garage` or `garage:<N·s>` — the second wrecks the car first, so the
  // turntable and the repair list can be seen together.
  const garageMatch = /^garage(?::(\d+))?$/.exec(name!);
  if (garageMatch) {
    return {
      url: garageMatch[1]
        ? `/?screen=garage&wreckCar=${garageMatch[1]}`
        : '/?screen=garage',
      label: garageMatch[1] ? `garage · wrecked ${garageMatch[1]} N·s` : 'garage',
    };
  }

  const raw = isTrace || withGhost
    ? name!.slice(6)
    : (crashMatch?.[2] ?? hotMatch?.[2] ?? looseMatch?.[3] ?? wreckMatch?.[2] ?? visMatch?.[2] ?? name!);
  const [id, cellVariant] = raw.split('/');
  const useVariant = cellVariant ?? variantArg;
  const url = isTrace
    ? `/?trace=${id}&t=${seconds}`
    : `/?stage=${id}&t=${seconds}&grip=${grip}${useVariant ? `&variant=${useVariant}` : ''}${
        withGhost ? '&ghost=1' : ''
      }${crashFor ? `&crash=${crashFor}` : ''}${hotFor ? `&brakes=${hotFor}` : ''}${zoomArg ? `&zoom=${zoomArg}` : ''}${looseFor ? `&loosen=${looseFor}` : ''}${afterFor ? `&after=${afterFor}` : ''}${
        wreckMatch ? `&wreck=${wreckMatch[1]}` : ''
      }${signArg ? `&sign=${signArg}` : ''}${visionFor ? `&vision=${visionFor}` : ''}${carsArg ? `&cars=${carsArg}` : ''}${boilArg ? `&boil=${boilArg}` : ''}${knockArg ? `&knock=${knockArg}` : ''}`;
  return {
    url,
    label: `${id}${useVariant ? ` ${useVariant}` : ''} @ ${seconds}s${withGhost ? ' + ghost' : ''}${
      crashFor ? ` + ${crashFor}s crash` : ''
    }${carsArg ? ` · ${carsArg} cars` : ''}${boilArg ? ` · boiling` : ''}${hotMatch ? ` · ${hotFor}°C` : ''}${
      looseMatch ? ` · ${looseFor} N·s +${afterFor}s` : ''
    }`,
  };
});

const server = await createServer({ server: { port: 0 }, logLevel: 'error' });
await server.listen();
const port = server.config.server.port ?? (server.httpServer!.address() as { port: number }).port;
const origin = `http://localhost:${port}`;

/**
 * Use whatever Chromium is already on the machine rather than downloading one.
 * Playwright pins an exact browser build per release, so a preinstalled browser
 * from a different build is found by path instead of by version.
 */
function findChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const d of dirs) {
    const exe = `${root}/${d}/chrome-linux/chrome`;
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const executablePath = findChromium();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [
    // SwiftShader gives deterministic software WebGL, so a composite looks the
    // same whether or not the machine running it has a GPU.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: CELL_W, height: CELL_H } });
  // A page error is worth more than the screenshot that would have hidden it:
  // an exception in the audio graph or a renderer leaves a frame that looks
  // almost right and a game that is broken.
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    // The favicon is not part of the game.
    if (msg.type() === 'error' && !msg.text().includes('favicon')) {
      problems.push(`console: ${msg.text()}`);
    }
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('favicon')) {
      problems.push(`${res.status()} ${res.url()}`);
    }
  });
  const shots: string[] = [];

  for (const cell of cells) {
    await page.goto(`${origin}${cell.url}`, { waitUntil: 'load' });
    try {
      await page.waitForFunction(() => window.RSC?.rendered === true, undefined, { timeout: 90_000 });
    } catch (error) {
      // A page that never renders has almost always thrown, and the exception
      // is far more useful than the timeout that hid it.
      console.error(`\n${cell.label} never rendered.`);
      for (const problem of problems) console.error(`  ${problem}`);
      throw error;
    }
    // Audio only builds on a gesture, so press a key before the frame: it is
    // the only way this harness ever exercises the sound graph at all.
    await page.keyboard.press('KeyM');
    const buf = await page.screenshot({ type: 'png' });
    shots.push(`data:image/png;base64,${buf.toString('base64')}`);
    // Print the game's own numbers alongside: text is far cheaper to check than
    // an image, and most questions a frame raises are answerable from it.
    const status = await page.evaluate(() => window.RSC?.status?.() ?? null);
    console.log(`  captured ${cell.label}  ${status ? JSON.stringify(status) : ''}`);
  }

  // Stitch in-page: an offscreen canvas is already available and needs no
  // native image dependency in Node.
  const composite = await page.evaluate(
    async ({ images, labels, cols, rows, w, h }) => {
      const canvas = document.createElement('canvas');
      canvas.width = cols * w;
      canvas.height = rows * h;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#0c0f14';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < images.length; i++) {
        const img = new Image();
        img.src = images[i]!;
        await img.decode();
        const x = (i % cols) * w;
        const y = Math.floor(i / cols) * h;
        ctx.drawImage(img, x, y, w, h);

        ctx.fillStyle = 'rgba(12,15,20,0.78)';
        ctx.fillRect(x + 8, y + 8, 200, 26);
        ctx.fillStyle = '#f2c14e';
        ctx.font = '600 15px ui-monospace, monospace';
        ctx.fillText(labels[i] ?? '', x + 18, y + 26);

        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
      return canvas.toDataURL('image/png');
    },
    {
      images: shots,
      labels: cells.map((c) => c.label),
      cols: gridCols,
      rows: gridRows,
      w: CELL_W,
      h: CELL_H,
    },
  );

  if (problems.length > 0) {
    console.error(`\n${problems.length} page error(s):`);
    for (const problem of problems.slice(0, 10)) console.error(`  ${problem}`);
  }

  const path = `shots/${outName}.png`;
  writeFileSync(path, Buffer.from(composite.split(',')[1]!, 'base64'));
  console.log(`\n-> ${path}  (${gridCols}x${gridRows}, ${cells.length} frames in one image)`);
  if (problems.length > 0) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
