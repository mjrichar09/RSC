/**
 * Generate the application icon.
 *
 *   npm run icon
 *
 * Writes a PNG directly with Node's zlib rather than pulling in an image
 * library or committing a binary blob nobody can diff: the icon is a handful of
 * rectangles, so it may as well be code.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 512;

type RGBA = [number, number, number, number];

const BACKGROUND: RGBA = [0x18, 0x1d, 0x27, 255];
const ROAD: RGBA = [0x3b, 0x3f, 0x46, 255];
const BODY: RGBA = [0xe8, 0x55, 0x2f, 255];
const ACCENT: RGBA = [0xf2, 0xc1, 0x4e, 255];
const GLASS: RGBA = [0x1f, 0x24, 0x2c, 255];

const pixels = new Uint8Array(SIZE * SIZE * 4);

function fill(color: RGBA): void {
  for (let i = 0; i < SIZE * SIZE; i++) pixels.set(color, i * 4);
}

/** Axis-aligned rounded rectangle, rotated about the icon centre. */
function rect(cx: number, cy: number, hw: number, hh: number, angle: number, color: RGBA, radius = 0): void {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const reach = Math.ceil(Math.hypot(hw, hh)) + 2;

  // Integer loop bounds: a fractional centre made these fractional too, and the
  // pixel index then landed off a 4-byte boundary and shifted every colour
  // channel by a byte — which looks like corruption, not like a misplaced shape.
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(SIZE, Math.ceil(cy + reach));
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(SIZE, Math.ceil(cx + reach));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const lx = Math.abs(dx * cos - dy * sin);
      const ly = Math.abs(dx * sin + dy * cos);
      if (lx > hw || ly > hh) continue;
      // Round the corners by testing the corner circle.
      if (radius > 0 && lx > hw - radius && ly > hh - radius) {
        if (Math.hypot(lx - (hw - radius), ly - (hh - radius)) > radius) continue;
      }
      pixels.set(color, (y * SIZE + x) * 4);
    }
  }
}

fill(BACKGROUND);

// A slab of road running across the icon at the game's isometric angle.
rect(SIZE / 2, SIZE / 2, SIZE * 0.62, SIZE * 0.2, -Math.PI / 7, ROAD);

// The car, seen from the same fixed angle the game uses.
const angle = -Math.PI / 7;
const cx = SIZE / 2;
const cy = SIZE / 2;

/**
 * A point offset from the car's centre *along its own axes*.
 * Offsetting in screen space instead puts the nose flash out in mid-air, which
 * is exactly what it did the first time.
 */
const onCar = (along: number, across: number): [number, number] => [
  cx + Math.cos(angle) * along - Math.sin(angle) * across,
  cy + Math.sin(angle) * along + Math.cos(angle) * across,
];

// Wheels first, so the body sits over them.
for (const [along, across] of [
  [92, 84],
  [92, -84],
  [-92, 84],
  [-92, -84],
] as const) {
  const [wx, wy] = onCar(along, across);
  rect(wx, wy, 34, 16, angle, [0x14, 0x17, 0x1c, 255], 6);
}

rect(cx, cy, 132, 74, angle, BODY, 18);

const [gx, gy] = onCar(-22, 0);
rect(gx, gy, 58, 46, angle, GLASS, 10);

// Nose flash: the same cue the in-game car uses to show which end is the front.
const [nx, ny] = onCar(112, 0);
rect(nx, ny, 18, 62, angle, ACCENT, 6);

/** Wrap raw RGBA into a PNG. */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return c ^ -1;
}

writeFileSync('src-tauri/icons/icon.png', encodePng(SIZE, SIZE, pixels));
console.log(`-> src-tauri/icons/icon.png (${SIZE}x${SIZE})`);
