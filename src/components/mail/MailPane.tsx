import { useEffect, useState } from "react";
import { MAIL_PAGE_SIZE, unreadTotal, useMailStore } from "../../stores/mail";
import { useSettingsStore } from "../../stores/settings";
import { onMailSync, mailAiAllowed } from "../../lib/mail";
import { useT } from "../../lib/i18n";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import type { MailAccount, MailHeader, MailPriority } from "../../types/mail";
import { MailList } from "./MailList";
import { MailMessageView } from "./MailMessageView";
import { MailAccountDialog } from "./MailAccountDialog";
import { MailComposeDialog, type ComposeMode } from "./MailComposeDialog";
import { MailEncryptionDialog } from "./MailEncryptionDialog";
import { MailFiltersDialog } from "./MailFiltersDialog";
import { MailKeysDialog } from "./MailKeysDialog";
import { MailAiSettingsDialog } from "./MailAiSettingsDialog";
import { MailAiQuickTags } from "./MailAiSettings";
import { mailPgpAvailable } from "../../lib/mail";
import { mailEncryptionState } from "../../lib/mail";
import type { MailEncryptionState } from "../../types/mail";

/**
 * The mail client: folder rail / header list / message view.
 *
 * **There is no mail *tab*.** This pane has exactly one host — `MailOverlayHost`,
 * behind the header's ✉ button. It was a tab too, once, and the tab was the half
 * that did not earn its keep: the store below is global (one mailbox across every
 * scope), so a mail tab showed the same mailbox everywhere while still belonging
 * to a project you then switched away from. The overlay is that same pane without
 * the scope, which is why the tab kind is retired (`RETIRED_TAB_CMDS`).
 *
 * **It never connects on its own.** Mounting reads the local index and nothing
 * else; the only path to a socket is the *Check mail* button (and the header's
 * opt-in interval check, which lives in `MailIndicator`). That is not politeness:
 * a mail command dispatched from a launch path against an unreachable server
 * would sit on the TCP timeout, and every one of those commands is async
 * precisely because a synchronous one would take the whole WebView down with it.
 *
 * The store is global, so this pane takes no project props at all — the same
 * shape as `CalendarPane`. Arrival *announcements* are `MailIndicator`'s, not
 * this pane's: the header badge is on screen whenever mail is reachable at all,
 * and a note strip here would be a second copy of it.
 */
export interface MailPaneProps {
  visible?: boolean;
}

export function MailPane({ visible }: MailPaneProps) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const accounts = useMailStore((s) => s.accounts);
  const accountsLoaded = useMailStore((s) => s.accountsLoaded);
  const foldersByAccount = useMailStore((s) => s.foldersByAccount);
  const selectedAccountId = useMailStore((s) => s.selectedAccountId);
  const selectedFolderId = useMailStore((s) => s.selectedFolderId);
  const selectedPriority = useMailStore((s) => s.selectedPriority);
  const priorityCounts = useMailStore((s) => s.priorityCounts);
  const selectedMessageId = useMailStore((s) => s.selectedMessageId);
  const headers = useMailStore((s) => s.headers);
  const headerTotal = useMailStore((s) => s.headerTotal);
  const headerScanned = useMailStore((s) => s.headerScanned);
  const headerOffset = useMailStore((s) => s.headerOffset);
  const query = useMailStore((s) => s.query);
  const sort = useMailStore((s) => s.sort);
  const sortDesc = useMailStore((s) => s.sortDesc);
  const body = useMailStore((s) => s.body);
  const loadingHeaders = useMailStore((s) => s.loadingHeaders);
  const loadingBody = useMailStore((s) => s.loadingBody);
  const sync = useMailStore((s) => s.sync);
  const error = useMailStore((s) => s.error);

  const [accountDialog, setAccountDialog] = useState<{ account: MailAccount | null } | null>(null);
  const [compose, setCompose] = useState<{ mode: ComposeMode; toAddress?: string } | null>(null);
  // The local store's encryption. Read once when the pane first becomes visible
  // rather than on mount: the read *opens the store* (that is what resolves the
  // unlock), and a pane that is mounted-but-hidden must not be the thing that
  // decides to migrate a database.
  const [encryption, setEncryption] = useState<MailEncryptionState | null>(null);
  const [encryptionDialog, setEncryptionDialog] = useState(false);
  // The keyword rules that file arriving mail into Important/Urgent. Opened
  // from inside the Priority group — the only place a rule's marks can land —
  // but on its own separated row there, and above the per-account list, since
  // the rules span every account exactly as the two lists do.
  const [filtersDialog, setFiltersDialog] = useState(false);
  // The key surface is offered only where it can work: the keyring needs the
  // local store encrypted, and a button that always fails with the same sentence
  // is worse than one that is not there until the precondition is met.
  const [keysDialog, setKeysDialog] = useState(false);
  // The per-account Mail AI (local) settings dialog, keyed by the account it is
  // configuring (the selected one from the toolbar, or a freshly created one).
  // Reachable only because the pane itself is gated by `mail_client`.
  const [aiAccountId, setAiAccountId] = useState<string | null>(null);
  const [pgpReady, setPgpReady] = useState(false);
  useEffect(() => {
    if (visible === false) return;
    void mailPgpAvailable().then(setPgpReady);
  }, [visible, encryption]);
  useEffect(() => {
    if (visible === false || encryption) return;
    void mailEncryptionState().then(setEncryption).catch(() => {});
  }, [visible, encryption]);

  // Asked exactly once, and only when there is genuinely no recorded answer:
  // `preference === undefined` is the "never asked" state the backend keeps
  // distinct from an explicit no, precisely so this cannot nag.
  useEffect(() => {
    if (!encryption) return;
    if (encryption.needs_passphrase) setEncryptionDialog(true);
    else if (!encryption.enabled && encryption.preference === undefined) setEncryptionDialog(true);
  }, [encryption]);

  // Local read only. The default account is a preference, not a connection.
  useEffect(() => {
    void useMailStore.getState().loadAccounts({ preferred: settings?.mail_default_account });
  }, [settings?.mail_default_account]);

  // Sync progress. Installed on mount so a sync started elsewhere (another
  // window, the header's interval check) still moves this pane's strip. The
  // `mail:new` half is deliberately NOT here: arrivals are announced by the
  // header badge (`MailIndicator`), which is mounted whether or not this pane is.
  useEffect(() => {
    // `listen` resolves asynchronously, so an unmount that beats the resolution
    // would otherwise leave the listener installed against a dead component.
    let cancelled = false;
    let off: (() => void) | undefined;
    void onMailSync((e) => {
      useMailStore.getState().applySyncEvent(e.account_id, {
        phase: e.phase,
        folderId: e.folder_id,
        newMessages: e.new_messages,
        error: e.error,
      });
    }).then((un) => {
      if (cancelled) un();
      else off = un;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const folders = selectedAccountId ? (foldersByAccount[selectedAccountId] ?? []) : [];
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;
  const aiAccount = aiAccountId ? (accounts.find((a) => a.id === aiAccountId) ?? null) : null;
  const selectedHeader = headers.find((h) => h.id === selectedMessageId);
  const syncState = selectedAccountId ? sync[selectedAccountId] : undefined;
  const syncing = syncState?.phase === "start" || syncState?.phase === "folder" || syncState?.phase === "headers";

  const toggleFlag = (h: MailHeader) =>
    void useMailStore.getState().setFlag(h.id, "flagged", !h.flagged);
  const setPriority = (h: MailHeader, priority: MailPriority | null) =>
    void useMailStore.getState().setPriority(h.id, priority);
  // Resolve a row's account to something a person recognizes. Falls back to
  // nothing rather than to the id: an account deleted since the mark was made
  // leaves rows whose `account_id` names no mailbox, and a raw uuid on a row
  // would be worse than a blank line.
  const accountLabel = (h: MailHeader) => {
    const account = accounts.find((a) => a.id === h.account_id);
    return account ? account.label || account.address : undefined;
  };
  const toggleSeen = (h: MailHeader) =>
    void useMailStore.getState().setFlag(h.id, "seen", !h.seen);

  // The unread count is the *folder's*, not this page's: the button acts on the
  // whole folder, so counting the 100 rows on screen would understate what the
  // click is about to do.
  const selectedFolder = folders.find((f) => f.id === selectedFolderId);
  const folderUnread = selectedFolder?.unread ?? 0;

  // The open priority list's own size — the *whole* list, not this page, for
  // "Mark all as read"'s reason one control over: the button acts on every
  // message carrying the mark, including the ones the pager has not reached.
  const priorityListCount = selectedPriority
    ? selectedPriority === "urgent"
      ? priorityCounts.urgent
      : priorityCounts.important
    : 0;
  // Emptying a list is the only bulk *unmark* there is, and it is asked about
  // first: nothing moves and nothing is deleted (a mark is not a folder), but
  // the filing is the user's own work and there is no undo for it. The confirm
  // says both — what goes and what does not.
  const clearPriorityList = () => {
    if (!selectedPriority || priorityListCount === 0) return;
    const name = t(selectedPriority === "urgent" ? "mail.urgent" : "mail.important");
    if (!window.confirm(t("mail.confirmClearPriority", { name, count: priorityListCount }))) {
      return;
    }
    void useMailStore.getState().clearPriority(selectedPriority);
  };

  return (
    /* Hidden by style, not by the `hidden` attribute: `.mail-pane` sets
       `display: flex`, which would override the UA's `[hidden] { display: none }`
       and leave the pane painted on top of its sibling. Same shape as
       `CalendarPane`. */
    <div className="mail-pane" style={{ display: visible === false ? "none" : undefined }}>
      {/* ── The header band: everything that is not about one folder ───────
          Two rows, above the action row on purpose. What sits here is *which
          mailbox am I looking at* (the accounts) and *the two lists that belong
          to none of them* (Important/Urgent, plus the keyword rules that fill
          them) — questions you answer before you press Check mail, not while
          reading a folder. Below it the toolbar acts on that selection, and the
          rail is then free to be one thing only: this account's folders.

          Horizontal rather than a rail column because both groups are
          *switchers* with few entries and no hierarchy; stacked in the rail they
          were read as a tree, which is what made two cross-account lists look
          like they belonged to the first account underneath them. Side by side
          rather than stacked for the same reason one more time: one above the
          other still reads as an order, and neither of these two comes first.
          Accounts left (where reading starts, and what the toolbar below acts
          on), the cross-account lists right, with a divider between them. */}
      <div className="mail-headerband">
        <div className="mail-headerband-group">
          <span className="mail-headerband-label">{t("mail.accounts")}</span>
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              /* Lit only while a *folder* of it is on screen. The account
                 selection itself survives a priority list — the rail below
                 still needs an account to list folders for, and leaving the
                 list has to put you back where you were — but the chip is a
                 claim about what you are *reading*, and a cross-account list
                 is not this account's mail. The header dropdown
                 (`MailIndicator`) already draws its account rows by exactly
                 this rule; this is that rule, not a second one. */
              className={`mail-account-chip${
                a.id === selectedAccountId && !selectedPriority ? " selected" : ""
              }`}
              title={a.address}
              onClick={() => void useMailStore.getState().selectAccount(a.id)}
              onDoubleClick={() => setAccountDialog({ account: a })}
            >
              {/* The two names are not interchangeable: `display_name` is this
                  machine's own nickname for the mailbox and belongs on the
                  badge, `label` is the *sending* identity (the From: a
                  recipient reads) and is only the fallback here. The folders
                  heading below deliberately stays on `label` — the rail names
                  the account you send as, and giving it the nickname too would
                  make the nickname the only name in the pane. */}
              <span className="mail-chip-name">{a.display_name || a.label || a.address}</span>
              {unreadTotal(foldersByAccount[a.id]) > 0 && (
                <span className="mail-rail-badge">{unreadTotal(foldersByAccount[a.id])}</span>
              )}
            </button>
          ))}
          <button
            type="button"
            className="mail-btn mail-btn-small"
            onClick={() => setAccountDialog({ account: null })}
          >
            {t("mail.addAccount")}
          </button>
          {selectedAccountId && (
            <button
              type="button"
              className="mail-btn mail-btn-small"
              onClick={() =>
                setAccountDialog({
                  account: accounts.find((a) => a.id === selectedAccountId) ?? null,
                })
              }
            >
              {t("mail.editAccount")}
            </button>
          )}
        </div>

        <div className="mail-headerband-spacer" />

        {/* Rendered unconditionally, never only when something is marked: an
            empty Important list is where the feature is discovered, and a group
            that appears after you have already used it cannot teach it. The
            scope label is what keeps this group from reading as a property of
            the account selected to its left. */}
        <div className="mail-headerband-group mail-headerband-group-global">
          <span className="mail-headerband-label">
            {t("mail.priority")}
            <span className="mail-headerband-scope">{t("mail.priorityAllAccounts")}</span>
          </span>
          <button
            type="button"
            className={`mail-priority-chip important${
              selectedPriority === "important" ? " selected" : ""
            }`}
            onClick={() => void useMailStore.getState().openPriority("important")}
          >
            <span className="mail-rail-priority-mark" aria-hidden="true">
              !
            </span>
            {/* The label goes in the same span an account chip's does. A bare
                text node here was the whole bug: it cannot shrink or ellipsize,
                so on a tight row the chip's content ran past its own padding
                and the count sat outside the pill. The account chips never did
                that because their name has always been wrapped — so this copies
                what already works rather than inventing a second answer. */}
            <span className="mail-chip-name">{t("mail.important")}</span>
            {priorityCounts.important > 0 && (
              <span
                className={`mail-rail-badge${
                  priorityCounts.important_unread > 0 ? " unread" : ""
                }`}
                /* The whole count, not the unread part: a list you file into is
                   not an inbox and does not empty as you read it. Unread only
                   *tones* it, and the tooltip says both numbers so the tone is
                   never the only place a fact lives. */
                title={t("mail.priorityBadgeTitle", {
                  total: priorityCounts.important,
                  unread: priorityCounts.important_unread,
                })}
              >
                {priorityCounts.important}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`mail-priority-chip urgent${
              selectedPriority === "urgent" ? " selected" : ""
            }`}
            onClick={() => void useMailStore.getState().openPriority("urgent")}
          >
            <span className="mail-rail-priority-mark" aria-hidden="true">
              !!
            </span>
            <span className="mail-chip-name">{t("mail.urgent")}</span>
            {priorityCounts.urgent > 0 && (
              <span
                className={`mail-rail-badge${priorityCounts.urgent_unread > 0 ? " unread" : ""}`}
                title={t("mail.priorityBadgeTitle", {
                  total: priorityCounts.urgent,
                  unread: priorityCounts.urgent_unread,
                })}
              >
                {priorityCounts.urgent}
              </span>
            )}
          </button>
          {/* Beside the two lists it fills — a rule is the automatic version of
              the right-click that files a message into exactly these — but as an
              ordinary button rather than a third chip, because it opens a dialog
              and the two beside it open a list. */}
          <button
            type="button"
            className="mail-btn mail-btn-small"
            title={t("mail.filters.title")}
            onClick={() => setFiltersDialog(true)}
          >
            {t("mail.filters.open")}
          </button>
        </div>
      </div>

      <div className="mail-toolbar">
        <span className="mail-toolbar-title">{t("tabKind.mail")}</span>
        <button
          type="button"
          className="mail-btn mail-btn-primary"
          disabled={!selectedAccountId || syncing}
          onClick={() =>
            selectedAccountId &&
            void useMailStore.getState().checkMail(selectedAccountId, selectedFolderId)
          }
        >
          {syncing ? t("mail.checking") : t("mail.checkMail")}
        </button>
        {syncing && selectedAccountId && (
          <button
            type="button"
            className="mail-btn"
            onClick={() => void useMailStore.getState().cancelCheck(selectedAccountId)}
          >
            {t("mail.stopCheck")}
          </button>
        )}
        <button
          type="button"
          className="mail-btn"
          disabled={!selectedAccountId}
          onClick={() => setCompose({ mode: "new" })}
        >
          {t("mail.composeNew")}
        </button>
        {/* The count is *in the label*, not only in a tooltip: this is the one
            control here that acts on messages the user cannot see (the folder,
            not the page), and a button that says how many it is about to touch
            is what makes the click an informed one — the bargain
            `SyncConfirmDialog` strikes, at the weight this action deserves.
            Hidden rather than disabled when there is nothing unread: a greyed
            "Mark all as read (0)" is noise on every already-read folder. */}
        {folderUnread > 0 && selectedFolderId && (
          <button
            type="button"
            className="mail-btn"
            onClick={() =>
              void useMailStore.getState().markFolderRead(selectedFolderId)
            }
          >
            {t("mail.markAllRead", { count: folderUnread })}
          </button>
        )}
        {/* The priority list's counterpart to it, in the same slot and with the
            same shape — the count in the label, hidden rather than disabled when
            there is nothing to clear. It is the only way back to an empty list:
            marks accumulate and are never consumed (a list you file into is not
            an inbox and does not empty as it is read), so without this the way
            out is one right-click per message. */}
        {selectedPriority && priorityListCount > 0 && (
          <>
            <button
              type="button"
              className="mail-btn"
              title={t("mail.clearPriorityTitle")}
              onClick={clearPriorityList}
            >
              {t("mail.clearPriority", { count: priorityListCount })}
            </button>
            <UntestedTag />
          </>
        )}
        {/* Everything to the left of this acts on the selected account or its
            open folder; everything to the right is the mailbox as a whole (the
            local store's key, the keyring). Same split the rail now makes, and
            for the same reason — "Check mail" and "encryption" sitting shoulder
            to shoulder as identical buttons is what made the toolbar read as one
            undifferentiated row of verbs. */}
        <span className="mail-toolbar-sep" aria-hidden="true" />
        <button
          type="button"
          className="mail-btn"
          title={t("mail.encryption.title")}
          onClick={() => setEncryptionDialog(true)}
        >
          {encryption?.active ? "🔒" : "🔓"}
        </button>
        {pgpReady && (
          <button
            type="button"
            className="mail-btn"
            title={t("mail.keys.title")}
            onClick={() => setKeysDialog(true)}
          >
            🔑
          </button>
        )}
        {/* The Mail AI (local) region: a bordered group holding the global
            master switch and — only when it is on — the per-account quick-toggle
            tags plus the ✨ full-settings button. The master switch is the one
            global control; every feature toggle behind the tags is per account. */}
        <div className="mail-ai-toolbar">
          <label className="mail-ai-allow" title={t("mailAi.allowHint")}>
            <span>{t("mailAi.allowToggle")}</span>
            <Toggle
              checked={settings?.mail_ai_allow === true}
              onChange={(e) => void updateSettings({ mail_ai_allow: e.target.checked })}
            />
          </label>
          {mailAiAllowed(settings) && selectedAccount && (
            <>
              <MailAiQuickTags account={selectedAccount} />
              <button
                type="button"
                className="mail-btn"
                title={t("mailAi.settingsTitle")}
                onClick={() => setAiAccountId(selectedAccount.id)}
              >
                ✨
              </button>
            </>
          )}
        </div>
        <div className="mail-toolbar-spacer" />
        {/* The sort is NOT here. It lives on the list's own header row
            (`MailList`), where each control sits above the column it orders —
            the star above the stars, the clip above the clips — so the order is
            read off the thing being ordered rather than off a dropdown at the
            other end of the toolbar. What stays this pane's job is passing the
            store's `sort`/`sortDesc` down and handing the answer back. */}
        <input
          className="mail-input mail-search"
          type="search"
          placeholder={t("mail.searchPlaceholder")}
          value={query}
          disabled={!selectedFolderId && !selectedPriority}
          onChange={(e) => void useMailStore.getState().setQuery(e.target.value)}
        />
      </div>

      {error && (
        <div className="mail-error-strip">
          <span>{error}</span>
          <button
            type="button"
            className="mail-btn"
            onClick={() => useMailStore.getState().setError(null)}
          >
            {t("mail.dismissError")}
          </button>
        </div>
      )}

      {/* The one encryption state that has to interrupt: the store on screen is
          memory-only, so everything synced now is thrown away at exit. It looks
          exactly like a working mailbox, which is why it cannot be left to a
          settings panel nobody opens. An ordinary encrypted (or unencrypted)
          store shows nothing here — a permanent "you are secure" strip is noise
          that trains people to ignore the strip. */}
      {encryption?.ephemeral && (
        <div className="mail-warning-strip">
          <span>
            {encryption.needs_passphrase
              ? t("mail.encryption.bannerLocked")
              : t("mail.encryption.bannerEphemeral")}
          </span>
          <button type="button" className="mail-btn" onClick={() => setEncryptionDialog(true)}>
            {encryption.needs_passphrase
              ? t("mail.encryption.unlock")
              : t("mail.encryption.details")}
          </button>
        </div>
      )}

      {/* A mark nobody made, announced at the moment it happens. The Priority
          group at the top of the rail is where the messages now are — and it is
          on screen right beside this strip — so this says what happened rather
          than offering a button to go and look. It clears itself on the next
          check, like every other sync state. */}
      {syncState?.phase === "done" && (syncState.filtered ?? 0) > 0 && (
        <div className="mail-filter-strip">
          <span>{t("mail.filters.filedNotice", { count: syncState.filtered ?? 0 })}</span>
        </div>
      )}

      <div className="mail-body-row">
        {/* The rail is ONE thing: the folders of the selected account. Its
            heading deliberately does NOT name that account — the header band's
            accounts row above it already carries the selection, and the mailbox
            whose folders these are is the chip that is lit there. A second
            copy of the name here was one more place it could be read from and
            one more place it could disagree. */}
        <div className="mail-rail">
          <div className="mail-rail-title">{t("mail.folders")}</div>
          {folders.length === 0 && <div className="mail-rail-hint">{t("mail.noFolders")}</div>}
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`mail-rail-folder${f.id === selectedFolderId ? " selected" : ""}`}
              onClick={() => void useMailStore.getState().openFolder(f.id)}
            >
              <span className="mail-rail-folder-name">{f.name}</span>
              {f.unread > 0 && <span className="mail-rail-badge">{f.unread}</span>}
            </button>
          ))}
        </div>

        {accountsLoaded && accounts.length === 0 ? (
          <div className="mail-empty mail-empty-wide">
            <strong>{t("mail.noAccounts")}</strong>
            <p>{t("mail.noAccountsHint")}</p>
            <button
              type="button"
              className="mail-btn mail-btn-primary"
              onClick={() => setAccountDialog({ account: null })}
            >
              {t("mail.addAccount")}
            </button>
          </div>
        ) : (
          <>
            <MailList
              headers={headers}
              selectedId={selectedMessageId}
              loading={loadingHeaders}
              onSelect={(id) => void useMailStore.getState().selectMessage(id)}
              onToggleFlag={toggleFlag}
              onToggleSeen={toggleSeen}
              onSetPriority={setPriority}
              sort={sort}
              sortDesc={sortDesc}
              onSort={(next, desc) => void useMailStore.getState().setSort(next, desc)}
              // Only in a priority list: there the rail cannot say which mailbox
              // a row came from, and in a folder it already does.
              {...(selectedPriority ? { accountLabel } : {})}
              offset={headerOffset}
              pageSize={MAIL_PAGE_SIZE}
              total={headerTotal}
              scanned={headerScanned}
              onPage={(offset) => void useMailStore.getState().loadPage(offset)}
            />
            <MailMessageView
              header={selectedHeader}
              body={body}
              loading={loadingBody}
              onReply={(mode) => setCompose({ mode })}
              onComposeTo={(address) => setCompose({ mode: "new", toAddress: address })}
            />
          </>
        )}
      </div>

      {filtersDialog && (
        <MailFiltersDialog accounts={accounts} onClose={() => setFiltersDialog(false)} />
      )}
      {encryptionDialog && encryption && (
        <MailEncryptionDialog
          state={encryption}
          onChanged={setEncryption}
          onClose={() => {
            setEncryptionDialog(false);
            // Re-read rather than trusting the last write: declining records a
            // preference the dialog does not get a state object back from, and a
            // stale `preference === undefined` here would re-open the prompt on
            // the next render — the exact nag the one-time rule forbids.
            void mailEncryptionState().then(setEncryption).catch(() => {});
          }}
        />
      )}

      {keysDialog && (
        <MailKeysDialog
          account={accounts.find((a) => a.id === selectedAccountId) ?? null}
          onClose={() => setKeysDialog(false)}
        />
      )}

      {aiAccount && (
        <MailAiSettingsDialog account={aiAccount} onClose={() => setAiAccountId(null)} />
      )}

      {accountDialog && (
        <MailAccountDialog
          account={accountDialog.account}
          onClose={() => setAccountDialog(null)}
          onSaved={(id) => {
            // Creating a new account? Offer its Mail AI (local) settings right
            // away — the toggles are per account, so a fresh mailbox starts with
            // none set, and the moment to ask is now rather than never. Only when
            // the whole feature is switched on; otherwise there is nothing to set.
            const isNew = accountDialog.account === null;
            setAccountDialog(null);
            void useMailStore
              .getState()
              .reloadAccounts(id)
              .then(() => {
                if (isNew && mailAiAllowed(settings)) setAiAccountId(id);
              });
          }}
          onDelete={(id) => {
            setAccountDialog(null);
            void useMailStore.getState().removeAccount(id);
          }}
        />
      )}
      {compose && selectedAccountId && (
        <MailComposeDialog
          accounts={accounts}
          accountId={selectedAccountId}
          mode={compose.mode}
          toAddress={compose.toAddress}
          {...(selectedHeader ? { source: { header: selectedHeader, body } } : {})}
          onClose={() => setCompose(null)}
        />
      )}
    </div>
  );
}
