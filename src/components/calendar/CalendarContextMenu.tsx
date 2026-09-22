import type { Occurrence } from "../../types";
import type { CalendarClipboardEntry, PasteTarget } from "../../lib/calendar/calendarClipboard";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";

/**
 * What a right-click landed on. Both halves can be set at once — a click on a
 * block in the hour grid is on an event *and* at a minute of a day — and the
 * menu then offers both groups, which is what lets a full day still be pasted
 * into: there is no empty pixel left to aim at, but every block is also a spot.
 */
export interface CalendarMenuTarget {
  x: number;
  y: number;
  /** The occurrence under the cursor, if the click landed on one. */
  occ: Occurrence | null;
  /** The day, and on an hour grid the minute, under the cursor. */
  slot: PasteTarget | null;
}

interface Props {
  target: CalendarMenuTarget;
  /** What is on the calendar clipboard; `null` disables Paste. */
  clipboard: CalendarClipboardEntry | null;
  onClose: () => void;
  onEdit: (occ: Occurrence) => void;
  onCopy: (occ: Occurrence) => void;
  /** `"this"` only ever arrives for an occurrence of a series. */
  onDelete: (occ: Occurrence, scope: "this" | "all") => void;
  onPaste: (slot: PasteTarget) => void;
  onCreate: (slot: PasteTarget) => void;
}

/**
 * The one right-click menu of the calendar, shared by every view.
 *
 * It exists because copying an entry has no other home: there is no button on a
 * block for it (a block is 44 px of hour grid), and the event dialog is the
 * wrong place — by the time it is open, "the same again next week" means
 * retyping the form the dialog is showing. Right-click → Copy, right-click on
 * the target day → Paste is the whole feature.
 *
 * Delete sits here too, in its own danger zone, and matches the dialog's rule
 * rather than inventing a second one: a plain event goes at once (the dialog's
 * Delete does too), and a repeating one is never deleted without saying which —
 * the two scopes are two rows, so the choice is made *in* the click instead of
 * in a follow-up dialog.
 */
export function CalendarContextMenu({
  target,
  clipboard,
  onClose,
  onEdit,
  onCopy,
  onDelete,
  onPaste,
  onCreate,
}: Props) {
  const t = useT();
  const { occ, slot } = target;

  /** Every row closes the menu; the act is what the row is for. */
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <ContextMenuPortal x={target.x} y={target.y} onClose={onClose}>
      {occ ? (
        <div className="context-menu-group">
          {/* The menu names what it is about — an event's own title, which is
              why it is a plain text node like every other place one is shown. */}
          <div className="context-menu-group-label context-menu-quote">
            {occ.title || t("calendar.untitled")}
          </div>
          <button className="untested" onClick={act(() => onEdit(occ))}>
            {t("common.edit")}
            <UntestedTag id="calendarContextMenu.1" />
          </button>
          <button className="untested" onClick={act(() => onCopy(occ))}>
            {t("common.copy")}
            <UntestedTag id="calendarContextMenu.2" />
          </button>
          {occ.recurring ? (
            <div className="context-menu-note">{t("calendarMenu.copyOfSeriesNote")}</div>
          ) : null}
        </div>
      ) : null}

      {slot ? (
        <div className="context-menu-group">
          <button className="untested" onClick={act(() => onCreate(slot))}>
            {t("calendarMenu.newHere")}
            <UntestedTag id="calendarMenu.newHere" />
          </button>
        </div>
      ) : null}

      {slot ? (
        <div className="context-menu-group">
          {/* What is on the clipboard is named in the caption, not in the
              button: a title has no length limit and would otherwise stretch
              the menu to the width of whatever was copied. */}
          {clipboard ? (
            <div className="context-menu-group-label context-menu-quote">
              {clipboard.title || t("calendar.untitled")}
            </div>
          ) : null}
          {/* Offered even with an empty clipboard, as a disabled row: a menu
              whose shape changes under the cursor is a menu you cannot aim at,
              and "nothing copied yet" is worth saying once. */}
          <button
            className="untested"
            disabled={!clipboard}
            onClick={clipboard ? act(() => onPaste(slot)) : undefined}
          >
            {t("common.paste")}
            <UntestedTag id="calendarContextMenu.6" />
          </button>
          {!clipboard ? (
            <div className="context-menu-note">{t("calendarMenu.pasteEmptyNote")}</div>
          ) : null}
        </div>
      ) : null}

      {occ ? (
        <div className="context-menu-danger-zone">
          {occ.recurring ? (
            <>
              <button className="danger untested" onClick={act(() => onDelete(occ, "this"))}>
                {t("eventDialog.deleteThisOccurrence")}
                <UntestedTag id="calendarContextMenu.4" />
              </button>
              <button className="danger untested" onClick={act(() => onDelete(occ, "all"))}>
                {t("eventDialog.deleteWholeSeries")}
                <UntestedTag id="calendarContextMenu.5" />
              </button>
            </>
          ) : (
            <button className="danger untested" onClick={act(() => onDelete(occ, "all"))}>
              {t("common.delete")}
              <UntestedTag id="calendarContextMenu.3" />
            </button>
          )}
        </div>
      ) : null}
    </ContextMenuPortal>
  );
}
