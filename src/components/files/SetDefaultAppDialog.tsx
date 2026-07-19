import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface InstalledApp {
  name: string;
  exec: string;
  icon: string | null;
}

type Scope = "project" | "global";
type ProjectJson = Record<string, unknown>;

interface Props {
  /** File extension including the leading dot, e.g. ".blend". */
  ext: string;
  /** File name, for the dialog heading. */
  fileName: string;
  /** Path to the project's project.json; null disables the project scope. */
  localFile: string | null;
  onClose: () => void;
}

/**
 * Whether an installed-app row corresponds to the current exec: true when the
 * exec is exactly the app's command, or that command followed by extra args — a
 * multi-word invocation such as a sharun AppImage's binary selector
 * (`/opt/…AppImage kicad <file>`) or a Flatpak launcher line. Keeps such a
 * working exec highlighted, and lets a re-select preserve its trailing args
 * instead of stripping them back to the bare `.desktop` value.
 */
export function execMatchesApp(exec: string, appExec: string): boolean {
  const e = exec.trim().split(/\s+/).filter(Boolean);
  const a = appExec.trim().split(/\s+/).filter(Boolean);
  if (a.length === 0 || a.length > e.length) return false;
  return a.every((token, i) => token === e[i]);
}

function readDefaultApps(project: ProjectJson | null): Record<string, string> {
  const raw = project?.default_apps;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Assign the default app for a file extension, scoped to this project or set
 * globally. A project-scoped mapping overrides the global one for that project
 * (matching the backend's resolution precedence). The search box lists installed
 * applications (parsed from .desktop entries); a manual exec field and a native
 * file picker cover apps not on the list.
 */
export function SetDefaultAppDialog({ ext, fileName, localFile, onClose }: Props) {
  const [scope, setScope] = useState<Scope>(localFile ? "project" : "global");
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [iconDataUrls, setIconDataUrls] = useState<Record<string, string | null>>({});
  const [query, setQuery] = useState("");
  const [exec, setExec] = useState("");
  const [globalApps, setGlobalApps] = useState<Record<string, string>>({});
  const [projectApps, setProjectApps] = useState<Record<string, string>>({});
  const [projectJson, setProjectJson] = useState<ProjectJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Once the user picks a scope radio themselves, stop auto-selecting it.
  const userPickedScope = useRef(false);

  useEffect(() => {
    invoke<InstalledApp[]>("list_installed_apps")
      .then(setApps)
      .catch((e) => setError(String(e)));
    invoke<Record<string, string>>("get_default_apps")
      .then(setGlobalApps)
      .catch(() => setGlobalApps({}));
    if (localFile) {
      invoke<ProjectJson>("load_project", { localFile })
        .then((p) => {
          setProjectJson(p);
          setProjectApps(readDefaultApps(p));
        })
        .catch(() => {
          setProjectJson(null);
          setProjectApps({});
        });
    }
  }, [localFile]);

  // Open in whichever scope already maps this extension, so reopening the dialog
  // surfaces the saved value instead of an empty project-scope field (a mapping
  // saved Global would otherwise be invisible while the default scope is
  // "project"). Project wins over global, matching the resolution precedence.
  // Deferred to the maps loading, and disabled once the user picks a scope.
  useEffect(() => {
    if (userPickedScope.current) return;
    if (localFile && projectApps[ext]) setScope("project");
    else if (globalApps[ext]) setScope("global");
  }, [ext, localFile, projectApps, globalApps]);

  // Seed the exec field with whatever the chosen scope currently maps this
  // extension to, so the dialog opens showing the present value.
  useEffect(() => {
    const current = scope === "project" ? projectApps[ext] : globalApps[ext];
    setExec(current ?? "");
  }, [scope, ext, projectApps, globalApps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (a) => a.name.toLowerCase().includes(q) || a.exec.toLowerCase().includes(q),
    );
  }, [apps, query]);

  // Resolve icons lazily for the apps currently shown. The backend caches per
  // exec, so re-filtering as the user types only resolves newly-revealed apps.
  // Works on both platforms: on Windows `list_installed_apps` returns icon=null
  // and the resolver extracts the shell icon; on Linux it resolves the theme name.
  useEffect(() => {
    let cancelled = false;
    const execs = filtered
      .map((a) => a.exec)
      .filter((exec) => exec && !(exec in iconDataUrls));
    if (execs.length === 0) return;
    Promise.all(
      [...new Set(execs)].map(async (exec) => {
        try {
          return [exec, await invoke<string | null>("resolve_app_icon", { exec })] as const;
        } catch {
          return [exec, null] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setIconDataUrls((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [filtered, iconDataUrls]);

  const otherScopeValue = scope === "project" ? globalApps[ext] : undefined;

  const chooseExecutable = async () => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") setExec(picked);
  };

  // Select an installed app. Preserve a working multi-word exec when the user
  // re-selects the same app it already resolves to — clicking KiCad must not
  // strip the `kicad` binary selector its sharun AppImage needs to open a file.
  const pickApp = (appExec: string) => {
    setExec((prev) => (execMatchesApp(prev, appExec) ? prev : appExec));
  };

  const save = async (nextExec: string | null) => {
    setBusy(true);
    setError(null);
    try {
      if (scope === "global") {
        const next = { ...globalApps };
        if (nextExec) next[ext] = nextExec;
        else delete next[ext];
        await invoke("save_default_apps", { defaultApps: next });
      } else {
        if (!localFile) throw new Error("No project file for project scope");
        const base = projectJson ?? (await invoke<ProjectJson>("load_project", { localFile }));
        const map = { ...readDefaultApps(base) };
        if (nextExec) map[ext] = nextExec;
        else delete map[ext];
        await invoke("save_project", { localFile, project: { ...base, default_apps: map } });
      }
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog set-default-app-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>Default app for {ext} files</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          Opening <strong>{fileName}</strong> (and other <code>{ext}</code> files) will use this app.
        </p>

        <div className="set-default-app-scope">
          <label className={localFile ? "" : "disabled"} title={localFile ? "" : "No project selected"}>
            <input
              type="radio"
              name="default-app-scope"
              checked={scope === "project"}
              disabled={!localFile}
              onChange={() => {
                userPickedScope.current = true;
                setScope("project");
              }}
            />
            This project only
          </label>
          <label>
            <input
              type="radio"
              name="default-app-scope"
              checked={scope === "global"}
              onChange={() => {
                userPickedScope.current = true;
                setScope("global");
              }}
            />
            Global (all projects)
          </label>
        </div>
        {scope === "project" && otherScopeValue && (
          <p className="settings-help">
            Overrides the global default (<code>{otherScopeValue}</code>) for this project.
          </p>
        )}

        <input
          className="set-default-app-search"
          placeholder="Search installed apps…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className="set-default-app-list">
          {filtered.length === 0 ? (
            <div className="settings-empty">No matching apps.</div>
          ) : (
            filtered.map((a) => (
              <button
                type="button"
                key={`${a.exec}:${a.name}`}
                className={`set-default-app-row${execMatchesApp(exec, a.exec) ? " selected" : ""}`}
                onClick={() => pickApp(a.exec)}
                title={a.exec}
              >
                {iconDataUrls[a.exec] ? (
                  <img className="set-default-app-icon" src={iconDataUrls[a.exec]!} alt="" />
                ) : (
                  <span className="set-default-app-icon set-default-app-icon-placeholder" />
                )}
                <span className="set-default-app-text">
                  <span className="set-default-app-name">{a.name}</span>
                  <span className="set-default-app-exec">{a.exec}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="set-default-app-manual">
          <input
            value={exec}
            placeholder="executable or path"
            onChange={(e) => setExec(e.target.value)}
          />
          <button type="button" onClick={() => void chooseExecutable()} title="Browse for executable">
            …
          </button>
        </div>

        {error && <div className="settings-error">{error}</div>}

        <div className="set-default-app-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="danger"
            disabled={busy || !(scope === "project" ? projectApps[ext] : globalApps[ext])}
            onClick={() => void save(null)}
            title="Remove this mapping"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={busy || !exec.trim()}
            onClick={() => void save(exec.trim())}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
