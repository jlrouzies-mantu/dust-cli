import type { NotifyChannel, NotifySettings } from "../shared/ipc";
import { SOUND_IDS, SOUND_LABELS } from "../shared/sounds";
import type { SoundId } from "../shared/sounds";
import { Modal } from "./Modal";
import { playSound } from "./sounds";
import { toast, useApp } from "./store";

const KINDS: { key: "finished" | "approval" | "error"; label: string; hint: string }[] = [
  { key: "finished", label: "Finished", hint: "A conversation you are not looking at completes a turn" },
  { key: "approval", label: "Needs approval", hint: "An edit, a tool or a plan is waiting for you" },
  { key: "error", label: "Error", hint: "A turn failed" },
];

/** Notification delivery: pop-up and/or sound per event, volume, preview. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { session } = useApp();
  const cfg = session?.notify;
  if (!cfg) return null;

  const save = async (patch: Partial<NotifySettings> | Record<string, unknown>) => {
    const res = await window.dustm.setNotify(patch as Partial<NotifySettings>);
    if (!res.ok) toast(res.error ?? "Could not save the setting.");
  };
  const setChannel = (kind: (typeof KINDS)[number]["key"], channel: Partial<NotifyChannel>) =>
    void save({ [kind]: channel });

  return (
    <Modal
      label="Settings"
      className="palette"
      top
      onEscape={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="pal-top" />
      <div style={{ padding: "14px 18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Settings</h2>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          Notify me about conversations I am not looking at
        </label>

        <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ width: 70 }}>Volume</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(cfg.volume * 100)}
            aria-label="Notification volume"
            onChange={(e) => void save({ volume: Number(e.target.value) / 100 })}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 38, textAlign: "right" }}>{Math.round(cfg.volume * 100)}%</span>
        </label>

        <div role="group" aria-label="Per event" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {KINDS.map(({ key, label, hint }) => {
            const ch = cfg[key];
            return (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4, opacity: cfg.enabled ? 1 : 0.5 }}>
                <div style={{ fontWeight: 600 }}>{label}</div>
                <div className="plain-note" style={{ margin: 0 }}>{hint}</div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={ch.popup}
                      disabled={!cfg.enabled}
                      onChange={(e) => setChannel(key, { popup: e.target.checked })}
                    />
                    Pop-up
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    Sound
                    <select
                      value={ch.sound}
                      disabled={!cfg.enabled}
                      aria-label={`${label} sound`}
                      onChange={(e) => setChannel(key, { sound: e.target.value as SoundId })}
                    >
                      {SOUND_IDS.map((id) => (
                        <option key={id} value={id}>{SOUND_LABELS[id]}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="small-btn"
                    disabled={ch.sound === "none"}
                    aria-label={`Preview the ${label} sound`}
                    onClick={() => void playSound(ch.sound, cfg.volume)}
                  >
                    Preview
                  </button>
                </div>
              </div>
            );
          })}
          <div className="plain-note" style={{ margin: 0 }}>
            Pop-up and sound both off turns that event off. Notifications never show for the conversation
            you are looking at while the window is focused.
          </div>
        </div>
      </div>
    </Modal>
  );
}
