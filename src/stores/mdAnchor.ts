import { create } from "zustand";

/**
 * Cross-tab "scroll to this heading" channel for markdown link-following.
 *
 * A markdown link may carry a fragment (`docs/guide.md#setup`). The click opens
 * the target file through `openLinkedFile`, which either mounts a fresh
 * `MarkdownView` or re-activates one that is already open — so the fragment
 * cannot ride as a prop. Mirroring `stores/editorJump` (SyncTeX's identical
 * problem for line targets), the clicking side posts the fragment here keyed by
 * the target's absolute path, and the `MarkdownView` for that path consumes it
 * once its preview is rendered. A `nonce` makes a repeat click on the same link
 * fire again.
 *
 * Deliberately window-local (no Tauri broadcast, unlike editorJump):
 * `openLinkedFile` routes into the clicking tab's own window, so the consumer
 * is always in the same webview as the producer.
 */
export interface MdAnchorRequest {
  /** The raw text after `#` in the authored href (still percent-encoded). */
  fragment: string;
  nonce: number;
}

interface MdAnchorStore {
  requestsByPath: Record<string, MdAnchorRequest>;
  /** Ask the markdown preview showing `path` to scroll to `fragment`. */
  requestAnchor: (path: string, fragment: string) => void;
  /** Clear the pending request for `path` once the preview has handled it. */
  consume: (path: string) => void;
}

export const useMdAnchorStore = create<MdAnchorStore>((set) => ({
  requestsByPath: {},
  requestAnchor: (path, fragment) =>
    set((s) => {
      const prev = s.requestsByPath[path];
      return {
        requestsByPath: {
          ...s.requestsByPath,
          [path]: { fragment, nonce: (prev?.nonce ?? 0) + 1 },
        },
      };
    }),
  consume: (path) =>
    set((s) => {
      if (!(path in s.requestsByPath)) return {};
      const next = { ...s.requestsByPath };
      delete next[path];
      return { requestsByPath: next };
    }),
}));
