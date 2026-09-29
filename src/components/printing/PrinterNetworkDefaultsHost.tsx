import { useEffect, useRef } from "react";
import { useSettingsStore } from "../../stores/settings";
import { saverInterval, useQuiesce } from "../../stores/power";
import { printSetDefault } from "../../lib/window/printing";
import {
  networkIdentity,
  networkKey,
  printerToApply,
} from "../../lib/window/printerNetworkDefaults";

/** How often the network is re-read. A network change is a laptop being
 *  carried somewhere; half a minute late is well before the first print. */
const POLL_MS = 30_000;

/**
 * Applies the per-network default printer (Print Manager → "Default on this
 * network"). Renders nothing.
 *
 * Mounted at the shell for `CalDavSyncHost`'s reason: the pane that saves a
 * per-network default is exactly what is closed when the laptop arrives at the
 * office. Main window only, so two windows never race the same `lpoptions`.
 *
 *  - **It costs nothing until a default is saved.** With none, no timer starts
 *    and the SSID probe (a process spawn) never runs.
 *  - **It acts on a change of network, launch included** — never per poll, so a
 *    default the user sets by hand holds until they next change networks.
 *  - **A failure is quiet.** A saved printer that has since been removed makes
 *    the print system refuse; that is logged, not surfaced as a dialog on every
 *    network change.
 */
export function PrinterNetworkDefaultsHost() {
  const defaults = useSettingsStore((s) => s.settings?.printer_network_defaults);
  const quiesce = useQuiesce();
  const lastKey = useRef<string | null | undefined>(undefined);
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const active = !!defaults && Object.keys(defaults).length > 0;

  useEffect(() => {
    if (!active) {
      lastKey.current = undefined;
      return;
    }
    let cancelled = false;
    let reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const key = networkKey(await networkIdentity());
        if (cancelled || key === lastKey.current) return;
        lastKey.current = key;
        const printer = printerToApply(defaultsRef.current, key);
        if (printer) {
          await printSetDefault(printer).catch((e) =>
            console.warn(`[printing] per-network default ${printer}:`, e),
          );
        }
      } finally {
        reading = false;
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), saverInterval(POLL_MS, quiesce));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, quiesce]);

  return null;
}
