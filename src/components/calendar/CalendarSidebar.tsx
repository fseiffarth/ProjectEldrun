import { useMemo, useState } from "react";
import type { Calendar } from "../../types";
import { calendarSyncStatus, useCalDavStore } from "../../stores/caldav";
import { addMonths, datePart, monthGrid, monthName, todayStr, weekdayLabel } from "../../lib/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";

/** The palette a new calendar picks from. */
const CALENDAR_COLORS = [
  "#4aa3df", "#e8663d", "#59b96a", "#c164d6",
  "#e2b93b", "#d9556b", "#4fc3c3", "#8d8fd6",
];

interface Props {
  calendars: Calendar[];
  /** The date the mini-month highlights and navigates from. */
  selected: string;
  onSelect: (date: string) => void;
  onToggleVisible: (id: string) => void;
  onCreateCalendar: (name: string, color: string) => void;
  onUpdateCalendar: (calendar: Calendar) => void;
  onDeleteCalendar: (id: string) => void;
  /** Create a calendar subscribed to a read-only ICS feed URL and import it. */
  onSubscribeCalendar: (name: string, url: string) => void;
  /** Re-fetch a subscribed calendar's feed and replace its events with it. */
  onRefreshCalendar: (id: string) => void;
  /** Sync a CalDAV-backed calendar now (the forcing kind — it skips the ctag
   *  check, because a user clicking Sync after fixing something on the server
   *  should not be told "nothing changed" by a token). */
  onSyncCaldav: (calendarId: string) => void;
  /** Open the CalDAV account manager. */
  onOpenCaldav: () => void;
  weekStart: 0 | 1;
}

/**
 * The left rail: a mini-month for jumping around, and the calendar list.
 *
 * Unchecking a calendar hides its events everywhere (the checkbox writes through
 * to `visible` on disk, so the choice survives a restart — same as Thunderbird).
 */
export function CalendarSidebar({
  calendars,
  selected,
  onSelect,
  onToggleVisible,
  onCreateCalendar,
  onUpdateCalendar,
  onDeleteCalendar,
  onSubscribeCalendar,
  onRefreshCalendar,
  onSyncCaldav,
  onOpenCaldav,
  weekStart,
}: Props) {
  const t = useT();
  // A CalDAV-backed calendar gets its own affordance rather than the ICS feed's
  // ↻: the two are the same *kind* of action ("go get the latest from wherever
  // this came from") but not the same path, and a failed unattended sync has to
  // be visible on the row rather than only inside a dialog nobody has open.
  const caldavAccounts = useCalDavStore((s) => s.accounts);
  const caldavStatus = useCalDavStore((s) => s.status);
  const lang = useI18nStore((s) => s.lang);
  // The mini-month browses independently of the main view's anchor, so you can
  // look ahead without moving what you are working on until you click a day.
  const [browse, setBrowse] = useState(() => datePart(selected));
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [subName, setSubName] = useState("");
  const [subUrl, setSubUrl] = useState("");

  const today = todayStr();
  const year = Number(browse.slice(0, 4));
  const month = Number(browse.slice(5, 7));

  const weeks = useMemo(
    () => monthGrid(year, month, weekStart, 6),
    [year, month, weekStart],
  );

  const labels = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => weekdayLabel(lang, i, "narrow"));
    return [...days.slice(weekStart), ...days.slice(0, weekStart)];
  }, [weekStart, lang]);

  function submitNew() {
    const name = newName.trim();
    if (!name) return;
    // Cycle the palette so a fresh calendar never collides with the last one.
    onCreateCalendar(name, CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length]);
    setNewName("");
    setAdding(false);
  }

  function submitSubscribe() {
    const url = subUrl.trim();
    if (!url) return;
    const name = subName.trim() || url;
    onSubscribeCalendar(name, url);
    setSubName("");
    setSubUrl("");
    setSubscribing(false);
  }

  return (
    <div className="cal-sidebar">
      <div className="cal-mini">
        <div className="cal-mini-head">
          <button
            className="cal-nav-btn"
            onClick={() => setBrowse(addMonths(browse, -1))}
            title={t("calendarSidebar.prevMonthTitle")}
          >
            ‹
          </button>
          <span className="cal-mini-title">{monthName(lang, month)} {year}</span>
          <button
            className="cal-nav-btn"
            onClick={() => setBrowse(addMonths(browse, 1))}
            title={t("calendarSidebar.nextMonthTitle")}
          >
            ›
          </button>
        </div>

        <div className="cal-mini-weekdays">
          {labels.map((w, i) => (
            <span key={i} className="cal-mini-weekday">{w}</span>
          ))}
        </div>

        {weeks.map((week, wi) => (
          <div key={wi} className="cal-mini-week">
            {week.map((date) => {
              const inMonth = Number(date.slice(5, 7)) === month;
              const classes = ["cal-mini-day"];
              if (!inMonth) classes.push("cal-mini-day-out");
              if (date === today) classes.push("cal-mini-day-today");
              if (date === datePart(selected)) classes.push("cal-mini-day-selected");
              return (
                <button
                  key={date}
                  className={classes.join(" ")}
                  onClick={() => onSelect(date)}
                >
                  {Number(date.slice(8, 10))}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="cal-list">
        <div className="cal-list-head">
          <span className="cal-list-title">{t("calendarSidebar.calendarsTitle")}</span>
          <button className="cal-link-btn" onClick={() => setAdding((a) => !a)}>
            {t("calendarSidebar.newButton")}
          </button>
          <button className="cal-link-btn" onClick={() => setSubscribing((s) => !s)}>
            {t("calendarSidebar.subscribeButton")}
          </button>
          <button
            className="cal-link-btn"
            onClick={onOpenCaldav}
            title={t("caldav.manageAccountsTitle")}
          >
            {t("caldav.accountsButton")}
          </button>
        </div>

        {adding ? (
          <div className="cal-list-add">
            <input
              className="cal-input"
              type="text"
              placeholder={t("calendarSidebar.namePlaceholder")}
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNew();
                if (e.key === "Escape") {
                  setAdding(false);
                  setNewName("");
                }
              }}
            />
            <button className="cal-btn cal-btn-primary" disabled={!newName.trim()} onClick={submitNew}>
              {t("common.add")}
            </button>
          </div>
        ) : null}

        {subscribing ? (
          <div className="cal-list-add cal-list-subscribe">
            <input
              className="cal-input"
              type="text"
              placeholder={t("calendarSidebar.subscribeNamePlaceholder")}
              autoFocus
              value={subName}
              onChange={(e) => setSubName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSubscribing(false);
                  setSubName("");
                  setSubUrl("");
                }
              }}
            />
            <input
              className="cal-input"
              type="url"
              placeholder={t("calendarSidebar.subscribeUrlPlaceholder")}
              value={subUrl}
              onChange={(e) => setSubUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitSubscribe();
                if (e.key === "Escape") {
                  setSubscribing(false);
                  setSubName("");
                  setSubUrl("");
                }
              }}
            />
            <button className="cal-btn cal-btn-primary" disabled={!subUrl.trim()} onClick={submitSubscribe}>
              {t("common.add")}
            </button>
          </div>
        ) : null}

        {calendars.map((cal) => (
          <div key={cal.id} className="cal-list-row">
            <input
              type="checkbox"
              checked={cal.visible}
              onChange={() => onToggleVisible(cal.id)}
              title={cal.visible ? t("calendarSidebar.hideCalendarTitle") : t("calendarSidebar.showCalendarTitle")}
            />

            <input
              type="color"
              className="cal-color-dot"
              value={cal.color}
              title={t("calendarSidebar.colorTitle")}
              onChange={(e) => onUpdateCalendar({ ...cal, color: e.target.value })}
            />

            {editing === cal.id ? (
              <input
                className="cal-input cal-list-rename"
                type="text"
                autoFocus
                defaultValue={cal.name}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== cal.name) onUpdateCalendar({ ...cal, name });
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span
                className={`cal-list-name${cal.visible ? "" : " cal-list-name-off"}`}
                onDoubleClick={() => setEditing(cal.id)}
                title={t("calendarSidebar.renameHintTitle")}
              >
                {cal.name}
              </span>
            )}

            {cal.source_url ? (
              <button
                className="cal-link-btn cal-list-refresh"
                title={t("calendarSidebar.refreshCalendarTitle")}
                onClick={() => onRefreshCalendar(cal.id)}
              >
                ↻
              </button>
            ) : null}

            {(() => {
              const sync = calendarSyncStatus(caldavStatus, caldavAccounts, cal.id);
              if (!sync) return null;
              const failed = sync.phase === "error";
              return (
                <button
                  className={`cal-link-btn cal-list-refresh${failed ? " cal-list-sync-error" : ""}`}
                  // The error is the button's own tooltip, verbatim from the
                  // backend: an amber mark that cannot say why is a mark the
                  // user can only respond to by opening things at random.
                  title={
                    failed
                      ? t("caldav.syncFailedTitle", { error: sync.error })
                      : sync.at
                        ? t("caldav.syncedAtTitle", { at: sync.at })
                        : t("caldav.syncNowTitle")
                  }
                  onClick={() => onSyncCaldav(cal.id)}
                >
                  {sync.phase === "syncing" ? "…" : failed ? "!" : "⇅"}
                </button>
              );
            })()}

            {/* The last calendar cannot be deleted — the store always keeps one. */}
            {calendars.length > 1 ? (
              <button
                className="cal-link-btn cal-link-danger cal-list-del"
                title={t("calendarSidebar.deleteCalendarTitle")}
                onClick={() => onDeleteCalendar(cal.id)}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
