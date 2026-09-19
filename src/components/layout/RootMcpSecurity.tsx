import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useProjectsStore } from "../../stores/projects";
import { mailAccountsList } from "../../lib/mail";
import type { MailAccount } from "../../types/mail";
import { UntestedTag } from "../common/UntestedTag";
import { SettingsCard, SettingRow, ToggleRow } from "./settingsUi";
import { stripInvisible } from "./RootReviewStrip";

interface Scope { all: boolean; ids: string[] }
interface Access {
  calendars: Scope; projects: Scope; accounts: Scope;
  families: string[]; write: boolean;
}
interface Session { id: string; tab: string; caller: "agent" | "local_model" | "reader"; access: Access }
interface Audit { session: string; caller: Session["caller"]; tool: string; outcome: "allowed" | "denied" | "refused"; elapsed_ms: number; time: number }
interface Status { sessions: Session[]; audit: Audit[] }

function ScopeEditor({ label, scope, rows, disabled, change }: {
  label: string; scope: Scope; rows: { id: string; name: string }[]; disabled: boolean; change: (scope: Scope) => void;
}) {
  const t = useT();
  return <fieldset disabled={disabled}>
    <legend>{label}</legend>
    <ToggleRow label={t("mcpSecurity.all")} checked={scope.all}
      onChange={(e) => change({ ...scope, all: e.target.checked })} />
    {!scope.all && rows.map((row) => <ToggleRow key={row.id} label={stripInvisible(row.name)}
      checked={scope.ids.includes(row.id)} onChange={(e) => change({ all: false,
        ids: e.target.checked ? [...scope.ids, row.id] : scope.ids.filter((id) => id !== row.id),
      })} />)}
  </fieldset>;
}

function SessionCard({ session, update, busy, accounts }: { session: Session; update: (command: string, args: Record<string, unknown>) => Promise<void>; busy: boolean; accounts: MailAccount[] }) {
  const t = useT();
  const [access, setAccess] = useState(session.access);
  const calendars = useCalendarStore((s) => s.calendars);
  const projects = useProjectsStore((s) => s.projects);
  return <SettingsCard>
    <strong>{stripInvisible(session.tab)} · {t(`mcpSecurity.${session.caller}`)}</strong>
    <ToggleRow label={t("mcpSecurity.write")} checked={access.write} disabled={busy}
      onChange={(e) => setAccess({ ...access, write: e.target.checked })} />
    {(["calendar", "board", "projects", "mail"] as const).filter((f) => session.caller !== "reader" || f !== "projects").map((family) =>
      <ToggleRow key={family} label={t(`mcpSecurity.family.${family}`)} checked={access.families.includes(family)} disabled={busy}
        onChange={(e) => setAccess({ ...access, families: e.target.checked
          ? [...access.families, family] : access.families.filter((f) => f !== family) })} />)}
    <ScopeEditor label={t("mcpSecurity.calendars")} scope={access.calendars} rows={calendars} disabled={busy}
      change={(scope) => setAccess({ ...access, calendars: scope })} />
    <ScopeEditor label={t("mcpSecurity.projects")} scope={access.projects}
      rows={[{ id: "", name: t("mcpSecurity.unassigned") }, ...projects]} disabled={busy}
      change={(scope) => setAccess({ ...access, projects: scope })} />
    <ScopeEditor label={t("mcpSecurity.accounts")} scope={access.accounts}
      rows={accounts.map((a) => ({ id: a.id, name: a.label }))} disabled={busy}
      change={(scope) => setAccess({ ...access, accounts: scope })} />
    <div className="root-review-actions">
      <button className="settings-btn" disabled={busy} onClick={() => void update("root_mcp_session_access", { id: session.id, access })}>{t("common.save")}</button>
      <button className="settings-btn" disabled={busy} onClick={() => void update("root_mcp_session_revoke", { id: session.id })}>{t("mcpSecurity.revoke")}</button>
    </div>
  </SettingsCard>;
}

/** Mounted only while its settings fold is visible; no hidden-pane polling. */
export function RootMcpSecurity() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const refresh = async () => {
    try { setStatus(await invoke<Status>("root_mcp_security_status")); setError(null); }
    catch (e) { setError(String(e)); }
  };
  useEffect(() => {
    let alive = true;
    void invoke<Status>("root_mcp_security_status").then((s) => { if (alive) setStatus(s); }).catch((e) => { if (alive) setError(String(e)); });
    void useCalendarStore.getState().load().catch((e) => { if (alive) setError(String(e)); });
    // Read only the account catalog; do not select an account or open mail.
    void mailAccountsList().then((rows) => { if (alive) setAccounts(rows); }).catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, []);
  const update = async (command: string, args: Record<string, unknown>) => {
    setBusy(true);
    try { await invoke(command, args); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <>
    <SettingRow label={<>{t("mcpSecurity.title")} <UntestedTag /></>} help={t("mcpSecurity.help")}
      control={<button className="settings-btn" disabled={busy} onClick={() => void refresh()}>{t("mcpSecurity.refresh")}</button>} />
    {error && <SettingsCard><p role="alert">{stripInvisible(error)}</p></SettingsCard>}
    {status?.sessions.length === 0 && <SettingsCard>{t("mcpSecurity.empty")}</SettingsCard>}
    {status?.sessions.map((s) => <SessionCard key={`${s.id}:${JSON.stringify(s.access)}`} session={s} update={update} busy={busy} accounts={accounts} />)}
    {status && <SettingsCard>
      <strong>{t("mcpSecurity.audit")}</strong>
      <p className="settings-help">{t("mcpSecurity.auditHelp")}</p>
      <table><thead><tr><th>{t("mcpSecurity.time")}</th><th>{t("mcpSecurity.caller")}</th><th>{t("mcpSecurity.tool")}</th><th>{t("mcpSecurity.outcome")}</th></tr></thead>
        <tbody>{status.audit.slice(-50).reverse().map((a, i) => <tr key={i}>
          <td>{new Date(a.time * 1000).toLocaleTimeString()}</td>
          <td title={a.session}>{t(`mcpSecurity.${a.caller}`)} · {a.session.slice(0, 8)}</td>
          <td>{a.tool === "protocol" ? t("mcpSecurity.protocol") : stripInvisible(a.tool)}</td>
          <td>{t(`mcpSecurity.${a.outcome}`)}</td>
        </tr>)}</tbody>
      </table>
    </SettingsCard>}
  </>;
}
