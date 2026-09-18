import { useState } from "react";
import { edgeCommandChoices, toggleEdgeCommand } from "../../lib/agents/prompt/links";
import { useT } from "../../lib/i18n";
import type { PromptLink } from "../../stores/agents/agentPrompts";
import { ContextMenuPortal } from "../common/ContextMenuPortal";

interface Props {
  link: PromptLink;
  /** Short readings of the two cards the edge joins. */
  fromLabel: string;
  toLabel: string;
  /** The tab an `after` edge queues its target on, when it is open. */
  tabLabel?: string;
  /** That tab's agent's own prefix commands (`lib/agents/agentPrefaces`). */
  offered: string[];
  x: number;
  y: number;
  onChange: (patch: Pick<PromptLink, "kind" | "preface">) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
}

/**
 * What an edge between two cards does, edited on the edge itself. An `after`
 * edge can carry the target agent's own commands — `/clear` between two
 * scheduled prompts — which ride as the queued prompt's preface and are typed
 * one at a time before it, exactly like the composer's prefix chips. Every
 * toggle writes at once: a popover with a Save button is one more way to lose
 * a change.
 */
export function PromptLinkEditor({ link, fromLabel, toLabel, tabLabel, offered, x, y, onChange, onRemove, onClose }: Props) {
  const t = useT();
  const [error, setError] = useState("");
  const preface = link.preface ?? [];
  const choices = edgeCommandChoices(offered, preface);
  const write = (patch: Pick<PromptLink, "kind" | "preface">) => {
    setError("");
    void onChange(patch).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  return (
    <ContextMenuPortal x={x} y={y} onClose={onClose} className="context-menu agent-prompt-link-editor">
      <div className="context-menu-group-label">{t("promptChart.editLink")}</div>
      <p className="agent-prompt-link-editor-ends">{fromLabel} {link.kind === "after" ? "→" : "—"} {toLabel}</p>
      <div className="agent-prompt-link-editor-row" role="group" aria-label={t("promptChart.linkKind")}>
        <button type="button" className={`agent-composer-chip${link.kind === "after" ? " active" : ""}`} aria-pressed={link.kind === "after"} onClick={() => link.kind !== "after" && write({ kind: "after", preface })}>{t("promptChart.after")}</button>
        <button type="button" className={`agent-composer-chip${link.kind === "related" ? " active" : ""}`} aria-pressed={link.kind === "related"} onClick={() => link.kind !== "related" && write({ kind: "related", preface: [] })}>{t("promptChart.related")}</button>
      </div>
      {link.kind === "after" ? (
        <>
          <div className="context-menu-group-label">{t("promptChart.edgeCommands")}</div>
          {choices.length > 0
            ? (
              <div className="agent-prompt-link-editor-row" role="group" aria-label={t("promptChart.edgeCommands")}>
                {choices.map((command) => (
                  <button
                    key={command}
                    type="button"
                    className={`agent-composer-chip${preface.includes(command) ? " active" : ""}`}
                    aria-pressed={preface.includes(command)}
                    onClick={() => write({ kind: "after", preface: toggleEdgeCommand(choices, preface, command) })}
                  >{command}</button>
                ))}
              </div>
            )
            : <p className="context-menu-note">{t("agentPrompts.prefixNone")}</p>}
          <p className="context-menu-note">{t("promptChart.edgeCommandsHelp", { tab: tabLabel ?? t("promptChart.edgeTargetTab") })}</p>
        </>
      ) : <p className="context-menu-note">{t("promptChart.edgeRelatedHelp")}</p>}
      {error && <p className="context-menu-note project-dialog-error">{error}</p>}
      <div className="agent-prompt-link-editor-row">
        <button type="button" className="settings-btn sm danger" onClick={() => void onRemove().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}>{t("common.remove")}</button>
      </div>
    </ContextMenuPortal>
  );
}
