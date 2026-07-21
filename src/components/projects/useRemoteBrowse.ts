import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { joinRemotePath, type ParsedSshAddress } from "./scaffold";
import { resolveRemoteStartDir } from "../../lib/remoteConnect";
import type { RemoteEntry } from "../../types";

/**
 * The shared "log in to a host and browse its filesystem over SFTP" state
 * machine — the ONE implementation of *how* a remote connect + folder browse
 * works, so the primary machine and further (worker) machines never carry two
 * copies of it. Used by the new/extend-project flow (`useRemoteSession`) and the
 * add-worker-machine flow (`RemoteMachinesWindow`); each dialog keeps its own
 * field layout ("the content"), this owns the mechanism ("the way to log in").
 *
 * A live session is a FROZEN `(conn, password)` pair: once `connect`/`openSession`
 * commits it, edits to the dialog's address/password fields don't silently change
 * which host the listing talks to — the caller must `reset` and reconnect. The
 * listing refreshes automatically whenever the browse path (or the frozen
 * connection) changes, always reusing the credential the connection was made with.
 */
export function useRemoteBrowse() {
  // The connected host, frozen at connect time (null = no live session).
  const [conn, setConn] = useState<ParsedSshAddress | null>(null);
  // The credential the session authenticated with, frozen so every listing/mkdir
  // reuses it. "" → null → rides the ControlMaster / key auth.
  const [password, setPassword] = useState("");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Refresh the listing whenever the browse path (or the frozen connection)
  // changes. `password` is a dep so a re-`openSession` with a new credential
  // re-lists, but callers freeze it at connect time so ordinary keystrokes don't.
  useEffect(() => {
    if (!conn) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError("");
    invoke<RemoteEntry[]>("ssh_list_dir", {
      user: conn.user,
      host: conn.host,
      port: conn.port,
      password: password ? password : null,
      path,
    })
      .then((e) => {
        if (!cancelled) setEntries(e);
      })
      .catch((e) => {
        if (cancelled) return;
        setEntries([]);
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conn, password, path]);

  // Freeze a session that some OTHER path already authenticated (e.g. a
  // non-headless login terminal's ControlMaster) — no ssh_connect here. Sets
  // `conn` last so the listing effect fires once with password + path ready.
  const openSession = (target: ParsedSshAddress, sessionPassword: string, startPath: string) => {
    setPassword(sessionPassword);
    setPath(startPath || "");
    setConn(target);
  };

  // Authenticate `target`, then open its start dir. `remember` persists the
  // working password to the OS keychain (keyed by host target); null/undefined
  // leaves the keychain untouched. `startPath` overrides where the browse opens
  // (e.g. the add-machine flow starts at the primary's project path *on the new
  // machine*, not that host's home); blank/omitted falls back to the configured
  // default / SSH home. Throws on auth failure — the caller owns the
  // connecting/error UI. On success the listing opens automatically.
  const connect = async (opts: {
    target: ParsedSshAddress;
    password: string | null;
    remember?: boolean | null;
    startPath?: string | null;
  }) => {
    const pw = opts.password ? opts.password : null;
    await invoke<void>("ssh_connect", {
      user: opts.target.user,
      host: opts.target.host,
      port: opts.target.port,
      password: pw,
      remember: opts.remember ?? null,
    });
    const startDir =
      opts.startPath && opts.startPath.trim()
        ? opts.startPath.trim()
        : await resolveRemoteStartDir(
            opts.target.user,
            opts.target.host,
            opts.target.port,
            pw,
          );
    openSession(opts.target, opts.password ?? "", startDir);
  };

  const enter = (entry: RemoteEntry) => {
    if (entry.is_dir) setPath(joinRemotePath(path, entry.name));
  };

  // Jump straight to a previously-used path (a recents-dropdown pick) instead of
  // navigating there entry by entry.
  const jump = (p: string) => setPath(p);

  const goUp = () => {
    const p = path.replace(/\/+$/, "");
    if (!p || p === "/") {
      setPath("/");
      return;
    }
    const idx = p.lastIndexOf("/");
    setPath(idx <= 0 ? "/" : p.slice(0, idx));
  };

  // Create a child folder under the current path, then descend into it (the
  // listing refreshes off the path). No-op without a live session.
  const mkdir = async (rawName: string) => {
    const name = rawName.trim();
    if (!name || !conn) return;
    // A single child of the current dir, not an arbitrary deep path.
    if (name.includes("/")) {
      setError("Folder name can't contain '/'.");
      return;
    }
    const target = joinRemotePath(path || "/", name);
    setBusy(true);
    setError("");
    try {
      await invoke("ssh_mkdir", {
        user: conn.user,
        host: conn.host,
        port: conn.port,
        password: password ? password : null,
        path: target,
      });
      setPath(target);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  // Drop back to the disconnected state (a credential edit, an explicit
  // "Change…", or a torn-down login).
  const reset = () => {
    setConn(null);
    setPassword("");
    setEntries([]);
    setPath("");
    setError("");
  };

  return {
    conn,
    password,
    path,
    setPath,
    entries,
    busy,
    error,
    setError,
    connect,
    openSession,
    enter,
    jump,
    goUp,
    mkdir,
    reset,
  };
}
