/**
 * Mount a {@link PageStrip} into a plain DOM element.
 *
 * The print preview (`lib/viewers/print`) is an imperative DOM modal — an iframe, an
 * options row and a stylesheet injected into the previewed document — and it is
 * heavily tuned around WebKitGTK's missing `@page` margin box. Rewriting it in React
 * to share the strip would risk all of that for no benefit, so instead it keeps its
 * chrome and hands this adapter the one box the strip lives in.
 *
 * The result: the print strip and the PDF viewer's page rail are the same component,
 * over the same arrangement model, with no React rewrite of the print modal.
 */
import { createRoot, type Root } from "react-dom/client";
import { PageStrip, type PageStripProps } from "./PageStrip";

export interface MountedPageStrip {
  /** Re-render with new props (a fresh arrangement, new badges…). */
  update: (props: PageStripProps) => void;
  /** Unmount and release the React root. */
  destroy: () => void;
}

export function mountPageStrip(
  container: HTMLElement,
  props: PageStripProps,
): MountedPageStrip {
  const root: Root = createRoot(container);
  root.render(<PageStrip {...props} />);
  return {
    update: (next) => root.render(<PageStrip {...next} />),
    // Unmounting synchronously from inside a React lifecycle would warn; the print
    // modal tears down from a DOM event, never mid-render, so a microtask is enough
    // to stay clear of any in-flight render.
    destroy: () => queueMicrotask(() => root.unmount()),
  };
}
