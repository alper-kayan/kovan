// Draws the app's icons from Kovan's mark (six hexagon outlines around a filled one, the same
// geometry as the logo SVG in a -1 -1 34 34 box) in the site's colours: ink and honey.
//   node scripts/icons.mjs        → assets/*.png
// No image libraries: shapes are tested per pixel (4×4 samples for smooth edges) and written as
// PNG with zlib.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const out = new URL('../assets/', import.meta.url);
const INK = [7, 8, 15];
const HONEY = [255, 201, 74];
const HONEY_DEEP = [255, 122, 47];

const hex = (cx, cy, r) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
const ring = [
  [25.27, 21.35],
  [16, 26.7],
  [6.73, 21.35],
  [6.73, 10.65],
  [16, 5.3],
  [25.27, 10.65],
].map(([x, y]) => hex(x, y, 4.5));
const core = hex(16, 16, 3.25);

const segDist = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const inside = (px, py, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
/** Whether a point (in mark units) is ink: a stroke of the ring or the filled core. */
const onMark = (x, y, stroke) =>
  inside(x, y, core) ||
  ring.some((p) => p.some((a, i) => segDist(x, y, a, p[(i + 1) % 6]) <= stroke / 2));

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/**
 * One square PNG: a background (a colour pair for a diagonal gradient, or null for transparent)
 * and the mark, `scale` of the width, in a colour or a vertical gradient.
 */
function draw(file, { size, background, mark, scale, stroke = 2.1 }) {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const markPx = size * scale;
  const origin = (size - markPx) / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let i = 0; i < ss; i++)
        for (let j = 0; j < ss; j++) {
          const mx = -1 + ((x + (i + 0.5) / ss - origin) / markPx) * 34;
          const my = -1 + ((y + (j + 0.5) / ss - origin) / markPx) * 34;
          if (mx > -1 && mx < 33 && my > -1 && my < 33 && onMark(mx, my, stroke)) hit++;
        }
      const cover = hit / (ss * ss);
      const markColour = Array.isArray(mark[0])
        ? mix(mark[0], mark[1], Math.min(1, Math.max(0, (y - origin) / markPx)))
        : mark;
      let rgb;
      let alpha;
      if (background) {
        const bg = Array.isArray(background[0])
          ? mix(background[0], background[1], (x + y) / (2 * size))
          : background;
        rgb = mix(bg, markColour, cover);
        alpha = 255;
      } else {
        rgb = markColour;
        alpha = Math.round(cover * 255);
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
      raw[o + 3] = alpha;
    }
  }
  // Icons on a background are written without an alpha channel: the App Store refuses one.
  writeFileSync(new URL(file, out), png(size, background ? opaque(size, raw) : raw, !background));
  console.log(file);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
/** RGBA rows (each led by a filter byte) as RGB rows. */
function opaque(size, raw) {
  const rgb = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    rgb[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const from = y * (size * 4 + 1) + 1 + x * 4;
      raw.copy(rgb, y * (size * 3 + 1) + 1 + x * 3, from, from + 3);
    }
  }
  return rgb;
}
function png(size, raw, alpha) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// iOS: full-bleed squares, the system rounds the corners.
draw('icon.png', { size: 1024, background: [HONEY, HONEY_DEEP], mark: INK, scale: 0.62 });
// Dark: the system draws its own dark backdrop under a transparent icon.
draw('icon-dark.png', { size: 1024, background: null, mark: [HONEY, HONEY_DEEP], scale: 0.62 });
// Tinted: grey levels the system colours in.
draw('icon-tinted.png', { size: 1024, background: null, mark: [236, 236, 236], scale: 0.62 });
// Android adaptive: the mark inside the 66% safe zone, over the honey background colour.
draw('adaptive-icon.png', { size: 1024, background: null, mark: INK, scale: 0.46 });
draw('adaptive-monochrome.png', {
  size: 1024,
  background: null,
  mark: [255, 255, 255],
  scale: 0.46,
});
// Splash: the mark alone on the app's dark background.
draw('splash-icon.png', { size: 512, background: null, mark: [HONEY, HONEY_DEEP], scale: 0.9 });
// Google Play's store listing: 512 px, square, no transparency (Play rounds the corners).
draw('../store/play-icon.png', {
  size: 512,
  background: [HONEY, HONEY_DEEP],
  mark: INK,
  scale: 0.62,
});
// Android notifications: white on transparent.
draw('notification-icon.png', {
  size: 96,
  background: null,
  mark: [255, 255, 255],
  scale: 0.92,
  stroke: 2.4,
});
