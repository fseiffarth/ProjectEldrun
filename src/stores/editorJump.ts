import { create } from "zustand";

/**
 * Cross-tab "jump to this source line" channel for SyncTeX reverse search.
 *
 * Clicking a point in a PDF resolves (via `synctex edit`) to a source file +
 * line. The source tab may already be open — `openLinkedFile` re-activates it
 * rather than mounting a fresh component — so we cannot pass the target line as
 * a prop. Instead the PDF side posts a request here keyed by the absolute source
 * path, and the editor (`TexView`/`TextView`) for that path consumes it: a
 * `nonce` makes a repeat jump to the same line still fire.
 */
export interface JumpRequest {
  line: number;
  /** 1-based source column from SyncTeX (0 when none was reported). */
  column: number;
  nonce: number;
}

interface EditorJumpStore {
  requestsByPath: Record<string, JumpRequest>;
  /** Ask the editor showing `path` to move the caret to (1-based) `line`/
   *  `column`. `column` 0 means "line start" (SyncTeX reported no column). */
  requestJump: (path: string, line: number, column?: number) => void;
  /** Clear the pending request for `path` once the editor has applied it. */
  consume: (path: string) => void;
}

export const useEditorJumpStore = create<EditorJumpStore>((set) => ({
  requestsByPath: {},
  requestJump: (path, line, column = 0) =>
    set((s) => {
      const prev = s.requestsByPath[path];
      return {
        requestsByPath: {
          ...s.requestsByPath,
          [path]: { line, column, nonce: (prev?.nonce ?? 0) + 1 },
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
