import { memo } from "react";
import { formatAddress, formatMailDate, stripFormatControls } from "../../lib/mail";
import { useI18nStore, useT } from "../../lib/i18n";
import type { MailHeader } from "../../types/mail";

/**
 * The header list — the middle pane.
 *
 * Two rules from the threat model are enforced *here*, in the rendering, not in
 * a review comment:
 *
 *  - **The addr-spec is always shown** (T7). A display name is attacker-chosen
 *    text — `From: "support@bank.example" <a@evil.example>` renders in most
 *    clients as the bank — so the row prints the name *and* the address, never
 *    the name alone, and strips the bidi/format controls that would otherwise let
 *    a name reorder what is on screen.
 *  - **Every mail-derived string is a plain text node.** No
 *    `dangerouslySetInnerHTML` anywhere under this feature; the only place a
 *    message's own markup renders is the sandboxed iframe in `MailMessageView`.
 *
 * A message whose headers were malformed (duplicate `From:`, and the like) is
 * marked, because the backend refused to silently pick one of the values and the
 * UI must not undo that by showing the first.
 */
export interface MailListProps {
  headers: MailHeader[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onToggleFlag: (header: MailHeader) => void;
  /** Paging, rendered only when the folder has more than one page. */
  offset: number;
  pageSize: number;
  total: number;
  onPage: (offset: number) => void;
}

function MailListImpl({
  headers,
  selectedId,
  loading,
  onSelect,
  onToggleFlag,
  offset,
  pageSize,
  total,
  onPage,
}: MailListProps) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const hasPaging = total > pageSize;

  return (
    <div className="mail-list">
      {loading && headers.length === 0 && <div className="mail-empty">{t("mail.loading")}</div>}
      {!loading && headers.length === 0 && (
        <div className="mail-empty">{t("mail.noMessages")}</div>
      )}
      <div className="mail-list-rows">
        {headers.map((h) => (
          <div
            key={h.id}
            className={`mail-row${h.id === selectedId ? " selected" : ""}${h.seen ? "" : " unread"}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(h.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(h.id);
              }
            }}
          >
            <div className="mail-row-top">
              <button
                type="button"
                className={`mail-flag-btn${h.flagged ? " on" : ""}`}
                title={h.flagged ? t("mail.unflag") : t("mail.flag")}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFlag(h);
                }}
              >
                {h.flagged ? "★" : "☆"}
              </button>
              <span className="mail-row-from" title={h.from.address}>
                {formatAddress(h.from)}
              </span>
              <span className="mail-row-date">{formatMailDate(h.date, lang)}</span>
            </div>
            <div className="mail-row-subject">
              {h.has_attachments && (
                <span className="mail-row-clip" title={t("mail.hasAttachments")}>
                  📎
                </span>
              )}
              {stripFormatControls(h.subject) || t("mail.noSubject")}
            </div>
            {h.preview && (
              <div className="mail-row-preview">{stripFormatControls(h.preview)}</div>
            )}
            {!!h.malformed_headers?.length && (
              <div className="mail-row-warning">{t("mail.malformedHeaders")}</div>
            )}
          </div>
        ))}
      </div>
      {hasPaging && (
        <div className="mail-list-paging">
          <button
            type="button"
            className="mail-btn"
            disabled={offset <= 0}
            onClick={() => onPage(Math.max(0, offset - pageSize))}
          >
            {t("mail.pagePrev")}
          </button>
          <span className="mail-paging-range">
            {t("mail.pageRange", {
              from: total === 0 ? 0 : offset + 1,
              to: Math.min(offset + pageSize, total),
              total,
            })}
          </span>
          <button
            type="button"
            className="mail-btn"
            disabled={offset + pageSize >= total}
            onClick={() => onPage(offset + pageSize)}
          >
            {t("mail.pageNext")}
          </button>
        </div>
      )}
    </div>
  );
}

export const MailList = memo(MailListImpl);
