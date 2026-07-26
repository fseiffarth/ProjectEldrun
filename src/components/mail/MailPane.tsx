import { useEffect, useState } from "react";
import { MAIL_PAGE_SIZE, unreadTotal, useMailStore } from "../../stores/mail";
import { useSettingsStore } from "../../stores/settings";
import { onMailNew, onMailSync } from "../../lib/mail";
import { useT } from "../../lib/i18n";
import type { MailAccount, MailHeader } from "../../types/mail";
import { MailList } from "./MailList";
import { MailMessageView } from "./MailMessageView";
import { MailAccountDialog } from "./MailAccountDialog";
import { MailComposeDialog, type ComposeMode } from "./MailComposeDialog";

/**
 * The mail tab: folder rail / header list / message view.
 *
 * **It never connects on its own.** Mounting — including the mount a restored
 * tab performs at launch — reads the local index and nothing else; the only path
 * to a socket is the *Check mail* button. That is not politeness: a mail command
 * dispatched from a launch path against an unreachable server would sit on the
 * TCP timeout, and every one of those commands is async precisely because a
 * synchronous one would take the whole WebView down with it.
 *
 * The store is global (one mailbox across every scope), so this pane takes no
 * project props at all — the same shape as `CalendarPane`.
 */
export interface MailPaneProps {
  visible?: boolean;
  /** The main window owns the tab store. Only it announces newly-arrived mail:
   *  a popout runs its own store instance against the same backend, so both
   *  would otherwise report the same delivery twice. */
  ownsTabs?: boolean;
}

export function MailPane({ visible, ownsTabs = false }: MailPaneProps) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);

  const accounts = useMailStore((s) => s.accounts);
  const accountsLoaded = useMailStore((s) => s.accountsLoaded);
  const foldersByAccount = useMailStore((s) => s.foldersByAccount);
  const selectedAccountId = useMailStore((s) => s.selectedAccountId);
  const selectedFolderId = useMailStore((s) => s.selectedFolderId);
  const selectedMessageId = useMailStore((s) => s.selectedMessageId);
  const headers = useMailStore((s) => s.headers);
  const headerTotal = useMailStore((s) => s.headerTotal);
  const headerOffset = useMailStore((s) => s.headerOffset);
  const query = useMailStore((s) => s.query);
  const body = useMailStore((s) => s.body);
  const loadingHeaders = useMailStore((s) => s.loadingHeaders);
  const loadingBody = useMailStore((s) => s.loadingBody);
  const sync = useMailStore((s) => s.sync);
  const error = useMailStore((s) => s.error);

  const [accountDialog, setAccountDialog] = useState<{ account: MailAccount | null } | null>(null);
  const [compose, setCompose] = useState<{ mode: ComposeMode; toAddress?: string } | null>(null);
  const [newMailNote, setNewMailNote] = useState("");

  // Local read only. The default account is a preference, not a connection.
  useEffect(() => {
    void useMailStore.getState().loadAccounts({ preferred: settings?.mail_default_account });
  }, [settings?.mail_default_account]);

  // Progress + arrival events. Installed on mount so a sync started elsewhere
  // (another window, a later background poll) still moves this pane's strip.
  useEffect(() => {
    const offs: Array<() => void> = [];
    // `listen` resolves asynchronously, so an unmount that beats the resolution
    // would otherwise leave the listener installed against a dead component.
    let cancelled = false;
    const keep = (un: () => void) => (cancelled ? un() : offs.push(un));
    void onMailSync((e) => {
      useMailStore.getState().applySyncEvent(e.account_id, {
        phase: e.phase,
        folderId: e.folder_id,
        newMessages: e.new_messages,
        error: e.error,
      });
    }).then(keep);
    void onMailNew((e) => {
      if (!ownsTabs) return;
      setNewMailNote(t("mail.newMail", { count: e.count }));
    }).then(keep);
    return () => {
      cancelled = true;
      offs.forEach((un) => un());
    };
  }, [ownsTabs, t]);

  const folders = selectedAccountId ? (foldersByAccount[selectedAccountId] ?? []) : [];
  const selectedHeader = headers.find((h) => h.id === selectedMessageId);
  const syncState = selectedAccountId ? sync[selectedAccountId] : undefined;
  const syncing = syncState?.phase === "start" || syncState?.phase === "folder" || syncState?.phase === "headers";

  const toggleFlag = (h: MailHeader) =>
    void useMailStore.getState().setFlag(h.id, "flagged", !h.flagged);

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
        <div className="mail-toolbar-spacer" />
        <input
          className="mail-input mail-search"
          type="search"
          placeholder={t("mail.searchPlaceholder")}
          value={query}
          disabled={!selectedFolderId}
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
      {newMailNote && (
        <div className="mail-note-strip">
          <span>{newMailNote}</span>
          <button type="button" className="mail-btn" onClick={() => setNewMailNote("")}>
            {t("mail.dismissError")}
          </button>
        </div>
      )}

      <div className="mail-body-row">
        <div className="mail-rail">
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
              offset={headerOffset}
              pageSize={MAIL_PAGE_SIZE}
              total={headerTotal}
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
