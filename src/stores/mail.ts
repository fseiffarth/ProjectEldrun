import { create } from "zustand";
import {
  mailAccountDelete,
  mailAccountsList,
  mailBody,
  mailFlag,
  mailFolders,
  mailHeaders,
  mailMarkFolderRead,
  mailPriorityCounts,
  mailPriorityPage,
  mailPrioritySet,
  mailSync,
  mailSyncCancel,
} from "../lib/mail";
import type {
  MailAccount,
  MailBody,
  MailFlag,
  MailFolder,
  MailHeader,
  MailPriority,
  MailPriorityCounts,
  MailSort,
  MailSyncPhase,
} from "../types/mail";

/**
 * The mail client's store: accounts, folders, the header index page, the
 * selected message and its body — one global set, backed by
 * `~/.local/share/eldrun/mail/`.
 *
 * Modeled on `stores/calendar.ts`, and deliberately **global** — one mailbox, no
 * matter which project is active. That is also what retired the mail *tab*: a tab
 * belongs to a scope, so a mail tab could only ever show the same mailbox this
 * store already holds while behaving as though it belonged to a project you then
 * switched away from. The single surface is the header overlay
 * (`MailOverlayHost`), and this store is what makes it stateful across it.
 *
 * Three rules distinguish it from the calendar store, all of them consequences
 * of mail being the app's first *network* store:
 *
 *  1. **Nothing here connects on its own.** `loadAccounts` and `openFolder` read
 *     the local index only; opening the overlay renders from it and shows a
 *     "Check mail" button. `checkMail` is the only action that reaches a server.
 *     It is called from a click — with exactly one exception, and that one is an
 *     opt-in: the header's mail button (`MailIndicator`) runs it on a timer once
 *     `mail_client` is on — off for everyone outside debug mode, which is what
 *     keeps this rule true by default. Nothing else, and nothing at launch,
 *     ever starts it. The header's unread badge is *not* an exception: it is
 *     derived from the local folder counts (`refreshUnread`), so it can be right
 *     at launch without anything dialling out.
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
  /**
   * The priority list currently on screen, or `null` when an ordinary folder is.
   *
   * These are the two states of ONE list: `selectedPriority` and
   * `selectedFolderId` are mutually exclusive, and every read path checks this
   * one first (`loadPage`). Modeling the Important list as a pseudo-*folder* id
   * was the obvious alternative and it is wrong — a folder id is passed to
   * `mail_headers`, `mail_mark_folder_read` and `mail_move`, all of which resolve
   * it against the store and would fail (or worse, half-succeed) on a name no
   * folder has. A separate field makes the two impossible to confuse.
   */
  selectedPriority: MailPriority | null;
  /** Both rail badges, read together. Zeroes until the first refresh — this is a
   *  local read, so it costs no socket and runs whenever the overlay opens. */
  priorityCounts: MailPriorityCounts;

  headers: MailHeader[];
  headerTotal: number;
  /** Set only when a search over an encrypted store stopped at its scan bound;
   *  see `MailHeaderPage.scanned`. Cleared on every page that covered its whole
   *  scope, so a stale note can never outlive the search that produced it. */
  headerScanned?: number;
  headerOffset: number;
  query: string;
  /** What the list is ordered by, and in which direction. Kept here rather than
   *  in the list component because the backend does the ordering — see
   *  `setSort` for why that is not an implementation detail. */
  sort: MailSort;
  sortDesc: boolean;

  body: MailBody | null;
  /** This body was fetched with remote references resolved (an explicit click). */

  loadingHeaders: boolean;
  loadingBody: boolean;
  /** Per-account sync progress, keyed by account id. */
  sync: Record<string, MailSyncState>;
  /** The last thing that went wrong, shown as a dismissible strip. */
  error: string | null;

  /** The header button's mail overlay is on screen — the only mail surface
   *  there is, since the mail tab was retired (`RETIRED_TAB_CMDS`). */
  overlayOpen: boolean;
  /** Inbox messages that arrived since the overlay was last opened. Kept as the
   *  *emphasis* signal only — the header dot's number is `inboxUnread`, which
   *  survives a relaunch and falls as mail is read. This one is what still
   *  distinguishes "something turned up while you were working" from a backlog,
   *  and it is why an arrival refreshes the counts rather than being counted. */
  newCount: number;

  setError: (message: string | null) => void;
  /** Adopt a `mail:sync` event. Called by the pane's listener. */
  applySyncEvent: (accountId: string, state: MailSyncState) => void;

  /** Adopt a `mail:new` event. Installed once per window by `MailIndicator`, so
   *  it sees whatever caused the sync — a click in the overlay, a click in a
   *  mail tab, or the opt-in interval check. It re-reads the account's folder
   *  counts (local) rather than incrementing a number of its own: the badge is
   *  derived from those counts, and a sync path that forgot to reload them
   *  would otherwise leave the dot a message behind. */
  noteArrival: (accountId: string, count: number) => void;
  openOverlay: () => void;
  closeOverlay: () => void;

  /** Read every account's folder counts from the local index — no socket. What
   *  the header's unread badge needs before any mail surface has been opened,
   *  and the one thing `loadAccounts` alone does not give it. */
  refreshUnread: () => Promise<void>;

  /** Read the account list (local). Safe to call repeatedly. */
  loadAccounts: (opts?: { force?: boolean; preferred?: string }) => Promise<void>;
  /** Re-read after the account dialog wrote. */
  reloadAccounts: (preferred?: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;

  selectAccount: (accountId: string) => Promise<void>;
  /** Load an account's folders. `refresh` hits the server — click paths only. */
  loadFolders: (accountId: string, refresh?: boolean) => Promise<void>;
  openFolder: (folderId: string) => Promise<void>;
  /** Show the Important or Urgent list — every account's marked mail in one
   *  place. Local read, like `openFolder`; clears the folder selection, since
   *  the two are the same list in two states. */
  openPriority: (priority: MailPriority) => Promise<void>;
  /** Mark — or with `null`, unmark — one message. The right-click action.
   *  Reaches no server (`MailPriority`), so this is safe from any path. */
  setPriority: (messageId: string, priority: MailPriority | null) => Promise<void>;
  /** Re-read both badge counts (local). */
  refreshPriorityCounts: () => Promise<void>;
  setQuery: (query: string) => Promise<void>;
  /**
   * Re-order the list. Re-reads page 1 rather than re-sorting what is on
   * screen: the order is the *store's*, over the whole folder, so "largest
   * first" reaches the 40 MB mail from two years ago instead of the largest of
   * the hundred newest — which is what a component-side sort would have given.
   *
   * Sending the offset along would be worse than useless: row 200 of a
   * date-sorted folder has nothing to do with row 200 of a size-sorted one, so
   * a re-sort that kept the page number would land somewhere arbitrary.
   */
  setSort: (sort: MailSort, desc: boolean) => Promise<void>;
  loadPage: (offset: number) => Promise<void>;

  selectMessage: (messageId: string | null) => Promise<void>;
  /** Re-fetch the open body with remote references resolved (explicit click). */
  setFlag: (messageId: string, flag: MailFlag, value: boolean) => Promise<void>;
  /** Mark every unread message in a folder read, locally and on the server.
   *  Reaches a socket — a click path only, like `checkMail`. */
  markFolderRead: (folderId: string) => Promise<void>;

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
  selectedPriority: null,
  priorityCounts: { important: 0, urgent: 0, important_unread: 0, urgent_unread: 0 },

  headers: [],
  headerTotal: 0,
  headerOffset: 0,
  query: "",
  sort: "date",
  sortDesc: true,

  body: null,

  loadingHeaders: false,
  loadingBody: false,
  sync: {},
  error: null,

  overlayOpen: false,
  newCount: 0,

  setError: (message) => set({ error: message }),

  noteArrival: (accountId, count) => {
    set((s) => ({
      // Opening the overlay is what acknowledges an arrival, so mail that lands
      // while it is already on screen is read, not announced — a badge on a
      // button the user is looking through would have to be dismissed by hand.
      newCount: s.overlayOpen ? 0 : s.newCount + Math.max(0, count),
    }));
    // The count the badge actually shows lives in the folder rows the sync just
    // wrote. `checkMail` reloads them too, but an arrival can also come from a
    // sync this window did not start, and that path has to move the dot as well.
    void get().loadFolders(accountId, false);
  },

  openOverlay: () => {
    set({ overlayOpen: true, newCount: 0 });
    // Opening mail does not mark anything read, so the badge deliberately stays
    // — but the pane is about to show folder rows, and both should agree.
    void get().refreshUnread();
    // The rail's Important/Urgent badges, likewise local and likewise needed
    // before anything is clicked.
    void get().refreshPriorityCounts();
  },
  closeOverlay: () => set({ overlayOpen: false }),

  refreshUnread: async () => {
    await get().loadAccounts();
    const { accounts } = get();
    await Promise.all(accounts.map((a) => get().loadFolders(a.id, false)));
  },

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
    } else {
      // Same account still selected, so nothing above refetched anything — but
      // an account edit can change what the *already-loaded* headers mean.
      // `authserv_id` is the case: the backend attaches the SPF/DKIM/DMARC trust
      // state per read (`serve_auth_state`), so headers fetched before the edit
      // carry the old verdicts until something asks for them again. Without
      // this, setting or clearing the trusted server name appears to do nothing
      // until you switch folders — at precisely the moment the user is trying
      // to see whether their change took effect.
      await get().loadPage(get().headerOffset);
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
      // Picking an account leaves the cross-account list. It has to: the list
      // that follows is one account's, and leaving this set would make `loadPage`
      // keep serving every account's marked mail under an account heading.
      selectedPriority: null,
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
      // Exclusive with the priority list — see `selectedPriority`.
      selectedPriority: null,
      selectedMessageId: null,
      body: null,
          headerOffset: 0,
    });
    await get().loadPage(0);
  },

  openPriority: async (priority) => {
    // The folder selection is dropped, not remembered: a list spanning every
    // account has no folder, and a stale one would leave the rail highlighting a
    // folder whose mail is not what is on screen. The *account* selection stays,
    // because the rail still needs an account expanded to show folders under —
    // and because leaving the list puts you back where you were.
    set({
      selectedPriority: priority,
      selectedFolderId: null,
      selectedMessageId: null,
      body: null,
      headerOffset: 0,
    });
    await get().loadPage(0);
  },

  setPriority: async (messageId, priority) => {
    // Patch on screen first, for `setFlag`'s reason — except that here the local
    // write IS the whole operation, so the optimism is only about the IPC hop.
    set((s) => ({
      headers: s.headers.map((h) =>
        h.id === messageId ? { ...h, ...(priority ? { priority } : { priority: undefined }) } : h,
      ),
    }));
    const ok = await mailPrioritySet(messageId, priority).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    // A `false` means the message is no longer in the index — the row on screen
    // is stale, and the optimistic patch above just told the user otherwise.
    if (ok === false) set({ error: "That message is no longer in the local index." });
    await get().refreshPriorityCounts();
    // Unmarking from *inside* a priority list removes the row from that list, so
    // the page has to be re-read; nothing else here changes what a folder shows.
    if (get().selectedPriority) await get().loadPage(get().headerOffset);
  },

  refreshPriorityCounts: async () => {
    const counts = await mailPriorityCounts().catch(() => null);
    // Deliberately silent on failure: this is a badge, and a red error strip
    // because two numbers could not be counted would be worse than no numbers.
    if (counts) set({ priorityCounts: counts });
  },

  setQuery: async (query) => {
    set({ query, headerOffset: 0 });
    await get().loadPage(0);
  },

  setSort: async (sort, desc) => {
    set({ sort, sortDesc: desc, headerOffset: 0 });
    await get().loadPage(0);
  },

  loadPage: async (offset) => {
    const { selectedFolderId, selectedPriority, query, sort, sortDesc } = get();
    if (!selectedFolderId && !selectedPriority) {
      set({ headers: [], headerTotal: 0, headerScanned: undefined });
      return;
    }
    set({ loadingHeaders: true });
    // The ONE fork between a folder and a priority list, and it is deliberately
    // here rather than in the pane: the two commands take the same paging, query
    // and sort, so everything downstream — the list, the pager, the search box,
    // the list's sort headers — stays one code path that does not know which it
    // is showing.
    const page = await (selectedPriority
      ? mailPriorityPage(selectedPriority, offset, MAIL_PAGE_SIZE, query.trim() || null, sort, sortDesc)
      : mailHeaders(
          selectedFolderId as string,
          offset,
          MAIL_PAGE_SIZE,
          query.trim() || null,
          sort,
          sortDesc,
        )
    ).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    set({
      loadingHeaders: false,
      ...(page
        ? {
            headers: page.items,
            headerTotal: page.total,
            headerScanned: page.scanned,
            headerOffset: offset,
          }
        : {}),
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
    const accountId = get().headers.find((h) => h.id === messageId)?.account_id;
    await mailFlag(messageId, flag, value).catch((err) => set({ error: reason(err) }));
    // Reading a message is the ordinary way the unread badge goes *down*, and
    // the backend has already recounted the folder — so re-read it (local). Only
    // `seen` moves a count; a flag or an answered marker leaves it alone.
    if (flag === "seen" && accountId) await get().loadFolders(accountId, false);
  },

  markFolderRead: async (folderId) => {
    const accountId = Object.entries(get().foldersByAccount).find(([, fs]) =>
      fs?.some((f) => f.id === folderId),
    )?.[0];
    // Patch the open page first, for `setFlag`'s reason: the backend writes its
    // own index before it touches the server, so waiting for a round trip would
    // leave every row on screen looking untouched for the length of it.
    set((s) => ({
      headers: s.headers.map((h) => (h.folder_id === folderId ? { ...h, seen: true } : h)),
    }));
    const changed = await mailMarkFolderRead(folderId).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    // The counts are re-read even when the command failed. The backend marks
    // locally *before* it reaches the server and reports the refusal, so a
    // rejected invoke does not mean nothing changed — re-reading is what keeps
    // the rail and the header badge agreeing with the index either way.
    if (accountId) await get().loadFolders(accountId, false);
    if (changed !== null && get().selectedFolderId === folderId) {
      await get().loadPage(get().headerOffset);
    }
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

/**
 * The number in the header button's red dot: unread mail in the **inboxes**,
 * summed across every account.
 *
 * Inbox-only on purpose. The rail's per-account badge counts every folder,
 * because there you are looking at the folder list and can see where the mail
 * is; a single number in the header cannot say that, and folders that are not
 * the inbox are where a filter has already dealt with something — a mailing
 * list nobody reads would otherwise hold the dot lit forever, which is the one
 * failure mode that teaches a user to ignore a badge.
 *
 * Derived rather than accumulated, so it is right the moment the app starts
 * (mail that arrived while Eldrun was closed is in the index and therefore in
 * this number), it survives a relaunch, and it falls as messages are read
 * instead of needing to be dismissed.
 */
export function inboxUnread(byAccount: Record<string, MailFolder[]>): number {
  let sum = 0;
  for (const folders of Object.values(byAccount)) {
    for (const f of folders ?? []) {
      if (f.kind === "inbox") sum += f.unread || 0;
    }
  }
  return sum;
}
