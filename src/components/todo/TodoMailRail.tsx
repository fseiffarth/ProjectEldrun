import { useEffect, useMemo } from "react";

import type { CalendarTask } from "../../types";
import type { MailHeader } from "../../types/mail";
import { useCalendarStore } from "../../stores/calendar";
import { useMailStore } from "../../stores/mail";
import { useTodoStore } from "../../stores/todo";
import { useExperimental } from "../../lib/experimental";
import { selectUrgentMail, taskFromMail } from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";

interface Props {
  tasks: CalendarTask[];
  defaultCalendarId: string;
  firstColumnId: string;
}

/**
 * How often the rail re-reads the marked mail while the overlay is open.
 *
 * Polling is defensible **only** because `mail_priority_page` is a read of the
 * local SQLite index and opens no socket — the mail store's "nothing reaches a
 * server on its own" rule is about `checkMail`, which this never calls. If that
 * ever stops being true on the Rust side, this timer is the thing that has to go.
 */
const TICK_MS = 60_000;

/**
 * The urgent-mail rail.
 *
 * It reads mail **without touching the mail store's list state**:
 * `useMailStore.openPriority` replaces `headers` and `selectedPriority`, i.e. it
 * retargets the mail overlay's list, so a rail that used it would move the user's
 * mailbox under them once a minute.
 *
 * The gate is checked **before the invoke**, not around the rendering: opening
 * the mail store creates `~/.local/share/eldrun/mail/` as a side effect, and a
 * todo board must not materialize a mail database for someone who has the mail
 * client switched off.
 */
export function TodoMailRail({ tasks, defaultCalendarId, firstColumnId }: Props) {
  const t = useT();
  const mailClient = useExperimental("mail_client");
  const accounts = useMailStore((s) => s.accounts);
  const newCount = useMailStore((s) => s.newCount);
  const overlayOpen = useTodoStore((s) => s.overlayOpen);
  const urgent = useTodoStore((s) => s.urgentMail);
  const important = useTodoStore((s) => s.importantMail);
  const error = useTodoStore((s) => s.urgentError);

  useEffect(() => {
    if (!mailClient || !overlayOpen) return;
    void useTodoStore.getState().loadUrgentMail();
    const id = setInterval(() => void useTodoStore.getState().loadUrgentMail(), TICK_MS);
    return () => clearInterval(id);
    // `newCount` is the arrival signal — the `mail:new` listener itself belongs
    // to `MailIndicator`, which is mounted once per window; a second listener
    // here would double-count a delivery.
  }, [mailClient, overlayOpen, newCount]);

  const rows = useMemo(
    () => selectUrgentMail(urgent, important, tasks),
    [urgent, important, tasks],
  );

  if (!mailClient) {
    return (
      <section className="todo-rail">
        <h3 className="todo-rail-title">{t("todoMail.title")}</h3>
        <p className="todo-rail-muted">{t("todoMail.disabled")}</p>
      </section>
    );
  }

  const openInMail = async (header: MailHeader) => {
    // Close first: all three overlays are `.modal-backdrop` at the same
    // z-index, so leaving this one up would stack a board over the mailbox.
    useTodoStore.getState().closeOverlay();
    const mail = useMailStore.getState();
    // Awaited in this order on purpose: `selectMessage` resolves its header out
    // of the loaded page, so selecting before the page lands renders a body with
    // no envelope.
    await mail.openPriority(header.priority ?? "urgent").catch(() => {});
    await mail.selectMessage(header.id).catch(() => {});
    mail.openOverlay();
  };

  // The card's shape is `lib/todoBoard`'s, shared with the agenda rail's own
  // conversion — one definition of what a converted card *is*, so a board cannot
  // end up holding two kinds of them.
  const makeCard = async (header: MailHeader) => {
    await useCalendarStore
      .getState()
      .createTask(
        taskFromMail(
          header,
          { calendarId: defaultCalendarId, columnId: firstColumnId, now: new Date() },
          t("mail.noSubject"),
        ),
      )
      .catch((err) => useTodoStore.getState().setError(String(err)));
  };

  return (
    <section className="todo-rail">
      <h3 className="todo-rail-title">
        {t("todoMail.title")}
        <button
          type="button"
          className="todo-rail-refresh"
          title={t("todoMail.refresh")}
          aria-label={t("todoMail.refresh")}
          onClick={() => void useTodoStore.getState().loadUrgentMail()}
        >
          ⟳
        </button>
      </h3>

      {accounts.length === 0 ? (
        <p className="todo-rail-muted">{t("todoMail.noAccounts")}</p>
      ) : error ? (
        <p className="todo-rail-muted">{t("todoMail.failed")}</p>
      ) : rows.length === 0 ? (
        <p className="todo-rail-muted">{t("todoMail.empty")}</p>
      ) : (
        <ul className="todo-rail-list">
          {rows.map((header) => (
            <li key={header.id} className="todo-mail-row">
              <span
                className={
                  "todo-mail-dot" +
                  (header.priority === "urgent" ? " urgent" : " important")
                }
                title={
                  header.priority === "urgent"
                    ? t("todoMail.urgent")
                    : t("todoMail.important")
                }
                aria-hidden
              >
                ●
              </span>
              <span className="todo-mail-text">
                <span className="todo-mail-from">
                  {header.from?.name || header.from?.address || ""}
                </span>
                <span className="todo-mail-subject">
                  {header.subject || t("mail.noSubject")}
                </span>
              </span>
              <span className="todo-mail-actions">
                <button
                  type="button"
                  className="cal-link-btn"
                  onClick={() => void makeCard(header)}
                  title={t("todoMail.makeTodo")}
                >
                  ＋
                </button>
                <button
                  type="button"
                  className="cal-link-btn"
                  onClick={() => void openInMail(header)}
                  title={t("todoMail.open")}
                >
                  ✉
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
