import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { formatTags, parseTags } from "../../lib/agentPromptTags";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { localWallClock } from "../../lib/agentSchedule";
import type { PromptChartCard } from "../../lib/agentPromptChart";
import { formatTimelineInstant } from "../../lib/agentPromptTimeline";
import type { PromptLink } from "../../stores/agentPrompts";
import { Dropdown } from "../common/Dropdown";

export interface PromptCardTarget {
  id: string;
  label: string;
}

interface Props {
  card: PromptChartCard;
  matched: boolean;
  selected: boolean;
  /** Click-to-link is armed and this card is a candidate target. */
  linking: boolean;
  /** This card is the one being carried; the ghost stands in for it. */
  dragging: boolean;
  /** A link pulled out of another card's port hovers this one. */
  linkOver: boolean;
  /** A later occurrence of a recurring rule: read-only, no ports, unregistered. */
  occurrence?: string;
  /** The stripe colour of the tab the card is aimed at. */
  color: string;
  /** The live agent tabs a card can be aimed at. */
  targets: PromptCardTarget[];
  /** What a sent card shows instead of a picker: the tab it went to. */
  targetLabel?: string;
  register?: (node: HTMLElement | null) => void;
  onSelect: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPortPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onAgent: (targetId: string) => Promise<void>;
  onSave: (message: string, tags: string[]) => Promise<void>;
  onDelete: () => Promise<void>;
  onSend: () => void;
  onSchedule: () => void;
  onUnschedule: () => Promise<void>;
  onCollect: () => Promise<void>;
  onRetime: (minutes: number) => Promise<void>;
  onQueueMove: (step: -1 | 1) => Promise<void>;
  onLink: () => void;
  onUnlink: (linkId: string) => Promise<void>;
  links: PromptLink[];
  /** A short reading of the card at the other end of a link. */
  linkLabel: (id: string) => string;
  onGoToTab?: () => void;
}

/** The card's one line of fact. Its instants are written by the chart's own
 *  clock (`formatTimelineInstant`): the app's language and 12/24-hour
 *  setting, matching the axis above the card. */
function stateFact(
  card: PromptChartCard,
  t: ReturnType<typeof useT>,
  when: (at: Date | null | undefined) => string,
  occurrence?: string,
): string {
  if (card.state === "queued") return t("promptChart.waiting");
  if (card.state === "chained") return card.chainStopped
    ? t("promptChart.chainClosed")
    : t("promptChart.chained");
  if (card.state === "sent") {
    const result = card.history?.result ?? "delivered";
    return `${t(`promptChart.result.${result}` as "promptChart.result.delivered")} · ${when(card.at)}`;
  }
  if (card.state === "scheduled") {
    if (occurrence) return `↻ ${when(localWallClock(occurrence)) || occurrence.replace("T", " ")}`;
    return card.at
      ? `${card.recurring ? "↻ " : ""}${when(card.at)}`
      : t("promptChart.paused");
  }
  return t("promptChart.draft");
}

export function PromptCard({
  card,
  matched,
  selected,
  linking,
  dragging,
  linkOver,
  occurrence,
  color,
  targets,
  targetLabel,
  register,
  onSelect,
  onPointerDown,
  onPortPointerDown,
  onAgent,
  onSave,
  onDelete,
  onSend,
  onSchedule,
  onUnschedule,
  onCollect,
  onRetime,
  onQueueMove,
  onLink,
  onUnlink,
  links,
  linkLabel,
  onGoToTab,
}: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const when = (at: Date | null | undefined) => (at ? formatTimelineInstant(at, lang, use24h) : "");
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState(card.message);
  const [tags, setTags] = useState(formatTags(card.tags));
  const [copied, setCopied] = useState(false);
  const storedTags = formatTags(card.tags);
  const readOnly = card.state === "sent" || !!occurrence;

  useEffect(() => {
    setMessage(card.message);
    setTags(storedTags);
  }, [card.message, storedTags]);

  const ownLinks = links.filter((link) => link.from === card.id || link.to === card.id);
  const save = async () => {
    if (!message.trim()) return;
    await onSave(message.trim(), parseTags(tags));
    setEditing(false);
  };
  const className = [
    "agent-prompt-card todo-card",
    `is-${card.state}`,
    matched ? "" : "is-dimmed",
    selected ? "is-selected" : "",
    linking ? "is-link-target" : "",
    dragging ? "is-dragging" : "",
    linkOver ? "is-link-over" : "",
    occurrence ? "is-occurrence" : "",
  ].filter(Boolean).join(" ");

  return (
    <article
      ref={occurrence ? undefined : register}
      className={className}
      data-prompt-card={occurrence ? undefined : card.id}
      data-testid={`prompt-chart-card-${card.state}`}
      style={{ "--prompt-strand": color } as React.CSSProperties}
      onClick={() => {
        onSelect();
        setExpanded((value) => !value);
      }}
      onPointerDown={occurrence ? undefined : onPointerDown}
    >
      {!occurrence && <span className="agent-prompt-card-port is-in" aria-hidden="true" />}
      <div className="agent-prompt-card-head">
        <span className="agent-prompt-card-message">{card.message}</span>
        <span className={`agent-prompt-lamp is-${card.history?.result ?? card.state}`} aria-hidden="true" />
      </div>
      <div className="agent-prompt-card-agent" onClick={(event) => event.stopPropagation()}>
        {readOnly || targets.length === 0
          ? <small>{targetLabel ?? targets.find((target) => target.id === card.targetId)?.label ?? t("promptChart.noAgent")}</small>
          : (
            <Dropdown
              className="agent-prompt-card-agent-pick"
              title={t("promptChart.agent")}
              value={card.targetId ?? ""}
              placeholder={t("promptChart.noAgent")}
              options={targets.map((target) => ({ value: target.id, label: target.label }))}
              onChange={(value) => void onAgent(value)}
            />
          )}
      </div>
      <div className="agent-prompt-card-tags">
        {card.tags.map((tag) => <span key={`stored:${tag}`} className="agent-prompt-tag">#{tag}</span>)}
        {card.autoTags.map((tag) => <span key={`auto:${tag}`} className="agent-prompt-tag is-auto">#{tag}</span>)}
      </div>
      <small className="agent-prompt-card-fact">{stateFact(card, t, when, occurrence)}</small>
      {!occurrence && (
        <button
          className="agent-prompt-card-port is-out"
          type="button"
          data-no-drag
          aria-label={t("promptChart.linkFrom")}
          title={t("promptChart.linkFrom")}
          onPointerDown={onPortPointerDown}
          onClick={(event) => { event.stopPropagation(); onLink(); }}
        />
      )}

      {expanded && (
        <div className="agent-prompt-card-expanded" onClick={(event) => event.stopPropagation()}>
          {editing ? (
            <>
              <textarea rows={6} value={message} onChange={(event) => setMessage(event.target.value)} />
              <input value={tags} aria-label={t("agentPrompts.tags")} placeholder={t("agentPrompts.tagsPlaceholder")} onChange={(event) => setTags(event.target.value)} />
              <div className="agent-prompt-card-actions">
                <button className="settings-btn sm primary" type="button" onClick={() => void save()}>{t("common.save")}</button>
                <button className="settings-btn sm" type="button" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
              </div>
            </>
          ) : (
            <>
              <p className="agent-prompt-card-full">{card.message}</p>
              {card.history?.session_id && (
                <button
                  className="agent-prompt-session"
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(card.history?.session_id ?? "");
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  {copied ? "✓ " : "⧉ "}{t("promptChart.session", { id: card.history.session_id })}
                </button>
              )}
              {(card.history?.files?.length ?? 0) > 0 && (
                <ul className="agent-prompt-files">
                  {card.history?.files?.map((file) => <li key={file}>{file}</li>)}
                </ul>
              )}
              <div className="agent-prompt-card-actions">
                {targets.length > 0 && !occurrence && <button className="settings-btn sm primary" type="button" onClick={onSend}>{t("agentPrompts.send")}</button>}
                {(card.state === "draft" || card.state === "chained") && <button className="settings-btn sm" type="button" onClick={onSchedule}>{t("agentPrompts.schedule")}</button>}
                {card.state === "sent" && <button className="settings-btn sm" type="button" onClick={() => void onCollect()}>{t("promptChart.collectAgain")}</button>}
                {!readOnly && <button className="settings-btn sm" type="button" onClick={() => setEditing(true)}>{t("common.edit")}</button>}
                {card.schedule && !card.recurring && (
                  <>
                    <button className="settings-btn sm" type="button" onClick={() => void onRetime(-5)}>− {t("promptChart.fiveMinutesEarlier")}</button>
                    <button className="settings-btn sm" type="button" onClick={() => void onRetime(5)}>+ {t("promptChart.fiveMinutesLater")}</button>
                  </>
                )}
                {card.state === "queued" && <><button className="settings-btn sm" type="button" aria-label={t("promptChart.queueEarlier")} title={t("promptChart.queueEarlier")} onClick={() => void onQueueMove(-1)}>↑</button><button className="settings-btn sm" type="button" aria-label={t("promptChart.queueLater")} title={t("promptChart.queueLater")} onClick={() => void onQueueMove(1)}>↓</button></>}
                {card.schedule && card.recurring && <button className="settings-btn sm" type="button" onClick={onSchedule}>{t("promptChart.editRule")}</button>}
                {card.schedule && !occurrence && <button className="settings-btn sm" type="button" onClick={() => void onUnschedule()}>{t("promptChart.unschedule")}</button>}
                {onGoToTab && <button className="settings-btn sm" type="button" onClick={onGoToTab}>{t("agentPrompts.jump")}</button>}
                {!occurrence && <button className="settings-btn sm" type="button" onClick={onLink}>{t("promptChart.link")}</button>}
                {!occurrence && <button className="settings-btn sm danger" type="button" onClick={() => void onDelete()}>{t("common.delete")}</button>}
              </div>
              {ownLinks.map((link) => (
                <button key={link.id} className="agent-prompt-link-row" type="button" onClick={() => void onUnlink(link.id)}>
                  {link.from === card.id ? (link.kind === "after" ? "→ " : "— ") : (link.kind === "after" ? "← " : "— ")}
                  {linkLabel(link.from === card.id ? link.to : link.from)} · {t("common.remove")}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </article>
  );
}
