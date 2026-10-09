// Synthesizes the notification sounds (no third-party audio, so no licence
// questions): short mono 16-bit PCM WAVs written to src/renderer/sounds/.
//
//   node scripts/gen-sounds.mjs      (or: npm run sounds)
//
// Each tone is a sum of sine partials with an exponential decay and a 6 ms
// attack ramp, so there is no click. Peak level is kept at about -6 dBFS: the
// volume slider in Settings only ever turns them down.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "src", "renderer", "sounds");
const RATE = 22050;

/** notes: [startSec, freqHz, durSec, decayPerSec, partials[]] */
function render(notes, totalSec) {
  const n = Math.ceil(totalSec * RATE);
  const buf = new Float32Array(n);
  for (const [start, freq, dur, decay, partials] of notes) {
    const from = Math.floor(start * RATE);
    const len = Math.floor(dur * RATE);
    for (let i = 0; i < len && from + i < n; i++) {
      const t = i / RATE;
      const attack = Math.min(1, t / 0.006);
      const release = Math.min(1, (len - i) / (RATE * 0.02));
      const env = attack * release * Math.exp(-decay * t);
      let v = 0;
      partials.forEach((amp, k) => {
        v += amp * Math.sin(2 * Math.PI * freq * (k + 1) * t);
      });
      buf[from + i] += v * env;
    }
  }
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? 0.5 / peak : 1;
  const pcm = Buffer.alloc(n * 2);
  buf.forEach((v, i) => pcm.writeInt16LE(Math.round(v * gain * 32767), i * 2));
  return pcm;
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const bell = [1, 0.35, 0.12];
const pure = [1];
const SOUNDS = {
  // A single warm bell, the default for "finished".
  chime: render([[0, 784, 0.9, 5, bell]], 0.9),
  // A short, soft sine blip.
  ping: render([[0, 988, 0.28, 11, pure]], 0.3),
  // Two ascending notes.
  "two-tone": render(
    [
      [0, 659.25, 0.22, 9, pure],
      [0.16, 880, 0.4, 7, pure],
    ],
    0.6
  ),
  // The "Mantu" signature: a rising E - G# - B - E arpeggio.
  mantu: render(
    [
      [0, 659.25, 0.5, 6, bell],
      [0.11, 830.61, 0.5, 6, bell],
      [0.22, 987.77, 0.5, 6, bell],
      [0.33, 1318.5, 0.8, 5, bell],
    ],
    1.15
  ),
};

mkdirSync(outDir, { recursive: true });
for (const [name, pcm] of Object.entries(SOUNDS)) {
  const file = path.join(outDir, `${name}.wav`);
  writeFileSync(file, wav(pcm));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${pcm.length + 44} bytes)`);
}
