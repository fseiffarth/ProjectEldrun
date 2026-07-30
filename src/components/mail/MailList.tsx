import { memo, useState } from "react";
import { createPortal } from "react-dom";
import { formatAddress, formatMailDate, formatSize, stripFormatControls } from "../../lib/mail";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { UntestedTag } from "../common/UntestedTag";
import type { MailHeader, MailPriority, MailSort } from "../../types/mail";

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
 *
 * **Right-click files a message into Important or Urgent.** The menu is the only
 * way in, deliberately: marking is not a per-row button because there are two
 * marks plus an unmark, and three glyphs on every row would cost more attention
 * than the feature is worth on the rows nobody is filing. The menu is portaled to
 * `<body>` and positioned at the cursor — the pattern `ProjectFilesView`'s type-tag
 * menu uses — because this list scrolls and clips, and an in-flow menu on the last
 * visible row would open inside the overflow.
 */
export interface MailListProps {
  headers: MailHeader[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onToggleFlag: (header: MailHeader) => void;
  /** Read ⇄ unread for one message. Opening a message already marks it read, so
   *  in practice this is the *un*-read direction: the way to put something back
   *  on the pile after looking at it, which nothing else here can do. */
  onToggleSeen: (header: MailHeader) => void;
  /** File a message under a mark, or with `null` take it off both lists. */
  onSetPriority: (header: MailHeader, priority: MailPriority | null) => void;
  /** The order the rows are already in, and which way round. Passed in rather
   *  than held here because the *store* applies it — see `onSort`. */
  sort: MailSort;
  sortDesc: boolean;
  /**
   * A header was clicked. The list decides the direction (same column ⇒ flip,
   * a new column ⇒ its own natural default) and the caller only forwards the
   * pair to the store.
   *
   * The list does not sort itself, and that is not a layering nicety: it is
   * handed **one page** of a folder, so ordering `headers` would order the
   * hundred rows on screen — the biggest message in a mailbox, or its one
   * starred mail, is rarely among the newest hundred. So the header row is a
   * *control*, and the sort happens in SQLite over the whole folder.
   */
  onSort: (sort: MailSort, desc: boolean) => void;
  /** Resolve a message's account to a label. Set only while the list is a
   *  cross-account priority list, where "which mailbox is this from" is a
   *  question the rail can no longer answer — in a folder it is already known
   *  and printing it on every row would be noise. */
  accountLabel?: (header: MailHeader) => string | undefined;
  /** Paging, rendered only when the folder has more than one page. */
  offset: number;
  pageSize: number;
  total: number;
  /**
   * Set only when a search over an **encrypted** store stopped early. `total`
   * then means "matches among the ones I looked at", which is a weaker claim
   * than usual and has to be visible — a truncated answer that looks complete
   * is the one thing a search must never produce.
   */
  scanned?: number;
  onPage: (offset: number) => void;
}

/** Where the context menu is, and which message it is about. */
interface RowMenu {
  x: number;
  y: number;
  header: MailHeader;
}

function MailListImpl({
  headers,
  selectedId,
  loading,
  onSelect,
  onToggleFlag,
  onToggleSeen,
  onSetPriority,
  sort,
  sortDesc,
  onSort,
  accountLabel,
  offset,
  pageSize,
  total,
  scanned,
  onPage,
}: MailListProps) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const hasPaging = total > pageSize;
  const [menu, setMenu] = useState<RowMenu | null>(null);

  const file = (priority: MailPriority | null) => {
    if (!menu) return;
    onSetPriority(menu.header, priority);
    setMenu(null);
  };

  /**
   * One header control, positioned above the thing it orders.
   *
   * Clicking the column already sorted **flips** it; clicking another switches
   * to it descending — which is the useful end of every one of these columns
   * (starred first, attachments first, biggest first, newest first), so the
   * first click on a column is never the click that shows you the 400 mails
   * without a star.
   *
   * A plain function returning elements, deliberately **not** a component
   * declared inside this one: a nested component is a new type on every render,
   * so React would unmount and remount these buttons each time — and the render
   * that follows a header click is exactly the one that would then drop focus
   * from the button just pressed.
   */
  const sortHeader = ({
    field,
    label,
    title,
    className,
  }: {
    field: MailSort;
    label: string;
    title: string;
    className?: string;
  }) => {
    const active = sort === field;
    return (
      <button
        type="button"
        className={`mail-sort-header${active ? " active" : ""}${className ? ` ${className}` : ""}`}
        // The tooltip says what a click will *do*, not what the column is: on
        // the active column that is "reverse this", everywhere else "sort by
        // this" — which is the one thing a glyph-only header cannot say.
        title={active ? (sortDesc ? t("mail.sortDescending") : t("mail.sortAscending")) : title}
        aria-label={title}
        aria-pressed={active}
        onClick={() => onSort(field, active ? !sortDesc : true)}
      >
        <span className="mail-sort-header-label">{label}</span>
        {/* The arrow marks the sorted column and nothing else — an arrow on
            every header would make all four look equally sorted. */}
        {active && <span className="mail-sort-arrow">{sortDesc ? "▼" : "▲"}</span>}
      </button>
    );
  };

  return (
    <div className="mail-list">
      {/* The sort lives on the list, each control sitting above the column it
          orders — the star over the stars, the clip over the clips — so the
          order is read off the rows rather than off a dropdown elsewhere. The
          sender column is deliberately NOT a control: `from` is stored as JSON,
          so ordering by it would sort by `{"name":…` rather than by anyone's
          name, and a header that sorted wrongly is worse than one that does
          not sort. */}
      <div className="mail-list-sort" role="group" aria-label={t("mail.sortBy")}>
        {sortHeader({ field: "flagged", label: "★", title: t("mail.sortFlagged") })}
        {/* The read/unread column has no header control: there is no unread
            sort, and a dead label above a live column reads as one that failed
            rather than one that was never offered. The cell is still *there*,
            because the header only aligns with the rows if it has a cell per
            column. */}
        <span className="mail-sort-spacer" aria-hidden="true" />
        {sortHeader({ field: "attachments", label: "📎", title: t("mail.sortAttachments") })}
        <span className="mail-sort-from">{t("mail.sortFrom")}</span>
        {sortHeader({
          field: "size",
          label: t("mail.sortSize"),
          title: t("mail.sortSize"),
          className: "numeric",
        })}
        {sortHeader({
          field: "date",
          label: t("mail.sortDate"),
          title: t("mail.sortDate"),
          className: "numeric",
        })}
      </div>
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
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // Select as well as open the menu. Right-clicking a row you are
              // not looking at and having the menu act on it while the message
              // pane still shows the previous one is how the wrong mail gets
              // filed; the menu names the subject for the same reason.
              onSelect(h.id);
              setMenu({ x: e.clientX, y: e.clientY, header: h });
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
              {/* Beside the star because it is the same kind of control — a
                  per-message state toggled in place — and `stopPropagation` for
                  the same reason: the row itself opens the message, and opening
                  it marks it read, which would undo the click that was just
                  made. A filled dot is unread, a hollow one read; the glyph
                  matches the row's own unread emphasis rather than adding a
                  second vocabulary. */}
              <button
                type="button"
                className={`mail-seen-btn${h.seen ? "" : " on"}`}
                title={h.seen ? t("mail.markUnread") : t("mail.markRead")}
                aria-label={h.seen ? t("mail.markUnread") : t("mail.markRead")}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSeen(h);
                }}
              >
                {h.seen ? "○" : "●"}
              </button>
              {/* The clip is a **column**, not a glyph in front of the subject:
                  it sits under its own header, in the same place on every row,
                  which is what lets the eye run down it — and an empty cell is
                  still rendered, because a marker that shifts the subject left
                  when it is absent is a column in name only. */}
              <span className="mail-row-clip" title={h.has_attachments ? t("mail.hasAttachments") : undefined}>
                {h.has_attachments ? "📎" : ""}
              </span>
              <span className="mail-row-from" title={h.from.address}>
                {formatAddress(h.from)}
              </span>
              {/* Always printed, not only while sorted by size: a column that
                  appears with its sort would move every other column sideways
                  on the click that selected it. */}
              <span className="mail-row-size">{formatSize(h.size)}</span>
              <span className="mail-row-date">{formatMailDate(h.date, lang, use24h)}</span>
            </div>
            <div className="mail-row-subject">
              {/* The mark is shown on the row wherever the row is — in its own
                  folder as much as in the Important list — because that is the
                  only place the user can see that filing it *worked*. In the
                  list itself it is not redundant either: it is what distinguishes
                  the two lists' rows if both are ever shown together. It stays
                  with the subject rather than becoming a column of its own: it
                  is present on a handful of rows by design, so a column for it
                  would be empty space on every other one. */}
              {h.priority && (
                <span
                  className={`mail-row-priority ${h.priority}`}
                  title={t(
                    h.priority === "urgent" ? "mail.markedUrgent" : "mail.markedImportant",
                  )}
                >
                  {h.priority === "urgent" ? "!!" : "!"}
                </span>
              )}
              {stripFormatControls(h.subject) || t("mail.noSubject")}
            </div>
            {h.preview && (
              <div className="mail-row-preview">{stripFormatControls(h.preview)}</div>
            )}
            {/* Which mailbox this arrived in — only in a cross-account list,
                where the rail no longer answers it. An unresolvable account (one
                deleted since the mark was made) prints nothing rather than an
                id: an opaque uuid on a row says less than an empty space. */}
            {accountLabel?.(h) && (
              <div className="mail-row-account">{accountLabel(h)}</div>
            )}
            {!!h.malformed_headers?.length && (
              <div className="mail-row-warning">{t("mail.malformedHeaders")}</div>
            )}
          </div>
        ))}
      </div>
      {scanned !== undefined && (
        <div className="mail-note mail-list-scan-note">
          {t("mail.searchScanned", { count: scanned })}
        </div>
      )}
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

      {menu &&
        createPortal(
          <>
            {/* The dismiss layer catches a right-click too, so a second
                right-click somewhere else closes this menu rather than stacking
                a native one on top of it. */}
            <div
              style={{ position: "fixed", inset: 0, zIndex: 200 }}
              onPointerDown={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu(null);
              }}
            />
            <div
              className="context-menu"
              style={{ left: menu.x, top: menu.y, zIndex: 201 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="context-menu-group">
                {/* The subject, so the menu names what it is about. Truncated by
                    CSS, stripped of format controls like every other place a
                    subject is printed — a menu label is as attacker-reachable as
                    a row is. */}
                <div className="context-menu-group-label mail-menu-subject">
                  {stripFormatControls(menu.header.subject) || t("mail.noSubject")}
                </div>
                {/* Both marks are always offered, including the one the message
                    already carries — as a *disabled* row rather than a hidden
                    one, so the menu's shape does not shift under the cursor and
                    the current state is legible from the menu itself. */}
                <button
                  className="untested"
                  disabled={menu.header.priority === "important"}
                  onClick={() => file("important")}
                >
                  {t("mail.moveToImportant")}
                  <UntestedTag />
                </button>
                <button
                  className="untested"
                  disabled={menu.header.priority === "urgent"}
                  onClick={() => file("urgent")}
                >
                  {t("mail.moveToUrgent")}
                  <UntestedTag />
                </button>
                {menu.header.priority && (
                  <button className="untested" onClick={() => file(null)}>
                    {t("mail.removeFromPriority")}
                    <UntestedTag />
                  </button>
                )}
                {/* Says what filing does NOT do, at the one moment the user is
                    deciding to do it. "Move to" is the verb every mail client
                    uses and the one that was asked for, but nothing here leaves
                    the folder it is in — and a user who believed otherwise would
                    go looking for the message on the server and not find it
                    moved. */}
                <div className="context-menu-note">{t("mail.priorityIsLocal")}</div>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

export const MailList = memo(MailListImpl);
