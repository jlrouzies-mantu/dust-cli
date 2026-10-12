// Regenerates the app icon from the CLI's D U S T block logo.
//
//   node scripts/gen-icons.mjs
//
// Writes build/icon.ico (16-256 px, PNG-compressed entries), build/icon.png
// (512 px) and renderer/public-free copies are not needed: the sidebar logo is
// real text (src/renderer/Logo.tsx), drawn from the same table below.
//
// The pixel layout is the logo's own: each terminal cell is one pixel wide and
// two pixels tall, so a half block lights the top or bottom pixel of its cell
// and a full block lights both. That makes the logo 7 x 8 pixels, scaled by
// whole numbers only, so it is crisp at every size.
//
// Source of truth for glyphs and colours: src/ui/components/Conversation.tsx
// (welcome_header) and src/utils/brand.ts. If the CLI logo changes, change
// ROWS / the two colours here and in src/renderer/Logo.tsx, then re-run.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(here, "..", "build");

const MANTU_PURPLE = [0xb3, 0x66, 0xff]; // brand.ts
const MANTU_GOLD = [0xd4, 0xa7, 0x2c]; // brand.ts
const GROUND = [0x16, 0x16, 0x16];

// Ink's dimColor is the terminal's "faint" attribute: roughly half intensity.
const DIM = 0.5;
const mix = (c, t) => c.map((v, i) => Math.round(v + (GROUND[i] - v) * t));

// [text, dim] runs per row, exactly as the CLI prints them.
const ROWS = [
  [["█", true, "p"], ["▀▄ ", false, "p"], ["█ █", true, "p"]],
  [["█", true, "p"], ["▄▀ ", false, "p"], ["█▄█", false, "p"]],
  [["█▀▀ ", true, "g"], ["▀█▀", true, "g"]],
  [["▄██ ", false, "g"], [" █ ", true, "g"]],
];

// 7 columns x 8 pixel rows of RGB or null.
function pixels() {
  const grid = Array.from({ length: 8 }, () => Array(7).fill(null));
  ROWS.forEach((runs, row) => {
    let col = 0;
    for (const [text, dim, hue] of runs) {
      const base = hue === "p" ? MANTU_PURPLE : MANTU_GOLD;
      const color = dim ? mix(base, DIM) : base;
      for (const ch of text) {
        if (ch === "█" || ch === "▀") grid[row * 2][col] = color;
        if (ch === "█" || ch === "▄") grid[row * 2 + 1][col] = color;
        col++;
      }
    }
  });
  return grid;
}

function render(size) {
  const grid = pixels();
  const scale = Math.max(1, Math.floor((size * 0.74) / 8));
  const w = 7 * scale;
  const h = 8 * scale;
  const ox = Math.floor((size - w) / 2);
  const oy = Math.floor((size - h) / 2);
  const radius = size * 0.2;
  const rgba = new Uint8Array(size * size * 4);

  // Coverage of the rounded square by 4x4 subsampling (anti-aliased corners).
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++)
          if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++;
      const coverage = hit / 16;

      let color = GROUND;
      const gx = Math.floor((x - ox) / scale);
      const gy = Math.floor((y - oy) / scale);
      if (x >= ox && y >= oy && gx < 7 && gy < 8 && grid[gy][gx]) {
        color = grid[gy][gx];
      }
      const i = (y * size + x) * 4;
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = Math.round(coverage * 255);
    }
  }
  return rgba;
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const images = sizes.map((s) => png(s, render(s)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const e = i * 16;
    dir[e] = s >= 256 ? 0 : s;
    dir[e + 1] = s >= 256 ? 0 : s;
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(images[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, dir, ...images]);
}

mkdirSync(buildDir, { recursive: true });
writeFileSync(path.join(buildDir, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256]));
writeFileSync(path.join(buildDir, "icon.png"), png(512, render(512)));
console.log("wrote build/icon.ico (16-256) and build/icon.png (512)");
