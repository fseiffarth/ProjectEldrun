import { useEffect, useState } from "react";
import { MAIL_PAGE_SIZE, unreadTotal, useMailStore } from "../../stores/mail";
import { useSettingsStore } from "../../stores/settings";
import { onMailSync } from "../../lib/mail";
import { useT } from "../../lib/i18n";
import type { MailAccount, MailHeader, MailPriority } from "../../types/mail";
import { MailList } from "./MailList";
import { MailMessageView } from "./MailMessageView";
import { MailAccountDialog } from "./MailAccountDialog";
import { MailComposeDialog, type ComposeMode } from "./MailComposeDialog";
import { MailEncryptionDialog } from "./MailEncryptionDialog";
import { MailKeysDialog } from "./MailKeysDialog";
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
  // The key surface is offered only where it can work: the keyring needs the
  // local store encrypted, and a button that always fails with the same sentence
  // is worse than one that is not there until the precondition is met.
  const [keysDialog, setKeysDialog] = useState(false);
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

  return (
    /* Hidden by style, not by the `hidden` attribute: `.mail-pane` sets
       `display: flex`, which would override the UA's `[hidden] { display: none }`
       and leave the pane painted on top of its sibling. Same shape as
       `CalendarPane`. */
    <div className="mail-pane" style={{ display: visible === false ? "none" : undefined }}>
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

      <div className="mail-body-row">
        <div className="mail-rail">
          {/* Above Accounts, and outside them, because that is what these two
              lists ARE: mail from every account in one place. Nesting them under
              an account would say the opposite of what they do. Rendered
              unconditionally rather than only when something is marked — an
              empty Important list is where you learn the feature exists, and a
              section that appears only after you have used it cannot teach it. */}
          <div className="mail-rail-title">{t("mail.priority")}</div>
          <button
            type="button"
            className={`mail-rail-folder mail-rail-priority important${
              selectedPriority === "important" ? " selected" : ""
            }`}
            onClick={() => void useMailStore.getState().openPriority("important")}
          >
            <span className="mail-rail-folder-name">{t("mail.important")}</span>
            {priorityCounts.important > 0 && (
              <span
                className={`mail-rail-badge${
                  priorityCounts.important_unread > 0 ? " unread" : ""
                }`}
                /* The badge is the whole count, not the unread part: a list you
                   file into is not an inbox and does not empty as you read it.
                   Unread only *tones* it, and the tooltip says both numbers so
                   the tone is never the only place a fact lives. */
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
            className={`mail-rail-folder mail-rail-priority urgent${
              selectedPriority === "urgent" ? " selected" : ""
            }`}
            onClick={() => void useMailStore.getState().openPriority("urgent")}
          >
            <span className="mail-rail-folder-name">{t("mail.urgent")}</span>
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

          <div className="mail-rail-title">{t("mail.accounts")}</div>
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`mail-rail-account${a.id === selectedAccountId ? " selected" : ""}`}
              onClick={() => void useMailStore.getState().selectAccount(a.id)}
              onDoubleClick={() => setAccountDialog({ account: a })}
            >
              <span className="mail-rail-account-name">{a.label || a.address}</span>
              {unreadTotal(foldersByAccount[a.id]) > 0 && (
                <span className="mail-rail-badge">{unreadTotal(foldersByAccount[a.id])}</span>
              )}
            </button>
          ))}
          <button
            type="button"
            className="mail-btn mail-rail-add"
            onClick={() => setAccountDialog({ account: null })}
          >
            {t("mail.addAccount")}
          </button>
          {selectedAccountId && (
            <button
              type="button"
              className="mail-btn mail-rail-add"
              onClick={() =>
                setAccountDialog({
                  account: accounts.find((a) => a.id === selectedAccountId) ?? null,
                })
              }
            >
              {t("mail.editAccount")}
            </button>
          )}

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

      {accountDialog && (
        <MailAccountDialog
          account={accountDialog.account}
          onClose={() => setAccountDialog(null)}
          onSaved={(id) => {
            setAccountDialog(null);
            void useMailStore.getState().reloadAccounts(id);
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
