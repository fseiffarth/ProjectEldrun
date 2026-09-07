import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { readFileText, useFileScope } from "./fileAccess";
import {
  buildMdGraph,
  layoutMdGraph,
  type MdGraph,
} from "../../lib/viewers/mdGraph";

/**
 * The markdown relationship graph (opt-in behind the `md_graph` experimental
 * flag): the "Graph" mode of `MarkdownView`. Renders the link graph
 * `lib/viewers/mdGraph.ts` crawls from the viewed document — markdown files as
 * crawled nodes, every other linked file as a leaf, a link the crawl could not
 * read marked as missing — laid out on concentric BFS rings. Clicking any node
 * except the viewed document opens that file through the same `openLinkedFile`
 * routing an ordinary preview link uses (the `onOpen` callback), so the graph
 * is a second way to *navigate* the links, not a second link semantics.
 *
 * Reads ride `readFileText` with the pane's project scope, so a link pointing
 * outside the confinement renders as unreadable rather than being read. The
 * crawl is one bounded pass per mount/rebuild — no polling — which keeps a
 * remote (SFTP-backed) project's cost at one read per markdown node, only when
 * the user asks for the graph.
 */
export function MdGraphView({
  path,
  onOpen,
}: {
  path: string;
  onOpen: (target: string) => void;
}) {
  const t = useT();
  const scope = useFileScope();
  const [graph, setGraph] = useState<MdGraph | null>(null);
  const [building, setBuilding] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBuilding(true);
    void buildMdGraph(path, (p) => readFileText(p, scope).catch(() => null))
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .finally(() => {
        if (!cancelled) setBuilding(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, scope, nonce]);

  const layout = useMemo(() => (graph ? layoutMdGraph(graph) : null), [graph]);

  if (building && !graph) {
    return <div className="file-viewer-loading">{t("mdGraph.building")}</div>;
  }
  if (!graph || !layout) return null;

  const start = graph.start;

  return (
    <div className="md-graph">
      <div className="md-graph-toolbar">
        <button
          className="md-graph-refresh"
          onClick={() => setNonce((n) => n + 1)}
          title={t("mdGraph.refresh")}
          disabled={building}
        >
          ↻
        </button>
        <span className="md-graph-hint">
          {graph.nodes.length <= 1
            ? t("mdGraph.empty")
            : graph.truncated
              ? t("mdGraph.truncated", { count: graph.nodes.length })
              : t("mdGraph.hint")}
        </span>
      </div>
      {graph.nodes.length > 1 && (
        <div className="md-graph-scroll">
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
          >
            {graph.edges.map((e) => {
              const from = layout.positions.get(e.from);
              const to = layout.positions.get(e.to);
              if (!from || !to) return null;
              return (
                <line
                  key={`${e.from}→${e.to}`}
                  className="md-graph-edge"
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                />
              );
            })}
            {graph.nodes.map((n) => {
              const pos = layout.positions.get(n.path);
              if (!pos) return null;
              const isStart = n.path === start;
              return (
                <g
                  key={n.path}
                  className={`md-graph-node md-graph-node-${n.kind}${
                    isStart ? " md-graph-node-current" : ""
                  }`}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onClick={isStart ? undefined : () => onOpen(n.path)}
                >
                  <title>{n.path}</title>
                  <circle r={isStart ? 13 : 9} />
                  <text y={isStart ? 30 : 24} textAnchor="middle">
                    {n.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
