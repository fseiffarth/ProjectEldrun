import { useEffect, useMemo, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageList } from "../../../lib/viewers/pageModel";
import type { TextItemBox } from "../../../lib/viewers/tex";
import type { PdfSources } from "./pdfDoc";
import { pageTextItemBoxes } from "./pageText";

/** Extraction belongs to a document object, page and rotation, never a filename. */
export function useSearchText(pages: PageList, sources: PdfSources, active: boolean) {
  const cache = useMemo(() => new WeakMap<PDFDocumentProxy, Map<string, Promise<TextItemBox[]>>>(), []);
  const key = useMemo(() => pages.map((r) => `${r.src}:${r.page}:${r.rot}`).join("|"), [pages]);
  const [result, setResult] = useState<{ key: string; sources: PdfSources; texts: TextItemBox[][] } | null>(null);
  useEffect(() => {
    if (!active || !pages.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const texts: TextItemBox[][] = [];
        for (let i = 0; i < pages.length && !cancelled; i += 2) {
          const done = await Promise.all(pages.slice(i, i + 2).map((ref) => {
            const doc = sources.get(ref.src)?.doc;
            if (!doc) return Promise.resolve([]);
            let entries = cache.get(doc);
            if (!entries) { entries = new Map(); cache.set(doc, entries); }
            const pageKey = `${ref.page}:${ref.rot}`;
            let work = entries.get(pageKey);
            if (!work) {
              work = pageTextItemBoxes(doc, ref.page, ref.rot);
              entries.set(pageKey, work);
              void work.catch(() => entries!.delete(pageKey));
            }
            return work;
          }));
          texts.push(...done);
        }
        if (!cancelled) setResult({ key, sources, texts });
      } catch {
        if (!cancelled) setResult({ key, sources, texts: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [pages, sources, active, key, cache]);
  return result?.key === key && result.sources === sources ? result.texts : null;
}
