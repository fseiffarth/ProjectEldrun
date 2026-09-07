import type { ChangeEventHandler, ReactNode } from "react";
import { Toggle } from "../common/Toggle";
import { useT } from "../../lib/i18n";

/**
 * The settings design system, in components.
 *
 * `styles/themes.css` (see "Settings design system") owns what these look
 * like; this file owns the *markup* every settings surface is built from, so a
 * panel cannot quietly invent a fifth kind of row. The whole Settings dialog —
 * main panel, every sub-panel, and the settings-shaped sections other dialogs
 * embed — is made of:
 *
 *   `SettingsHeader`   one title strip: ‹ Back, title, ✕
 *   `SettingsSection`  a section header, its intro copy, and its content
 *   `SettingsCard`     the one container
 *   `SettingRow`       a labelled control (+ its help) as a card
 *   `ToggleRow`        one switch line, for stacking several in one card
 *   `ToggleCard`       a single switch (+ its help) as a card
 *
 * The rule of thumb: **help text belongs to a control, not to the scroll**.
 * Pass it as `help` so it renders inside that control's card; a loose
 * `<p className="settings-help">` is for a section intro and nothing else.
 */

/** One header for every settings surface. `onBack` renders the sub-panel's
 *  return arrow on the left; `onClose` the dialog's ✕ on the right — a
 *  sub-panel gets both, so closing Settings never costs two clicks. */
export function SettingsHeader({
  title,
  onBack,
  onClose,
}: {
  title: ReactNode;
  onBack?: () => void;
  onClose?: () => void;
}) {
  const t = useT();
  return (
    <div className="settings-title-row">
      {onBack && (
        <button type="button" className="settings-btn sm" onClick={onBack}>
          ‹ {t("common.back")}
        </button>
      )}
      <h2>{title}</h2>
      {onClose && (
        <button type="button" className="dialog-close-btn" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}

/** A section header, optionally introduced by a line of copy. Renders a
 *  fragment: the panel's scroll is a flex column and owns the spacing, so a
 *  wrapper element here would only add a second gap to reason about. */
export function SettingsSection({
  title,
  help,
  children,
}: {
  title: ReactNode;
  help?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="settings-section-title">{title}</div>
      {help && <p className="settings-help">{help}</p>}
      {children}
    </>
  );
}

/** The one container. Hold several `ToggleRow`s to group switches that answer
 *  the same question; for a single control prefer `SettingRow`/`ToggleCard`. */
export function SettingsCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`settings-card${className ? ` ${className}` : ""}`}>{children}</div>
  );
}

/** A labelled control as its own card: label left, control in the shared
 *  control column, help attached underneath. `htmlFor` associates the label
 *  with an `<input>`; a `Dropdown` is a button and needs none. */
export function SettingRow({
  label,
  control,
  help,
  htmlFor,
}: {
  /** `ReactNode`, not `string`: a label may carry an `<UntestedTag />`. */
  label: ReactNode;
  control: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="settings-card">
      <div className="settings-card-row">
        {htmlFor ? (
          <label className="settings-card-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="settings-card-label">{label}</span>
        )}
        {control}
      </div>
      {help && <p className="settings-help">{help}</p>}
    </div>
  );
}

/** One switch line. A `<label>` so the whole row toggles it — which is why the
 *  row's own help (if any) renders *after* the label, never inside it. */
export function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
  title,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className="settings-card-row">
      <span>{label}</span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} title={title} />
    </label>
  );
}

/** A single switch with its explanation, as one card. */
export function ToggleCard({
  label,
  checked,
  onChange,
  disabled,
  help,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  disabled?: boolean;
  help?: ReactNode;
}) {
  return (
    <SettingsCard>
      <ToggleRow label={label} checked={checked} onChange={onChange} disabled={disabled} />
      {help && <p className="settings-help">{help}</p>}
    </SettingsCard>
  );
}

/** A list of repeated rows. `boxed` frames them as one table with hairline
 *  separators (download folders, shortcuts, file types); leave it off when the
 *  children are cards that already draw their own edges. */
export function SettingsList({
  children,
  boxed,
  className,
}: {
  children: ReactNode;
  boxed?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`settings-list${boxed ? " boxed" : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
}
