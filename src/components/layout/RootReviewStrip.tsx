import { useRootReviewStore, type RootProposal, type ReviewRow } from "../../stores/rootReview";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useMailStore } from "../../stores/mail";

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
  return <div className="root-review-row">
    <strong>{display(row.post.title ?? row.post.name ?? row.post.id)}</strong>
    <span> · {t(row.op === "delete" ? "rootReview.delete" : row.pre ? "rootReview.update" : "rootReview.create")}</span>
    <table>
      <thead><tr><th>{t("rootReview.field")}</th><th>{t("rootReview.before")}</th><th>{t("rootReview.after")}</th></tr></thead>
      <tbody>{keys.map((key) => <tr key={key}>
        <th>{stripInvisible(key)}</th>
        <td><pre>{display(row.pre?.[key])}</pre></td>
        <td><pre>{row.op === "delete" ? "—" : display(row.post[key])}</pre></td>
      </tr>)}</tbody>
    </table>
  </div>;
}
export function RootReviewStrip() {
  const t = useT();
  const { proposals, count, error, busy, decide, applyAll } = useRootReviewStore();
  const pending = proposals.filter((p) => p.status === "pending");
  const drafts = useMailStore((s) => s.agentDrafts);
  return <section className="root-review-strip" aria-label={t("rootReview.title")}>
    <div className="root-review-heading">
      <strong>{t("rootReview.title")} ({count})</strong> <UntestedTag />
      {count > 0 && <button className="dialog-btn" disabled={busy} onClick={() => void applyAll(pending)}>
        {t("rootReview.approveAll", { count })}
      </button>}
    </div>
    {error && <p role="alert">{stripInvisible(error)}</p>}
    {/* A draft is not a proposal and has no Approve: the row opens the
        composer, whose Send is bound to exactly what it shows. */}
    {drafts.length > 0 && <div className="root-review-cards">
      {drafts.map((draft) => <article key={draft.id} className="root-review-card">
        <strong>{t("rootReview.draft")}</strong> · {stripInvisible(draft.subject) || t("mail.noSubject")}
        <p>{t(draft.origin === "reader" ? "mail.agentDraftReaderBanner" : "mail.agentDraftBanner")}</p>
        <div className="root-review-actions">
          <button className="dialog-btn" onClick={() => void useMailStore.getState().openAgentDraft(draft)}>
            {t("rootReview.openDraft")}
          </button>
        </div>
      </article>)}
    </div>}
    {proposals.length > 0 && <div className="root-review-cards">
      {[...proposals].sort((a, b) => {
        const rank = (p: RootProposal) => p.status === "pending" ? 0 : p.status === "conflicted" ? 1 : 2;
        return rank(a) - rank(b);
      }).map((proposal) => {
        const { rows, folded } = reviewRows(proposal);
        const status = ["pending", "applied", "rejected", "conflicted", "undone"].includes(proposal.status)
          ? t(`rootReview.${proposal.status}` as "rootReview.pending") : stripInvisible(proposal.status);
        return <article key={proposal.id} className="root-review-card">
          <strong>{stripInvisible(proposal.tool)}</strong> · {status}
          <div>{stripInvisible(proposal.tab)} · {new Date(Number(proposal.created)).toLocaleString()}</div>
          {proposal.mcp_access && proposal.mcp_caller && <p>{t("mcpSecurity.reviewScope", {
            calendars: proposal.mcp_access.calendars.all ? t("mcpSecurity.allScopes") : proposal.mcp_access.calendars.ids.length,
            projects: proposal.mcp_access.projects.all ? t("mcpSecurity.allScopes") : proposal.mcp_access.projects.ids.length,
            caller: t(`mcpSecurity.${proposal.mcp_caller}`),
          })}</p>}
          {proposal.closed && <p>{t("rootReview.closed")}</p>}
          {proposal.tainted && <p>{t("rootReview.tainted")}</p>}
          {proposal.calendars.filter((c) => c.caldav_account_id).map((c) =>
            <p key={String(c.id)}>{t("rootReview.outbound", { name: display(c.name) })}</p>)}
          {proposal.status === "conflicted" && <p>{t("rootReview.conflict")}</p>}
          {/* Every pending card's actual rows stay visible, including in the
              bulk-approval view. No agent summary substitutes for these. */}
          {proposal.status === "pending" || proposal.status === "conflicted"
            ? rows.map((row, index) => <RowDiff key={index} row={row} />)
            : <details><summary>{t("rootReview.details")}</summary>{rows.map((row, index) => <RowDiff key={index} row={row} />)}</details>}
          {folded > 0 && <p>{t("rootReview.reordered", { count: folded })}</p>}
          <div className="root-review-actions">
            {(proposal.status === "pending" || proposal.status === "conflicted") && <>
              <button className="dialog-btn" disabled={busy || proposal.status !== "pending"} onClick={() => void decide(proposal, "apply")}>{t("rootReview.approve")}</button>
              <button className="dialog-btn" disabled={busy} onClick={() => void decide(proposal, "reject")}>{t(proposal.status === "conflicted" ? "rootReview.discard" : "rootReview.reject")}</button>
            </>}
            {proposal.status === "applied" && proposal.undo && <button className="dialog-btn" disabled={busy} onClick={() => void decide(proposal, "undo")}>{t("rootReview.undo")}</button>}
          </div>
        </article>;
      })}
    </div>}
  </section>;
}
