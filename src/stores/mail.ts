import { create } from "zustand";
import {
  mailAccountDelete,
  mailAccountsList,
  mailBody,
  mailFlag,
  mailFolders,
  mailHeaders,
  mailSync,
  mailSyncCancel,
} from "../lib/mail";
import type {
  MailAccount,
  MailBody,
  MailFlag,
  MailFolder,
  MailHeader,
  MailSyncPhase,
} from "../types/mail";

/**
 * The mail client's store: accounts, folders, the header index page, the
 * selected message and its body — one global set, backed by
 * `~/.local/share/eldrun/mail/`.
 *
 * Modeled on `stores/calendar.ts`, and deliberately **global** for the same
 * reason: a mail tab opened from any scope shows the same mailbox, and the tab
 * is a singleton per scope (`ensureTab`) because a second one would show exactly
 * the same thing.
 *
 * Three rules distinguish it from the calendar store, all of them consequences
 * of mail being the app's first *network* store:
 *
 *  1. **Nothing here connects on its own.** `loadAccounts` and `openFolder` read
 *     the local index only; a restored mail tab renders from it and shows a
 *     "Check mail" button. `checkMail` is the only action that reaches a server,
 *     and it is only ever called from a click.
 *  2. **Every action tolerates a rejected invoke.** The backend can be mid-build,
 *     the account can be misconfigured, the server can be unreachable for the
 *     whole TCP timeout — so a failure lands in `error` (and clears `busy`),
 *     never as an unhandled rejection that leaves a pane spinning forever.
 *  3. **Remote content is blocked, with nothing here that can unblock it.** The
 *     backend has no image proxy yet, so there is deliberately no "load remote
 *     content" action to call — one would clear the banner, report success and
 *     fetch nothing. `MailBody.remote_refs` drives a purely informational strip
 *     until that proxy exists (`docs/mail_client_plan_b.md` §2.6).
 */

/** Live progress of a sync, driven by the `mail:sync` event listener. */
export interface MailSyncState {
  phase: MailSyncPhase;
  folderId?: string;
  newMessages?: number;
  error?: string;
}

/** How many headers one page of the list holds. */
export const MAIL_PAGE_SIZE = 100;

interface MailStore {
  accounts: MailAccount[];
  accountsLoaded: boolean;
  /** Folders per account id. Absent = never loaded (not "no folders"). */
  foldersByAccount: Record<string, MailFolder[]>;

  selectedAccountId: string | null;
  selectedFolderId: string | null;
  selectedMessageId: string | null;

  headers: MailHeader[];
  headerTotal: number;
  headerOffset: number;
  query: string;

  body: MailBody | null;
  /** This body was fetched with remote references resolved (an explicit click). */

  loadingHeaders: boolean;
  loadingBody: boolean;
  /** Per-account sync progress, keyed by account id. */
  sync: Record<string, MailSyncState>;
  /** The last thing that went wrong, shown as a dismissible strip. */
  error: string | null;

  setError: (message: string | null) => void;
  /** Adopt a `mail:sync` event. Called by the pane's listener. */
  applySyncEvent: (accountId: string, state: MailSyncState) => void;

  /** Read the account list (local). Safe to call repeatedly. */
  loadAccounts: (opts?: { force?: boolean; preferred?: string }) => Promise<void>;
  /** Re-read after the account dialog wrote. */
  reloadAccounts: (preferred?: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;

  selectAccount: (accountId: string) => Promise<void>;
  /** Load an account's folders. `refresh` hits the server — click paths only. */
  loadFolders: (accountId: string, refresh?: boolean) => Promise<void>;
  openFolder: (folderId: string) => Promise<void>;
  setQuery: (query: string) => Promise<void>;
  loadPage: (offset: number) => Promise<void>;

  selectMessage: (messageId: string | null) => Promise<void>;
  /** Re-fetch the open body with remote references resolved (explicit click). */
  setFlag: (messageId: string, flag: MailFlag, value: boolean) => Promise<void>;

  /** THE network action. Never called from a launch, restore or render path. */
  checkMail: (accountId: string, folderId?: string | null) => Promise<void>;
  cancelCheck: (accountId: string) => Promise<void>;
}

/** A rejected invoke's message, as a string the UI can show. */
function reason(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The folder a freshly-selected account should open on: its inbox, else the
 *  first folder it has, else nothing. */
function defaultFolder(folders: MailFolder[]): MailFolder | undefined {
  return folders.find((f) => f.kind === "inbox") ?? folders[0];
}

export const useMailStore = create<MailStore>((set, get) => ({
  accounts: [],
  accountsLoaded: false,
  foldersByAccount: {},

  selectedAccountId: null,
  selectedFolderId: null,
  selectedMessageId: null,

  headers: [],
  headerTotal: 0,
  headerOffset: 0,
  query: "",

  body: null,

  loadingHeaders: false,
  loadingBody: false,
  sync: {},
  error: null,

  setError: (message) => set({ error: message }),

  applySyncEvent: (accountId, state) =>
    set((s) => ({
      sync: { ...s.sync, [accountId]: state },
      // A sync error is the user's business even though the command may still
      // resolve — the event is what carries the reason.
      error: state.phase === "error" ? (state.error ?? s.error) : s.error,
    })),

  loadAccounts: async (opts) => {
    if (get().accountsLoaded && !opts?.force) return;
    await get().reloadAccounts(opts?.preferred);
  },

  reloadAccounts: async (preferred) => {
    const accounts = await mailAccountsList().catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    if (!accounts) {
      // Still "loaded": the pane must render its empty state and its retry, not
      // sit on a spinner forever because the backend refused once.
      set({ accountsLoaded: true });
      return;
    }
    const current = get().selectedAccountId;
    const keep =
      (preferred && accounts.some((a) => a.id === preferred) && preferred) ||
      (current && accounts.some((a) => a.id === current) && current) ||
      accounts[0]?.id ||
      null;
    set({ accounts, accountsLoaded: true });
    if (keep && keep !== current) {
      await get().selectAccount(keep);
    } else if (!keep) {
      set({ selectedAccountId: null, selectedFolderId: null, headers: [], body: null });
    }
  },

  removeAccount: async (accountId) => {
    await mailAccountDelete(accountId).catch((err) => set({ error: reason(err) }));
    set((s) => {
      const folders = { ...s.foldersByAccount };
      delete folders[accountId];
      return { foldersByAccount: folders };
    });
    await get().reloadAccounts();
  },

  selectAccount: async (accountId) => {
    set({
      selectedAccountId: accountId,
      selectedFolderId: null,
      selectedMessageId: null,
      headers: [],
      headerTotal: 0,
      headerOffset: 0,
      body: null,
        });
    // Local read only — `refresh: false`. Opening an account must never dial out.
    await get().loadFolders(accountId, false);
    const folder = defaultFolder(get().foldersByAccount[accountId] ?? []);
    if (folder) await get().openFolder(folder.id);
  },

  loadFolders: async (accountId, refresh = false) => {
    const folders = await mailFolders(accountId, refresh).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    if (!folders) return;
    set((s) => ({ foldersByAccount: { ...s.foldersByAccount, [accountId]: folders } }));
  },

  openFolder: async (folderId) => {
    set({
      selectedFolderId: folderId,
      selectedMessageId: null,
      body: null,
          headerOffset: 0,
    });
    await get().loadPage(0);
  },

  setQuery: async (query) => {
    set({ query, headerOffset: 0 });
    await get().loadPage(0);
  },

  loadPage: async (offset) => {
    const { selectedFolderId, query } = get();
    if (!selectedFolderId) {
      set({ headers: [], headerTotal: 0 });
      return;
    }
    set({ loadingHeaders: true });
    const page = await mailHeaders(
      selectedFolderId,
      offset,
      MAIL_PAGE_SIZE,
      query.trim() || null,
    ).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    set({
      loadingHeaders: false,
      ...(page ? { headers: page.items, headerTotal: page.total, headerOffset: offset } : {}),
    });
  },

  selectMessage: async (messageId) => {
    if (!messageId) {
      set({ selectedMessageId: null, body: null });
      return;
    }
    // Every message starts with remote content blocked, whatever the last one did.
    set({ selectedMessageId: messageId, body: null, loadingBody: true });
    const body = await mailBody(messageId, false).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    // A slower body for a message the user already navigated away from must not
    // overwrite the one now on screen.
    if (get().selectedMessageId !== messageId) return;
    set({ loadingBody: false, body });
    // Reading a message marks it seen locally and on the server; a failure there
    // is not worth a banner, but the list must not lie about it either.
    const header = get().headers.find((h) => h.id === messageId);
    if (header && !header.seen) await get().setFlag(messageId, "seen", true);
  },

  setFlag: async (messageId, flag, value) => {
    // Patch locally first: a flag is a UI affordance and the server round-trip is
    // slow enough that waiting for it reads as a broken click.
    set((s) => ({
      headers: s.headers.map((h) =>
        h.id === messageId
          ? {
              ...h,
              ...(flag === "seen" ? { seen: value } : {}),
              ...(flag === "flagged" ? { flagged: value } : {}),
              ...(flag === "answered" ? { answered: value } : {}),
            }
          : h,
      ),
    }));
    await mailFlag(messageId, flag, value).catch((err) => set({ error: reason(err) }));
  },

  checkMail: async (accountId, folderId) => {
    set((s) => ({
      error: null,
      sync: { ...s.sync, [accountId]: { phase: "start" } },
    }));
    const summary = await mailSync(accountId, folderId ?? null).catch((err) => {
      set((s) => ({
        error: reason(err),
        sync: { ...s.sync, [accountId]: { phase: "error", error: reason(err) } },
      }));
      return null;
    });
    if (!summary) return;
    set((s) => ({
      sync: {
        ...s.sync,
        [accountId]: summary.error
          ? { phase: "error", error: summary.error }
          : { phase: "done", newMessages: summary.new_messages },
      },
      ...(summary.error ? { error: summary.error } : {}),
    }));
    // The folder list's unread counts moved, and so did the open page.
    await get().loadFolders(accountId, false);
    if (get().selectedAccountId === accountId) await get().loadPage(get().headerOffset);
  },

  cancelCheck: async (accountId) => {
    await mailSyncCancel(accountId).catch((err) => set({ error: reason(err) }));
    set((s) => ({ sync: { ...s.sync, [accountId]: { phase: "done" } } }));
  },
}));

/** The account a mail tab should open on: the configured default when it still
 *  exists, else the first. Kept here so the pane and any later surface agree. */
export function preferredAccountId(
  accounts: MailAccount[],
  defaultId: string | undefined,
): string | null {
  if (defaultId && accounts.some((a) => a.id === defaultId)) return defaultId;
  return accounts[0]?.id ?? null;
}

/** Total unread across an account's folders, for the rail's badge. */
export function unreadTotal(folders: MailFolder[] | undefined): number {
  return (folders ?? []).reduce((sum, f) => sum + (f.unread || 0), 0);
}
