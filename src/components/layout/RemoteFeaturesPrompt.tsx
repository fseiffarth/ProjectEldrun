import { useEffect, useState } from "react";
import { Toggle } from "../common/Toggle";
import { useSettingsStore } from "../../stores/settings";

/**
 * First-run ask for the two machine-wide remote surfaces that live in the
 * header — OpenVPN tunnel control and the global SSH machines list. Both
 * default OFF (most projects are local-only), so this is what lets someone
 * who *does* use them opt in once instead of discovering the toggles buried
 * in Settings. Shown once (`Settings.remote_features_prompted`, marked seen
 * by the caller before this ever mounts); re-toggleable any time from
 * Settings' main panel. Reuses the `.modal-backdrop` + `.settings-dialog`
 * chrome, like `HowToStart`.
 */
export function RemoteFeaturesPrompt({ onClose }: { onClose: () => void }) {
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [vpn, setVpn] = useState(false);
  const [machines, setMachines] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = () => {
    void updateSettings({ vpn_enabled: vpn, machines_enabled: machines });
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={finish}>
      <div
        className="settings-dialog remote-features-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Remote features"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>Using VPN or remote machines?</h2>
          <button type="button" className="dialog-close-btn" onClick={finish}>×</button>
        </div>
        <p className="settings-help">
          Eldrun can control an OpenVPN tunnel and connect to SSH machines you
          don't have a project on, both from the header. Both are off by default
          — turn on whichever you'll use. Either can be flipped any time from
          Settings.
        </p>

        <div className="settings-toggle-card">
          <label className="settings-toggle-card-row">
            <span>OpenVPN tunnel control</span>
            <Toggle checked={vpn} onChange={(e) => setVpn(e.target.checked)} />
          </label>
          <label className="settings-toggle-card-row">
            <span>Global remote machines</span>
            <Toggle checked={machines} onChange={(e) => setMachines(e.target.checked)} />
          </label>
        </div>

        <div className="settings-link-row">
          <button type="button" className="how-to-start-got-it" onClick={finish}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
