import type { SoundId } from "../shared/sounds";
import chime from "./sounds/chime.wav?url";
import mantu from "./sounds/mantu.wav?url";
import ping from "./sounds/ping.wav?url";
import twoTone from "./sounds/two-tone.wav?url";

const URLS: Record<Exclude<SoundId, "none">, string> = {
  chime,
  ping,
  "two-tone": twoTone,
  mantu,
};

/**
 * Plays a notification tone from the page. An HTMLAudioElement keeps playing
 * while the window is hidden, minimised or unfocused (the window is created
 * with autoplayPolicy "no-user-gesture-required"); that is why main asks the
 * page to play instead of the toast carrying a sound. Resolves whether it
 * actually started.
 */
export async function playSound(id: SoundId, volume: number): Promise<boolean> {
  if (id === "none") return false;
  try {
    const audio = new Audio(URLS[id]);
    audio.volume = Math.min(1, Math.max(0, volume));
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

// Smoke hook: proves a tone starts with no user gesture while the window is hidden.
(globalThis as Record<string, unknown>).__dustmPlaySound = (id: SoundId, volume: number) =>
  playSound(id, volume);
