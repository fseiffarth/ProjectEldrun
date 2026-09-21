import { useState } from "react";
import { useRootReviewStore, type RootProposal, type ReviewRow } from "../../stores/rootReview";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useMailStore } from "../../stores/mail";
import { inspectIcs } from "../../lib/calendar/icsSafety";
import { IcsReportBody } from "../calendar/IcsImportReviewDialog";

/** Strip bidi overrides, zero-width controls and default-ignorable text. Keep
 * normal line breaks; rendering is always React text, never HTML/Markdown. */
export function stripInvisible(text: string): string {
  return [...text].filter((char) => {
    const cp = char.codePointAt(0)!;
    return !/\p{Default_Ignorable_Code_Point}/u.test(char)
      && !(cp < 32 && cp !== 9 && cp !== 10 && cp !== 13)
      && !(cp >= 127 && cp <= 159);
  }).join("");
}
function display(value: unknown): string {
  return stripInvisible(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "—");
}
export function reviewRows(proposal: RootProposal) {
  const folded = proposal.tool === "todo_move"
    ? proposal.rows.filter((r) => r.kind === "task" && r.local && r.post.id !== proposal.args.id
      && r.pre && Object.keys({ ...r.pre, ...r.post }).every((key) =>
        ["column", "rank"].includes(key) || JSON.stringify(r.pre?.[key]) === JSON.stringify(r.post[key])))
    : [];
  return { rows: proposal.rows.filter((r) => !folded.includes(r)), folded: folded.length };
}
function RowDiff({ row }: { row: ReviewRow }) {
  const t = useT();
  const keys = Object.keys({ ...row.pre, ...row.post }).filter((key) =>
    !row.pre || row.op === "delete" || JSON.stringify(row.pre[key]) !== JSON.stringify(row.post[key]));
  const title = display(row.post.title ?? row.post.name ?? row.post.id);
  return <div className="root-review-row">
    <div className="root-review-row-head">
      <strong className="settings-list-label" title={title}>{title}</strong>
      <span className="ollama-badge root-review-op">
        {t(row.op === "delete" ? "rootReview.delete" : row.pre ? "rootReview.update" : "rootReview.create")}
      </span>
    </div>
    <table>
      <thead><tr><th>{t("rootReview.field")}</th><th>{t("rootReview.before")}</th><th>{t("rootReview.after")}</th></tr></thead>
      <tbody>{keys.map((key) => <tr key={key}>
        <th>{stripInvisible(key)}</th>
        <td className="root-review-before"><pre>{display(row.pre?.[key])}</pre></td>
        <td className="root-review-after"><pre>{row.op === "delete" ? "—" : display(row.post[key])}</pre></td>
      </tr>)}</tbody>
    </table>
  </div>;
}
/**
 * The proposals themselves. It used to sit under the console's title bar as a
 * permanent strip, taking a slice of the terminals' height to say "(0)" most of
 * the time; it is now the body of the panel the ✓ Approvals button drops
 * (`RootOverlay`), which is why it keeps its own heading and empty line — a
 * panel that opens on nothing must still say so.
 *
 * It is built out of what Eldrun already uses for a list of objects, and adds
 * no surface of its own: the menu family's pinned accent title over a
 * `.menu-scroll-region` (the VPN/machines menus' shape), and inside it the
 * settings design system's object list — a `.settings-list` of
 * `.settings-card`s with `.settings-btn` actions and an `.ollama-badge` chip
 * for the status. Only the proposal's own parts (the diff table, the ✓/✗
 * glyphs) are drawn here.
 */
export function RootReviewStrip({ advisory = false }: { advisory?: boolean }) {
  const t = useT();
  const { proposals, imports, count, error, busy, decide, applyAll, importStaged, discardStaged } = useRootReviewStore();
  const pending = proposals.filter((p) => p.status === "pending");
  const drafts = useMailStore((s) => s.agentDrafts);
  const isOpen = (p: RootProposal) => p.status === "pending" || p.status === "conflicted";
  const open = proposals.filter(isOpen).sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  const decided = proposals.filter((p) => !isOpen(p));
  // Settled cards are history: folded shut until asked for, so the ones that
  // still want a ✓/✗ are what the panel opens on.
  const [showDecided, setShowDecided] = useState(false);
  return <section className="root-review-strip" aria-label={t("rootReview.title")}>
    <div className="tab-new-menu-group-label root-review-heading">
      <span className="root-review-heading-title">{t("rootReview.title")} ({count})</span>
      <UntestedTag id="rootReview.title" />
      {count > 0 && <button type="button" className="settings-btn sm primary" disabled={busy}
        onClick={() => void applyAll(pending)}>
        ✓ {t("rootReview.approveAll", { count })}
      </button>}
    </div>
    <div className="menu-scroll-region root-review-scroll">
      {proposals.length === 0 && drafts.length === 0 && imports.length === 0
        && <p className="settings-empty root-review-empty">{t("rootReview.empty")}</p>}
      {advisory && <p role="note" className="root-review-notice">{t("rootConsole.reviewAdvisory")}</p>}
      {error && <p role="alert" className="settings-error">{stripInvisible(error)}</p>}
      {/* A draft is not a proposal and has no Approve: the row opens the
          composer, whose Send is bound to exactly what it shows. */}
      {drafts.length > 0 && <div className="settings-list root-review-cards">
        {drafts.map((draft) => <article key={draft.id} className="settings-card root-review-card">
          <div className="root-review-card-head">
            <span className="settings-list-label" title={stripInvisible(draft.subject)}>
              {stripInvisible(draft.subject) || t("mail.noSubject")}
            </span>
            <span className="ollama-badge root-review-status">{t("rootReview.draft")}</span>
          </div>
          <p className="settings-help">{t(draft.origin === "reader" ? "mail.agentDraftReaderBanner" : "mail.agentDraftBanner")}</p>
          <div className="root-review-actions">
            <button type="button" className="settings-btn sm"
              onClick={() => void useMailStore.getState().openAgentDraft(draft)}>
              {t("rootReview.openDraft")}
            </button>
          </div>
        </article>)}
      </div>}
      {/* Nor is a staged `.ics`: the agent only put the file here. The report is
          this window's own reading of it, and ✓ runs the calendar's importer on
          exactly the text reported on — never part of "Approve all". */}
      {imports.length > 0 && <div className="settings-list root-review-cards">
        {imports.map((staged) => {
          const report = inspectIcs(staged.text);
          const name = stripInvisible(staged.name) || t("calendarPane.importedCalendarName");
          return <article key={staged.id} className="settings-card root-review-card">
            <div className="root-review-card-head">
              <span className="settings-list-label" title={name}>{name}</span>
              <UntestedTag id="rootReview.icsImport" />
              <span className="ollama-badge root-review-status">{t("rootReview.icsImport")}</span>
            </div>
            <div className="settings-help root-review-meta">
              {stripInvisible(staged.tab)} · {new Date(Number(staged.created)).toLocaleString()}
            </div>
            <p className="settings-help">{t("rootReview.icsImportHelp", { name })}</p>
            <IcsReportBody report={report} />
            <div className="root-review-actions">
              <button className="root-review-btn approve" disabled={busy || !report.looksLikeIcs}
                title={t("icsReview.import")} aria-label={t("icsReview.import")}
                onClick={() => void importStaged(staged, t("calendarPane.importedCalendarName"))}>✓</button>
              <button className="root-review-btn reject" disabled={busy}
                title={t("rootReview.discard")} aria-label={t("rootReview.discard")}
                onClick={() => void discardStaged(staged)}>✗</button>
            </div>
          </article>;
        })}
      </div>}
      {/* Two groups, each under its own label: what still wants a decision
          first, what is already decided after a rule — so the ✓/✗ cards never
          blur into the settled ones. */}
      {[
        { key: "open", label: t("rootReview.needsDecision", { count: open.length }), items: open },
        { key: "decided", label: t("rootReview.decided", { count: decided.length }), items: decided },
      ].filter((group) => group.items.length > 0).map((group) => <div key={group.key}
        className={`root-review-group ${group.key}`}>
        {group.key === "decided"
          ? <button type="button" className="root-review-group-label root-review-group-toggle"
              aria-expanded={showDecided} onClick={() => setShowDecided((o) => !o)}>
              <span className="root-review-group-chevron" aria-hidden="true">›</span>
              {group.label}
            </button>
          : <div className="root-review-group-label">{group.label}</div>}
        {(group.key !== "decided" || showDecided) && <div className="settings-list root-review-cards">
        {group.items.map((proposal) => {
          const { rows, folded } = reviewRows(proposal);
          const known = ["pending", "applied", "rejected", "conflicted", "undone"].includes(proposal.status);
          const status = known ? t(`rootReview.${proposal.status}` as "rootReview.pending") : stripInvisible(proposal.status);
          return <article key={proposal.id} className="settings-card root-review-card">
            <div className="root-review-card-head">
              <span className="settings-list-label root-review-tool" title={stripInvisible(proposal.tool)}>
                {stripInvisible(proposal.tool)}
              </span>
              <span className={`ollama-badge root-review-status${known ? ` ${proposal.status}` : ""}`}>{status}</span>
            </div>
            <div className="settings-help root-review-meta">
              {stripInvisible(proposal.tab)} · {new Date(Number(proposal.created)).toLocaleString()}
            </div>
            {proposal.mcp_access && proposal.mcp_caller && <p className="settings-help">{t("mcpSecurity.reviewScope", {
              calendars: proposal.mcp_access.calendars.all ? t("mcpSecurity.allScopes") : proposal.mcp_access.calendars.ids.length,
              projects: proposal.mcp_access.projects.all ? t("mcpSecurity.allScopes") : proposal.mcp_access.projects.ids.length,
              caller: t(`mcpSecurity.${proposal.mcp_caller}`),
            })}</p>}
            {proposal.closed && <p className="settings-help">{t("rootReview.closed")}</p>}
            {proposal.tainted && <p className="root-review-notice">{t("rootReview.tainted")}</p>}
            {proposal.calendars.filter((c) => c.caldav_account_id).map((c) =>
              <p key={String(c.id)} className="root-review-notice">{t("rootReview.outbound", { name: display(c.name) })}</p>)}
            {proposal.status === "conflicted" && <p className="root-review-notice">{t("rootReview.conflict")}</p>}
            {/* Every pending card's actual rows stay visible, including in the
                bulk-approval view. No agent summary substitutes for these. */}
            {proposal.status === "pending" || proposal.status === "conflicted"
              ? rows.map((row, index) => <RowDiff key={index} row={row} />)
              : <details className="root-review-fold">
                  <summary>{t("rootReview.details")}</summary>
                  {rows.map((row, index) => <RowDiff key={index} row={row} />)}
                </details>}
            {folded > 0 && <p className="settings-help">{t("rootReview.reordered", { count: folded })}</p>}
            {/* A decision is one glyph: ✓ approve, ✗ reject (a conflict's ✗ is a
                discard, and says so). The word stays as the button's name, so a
                screen reader and a tooltip still read "Approve", never "check". */}
            <div className="root-review-actions">
              {(proposal.status === "pending" || proposal.status === "conflicted") && <>
                <button className="root-review-btn approve" disabled={busy || proposal.status !== "pending"}
                  title={t("rootReview.approve")} aria-label={t("rootReview.approve")}
                  onClick={() => void decide(proposal, "apply")}>✓</button>
                <button className="root-review-btn reject" disabled={busy}
                  title={t(proposal.status === "conflicted" ? "rootReview.discard" : "rootReview.reject")}
                  aria-label={t(proposal.status === "conflicted" ? "rootReview.discard" : "rootReview.reject")}
                  onClick={() => void decide(proposal, "reject")}>✗</button>
              </>}
              {proposal.status === "applied" && proposal.undo && <button className="root-review-btn undo" disabled={busy}
                title={t("rootReview.undo")} aria-label={t("rootReview.undo")}
                onClick={() => void decide(proposal, "undo")}>↩</button>}
            </div>
          </article>;
        })}
        </div>}
      </div>)}
    </div>
  </section>;
}
