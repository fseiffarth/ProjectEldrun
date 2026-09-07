import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { formatTags, parseTags } from "../../lib/agentPromptTags";
import { useT } from "../../lib/i18n";
import type { PromptChartCard, PromptChartStrand } from "../../lib/agentPromptChart";

interface Props {
  card: PromptChartCard;
  strand?: PromptChartStrand;
  matched: boolean;
  selected: boolean;
  linking: boolean;
  register: (node: HTMLElement | null) => void;
  onSelect: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onSave: (message: string, tags: string[]) => Promise<void>;
  onDelete: () => Promise<void>;
  onSend: (targetId?: string) => void;
  onSchedule: (targetId?: string) => void;
  onUnschedule: () => Promise<void>;
  onCollect: () => Promise<void>;
  onRetime: (minutes: number) => Promise<void>;
  onQueueMove: (step: -1 | 1) => Promise<void>;
  onMove: (targetId: string) => Promise<void>;
  onLink: () => void;
  onUnlink: (linkId: string) => Promise<void>;
  links: { id: string; from: string; to: string; kind: string }[];
  strands: PromptChartStrand[];
  onGoToTab?: () => void;
}

function stateFact(card: PromptChartCard, t: ReturnType<typeof useT>): string {
  if (card.state === "queued") return t("promptChart.waiting");
  if (card.state === "chained") return card.chainStopped
    ? t("promptChart.chainClosed")
    : t("promptChart.chained");
  if (card.state === "sent") {
    const result = card.history?.result ?? "delivered";
    return `${t(`promptChart.result.${result}` as "promptChart.result.delivered")} · ${card.at?.toLocaleString() ?? ""}`;
  }
  if (card.state === "scheduled") {
    return card.at
      ? `${card.recurring ? "↻ " : ""}${card.at.toLocaleString()}`
      : t("promptChart.paused");
  }
  return t("promptChart.draft");
}

export function PromptCard({
  card,
  strand,
  matched,
  selected,
  linking,
  register,
  onSelect,
  onPointerDown,
  onSave,
  onDelete,
  onSend,
  onSchedule,
  onUnschedule,
  onCollect,
  onRetime,
  onQueueMove,
  onMove,
  onLink,
  onUnlink,
  links,
  strands,
  onGoToTab,
}: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState(card.message);
  const [tags, setTags] = useState(formatTags(card.tags));
  const [copied, setCopied] = useState(false);
  const targets = strands.filter((item) => item.scheduleTargetId && !item.closed);
  const [chosenTarget, setChosenTarget] = useState(card.targetId ?? targets[0]?.scheduleTargetId ?? "");
  const storedTags = formatTags(card.tags);

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

  return (
    <article
      ref={register}
      className={`agent-prompt-card todo-card is-${card.state}${matched ? "" : " is-dimmed"}${selected ? " is-selected" : ""}${linking ? " is-link-target" : ""}`}
      data-prompt-card={card.id}
      data-testid={`prompt-chart-card-${card.state}`}
      style={{ "--prompt-strand": strand?.closed ? "var(--text-muted)" : undefined } as React.CSSProperties}
      onClick={() => {
        onSelect();
        setExpanded((value) => !value);
      }}
      onPointerDown={onPointerDown}
    >
      <div className="agent-prompt-card-head">
        <button
          className="agent-prompt-card-port"
          type="button"
          aria-label={t("promptChart.link")}
          title={t("promptChart.link")}
          onClick={(event) => { event.stopPropagation(); onLink(); }}
        />
        <span className="agent-prompt-card-message">{card.message}</span>
        <span className={`agent-prompt-lamp is-${card.history?.result ?? card.state}`} aria-hidden="true" />
      </div>
      <div className="agent-prompt-card-tags">
        {card.tags.map((tag) => <span key={`stored:${tag}`} className="agent-prompt-tag">#{tag}</span>)}
        {card.autoTags.map((tag) => <span key={`auto:${tag}`} className="agent-prompt-tag is-auto">#{tag}</span>)}
      </div>
      <small className="agent-prompt-card-fact">{stateFact(card, t)}</small>

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
                {targets.length > 0 && <button className="settings-btn sm primary" type="button" onClick={() => onSend(chosenTarget)}>{t("agentPrompts.send")}</button>}
                {(card.state === "draft" || card.state === "chained") && <button className="settings-btn sm" type="button" onClick={() => onSchedule(chosenTarget)}>{t("agentPrompts.schedule")}</button>}
                {card.state === "sent" && <button className="settings-btn sm" type="button" onClick={() => void onCollect()}>{t("promptChart.collectAgain")}</button>}
                {card.state !== "sent" && <button className="settings-btn sm" type="button" onClick={() => setEditing(true)}>{t("common.edit")}</button>}
                {card.schedule && !card.recurring && (
                  <>
                    <button className="settings-btn sm" type="button" onClick={() => void onRetime(-5)}>− {t("promptChart.fiveMinutesEarlier")}</button>
                    <button className="settings-btn sm" type="button" onClick={() => void onRetime(5)}>+ {t("promptChart.fiveMinutesLater")}</button>
                  </>
                )}
                {card.state === "queued" && <><button className="settings-btn sm" type="button" aria-label={t("promptChart.queueEarlier")} title={t("promptChart.queueEarlier")} onClick={() => void onQueueMove(-1)}>↑</button><button className="settings-btn sm" type="button" aria-label={t("promptChart.queueLater")} title={t("promptChart.queueLater")} onClick={() => void onQueueMove(1)}>↓</button></>}
                {card.schedule && card.recurring && <button className="settings-btn sm" type="button" onClick={() => onSchedule(chosenTarget)}>{t("promptChart.editRule")}</button>}
                {card.schedule && <button className="settings-btn sm" type="button" onClick={() => void onUnschedule()}>{t("promptChart.unschedule")}</button>}
                {onGoToTab && <button className="settings-btn sm" type="button" onClick={onGoToTab}>{t("agentPrompts.jump")}</button>}
                <button className="settings-btn sm" type="button" onClick={onLink}>{t("promptChart.link")}</button>
                <button className="settings-btn sm danger" type="button" onClick={() => void onDelete()}>{t("common.delete")}</button>
              </div>
              {targets.length > 1 && (
                <label className="agent-prompt-move">
                  {card.schedule ? t("promptChart.moveTo") : t("agentPrompts.target")}
                  <select value={chosenTarget} onChange={(event) => {
                    setChosenTarget(event.target.value);
                    if (card.schedule) void onMove(event.target.value);
                  }}>
                    {targets.map((item) => (
                      <option key={item.id} value={item.scheduleTargetId}>{item.label}</option>
                    ))}
                  </select>
                </label>
              )}
              {ownLinks.map((link) => (
                <button key={link.id} className="agent-prompt-link-row" type="button" onClick={() => void onUnlink(link.id)}>
                  {link.kind === "after" ? "→" : "—"} {link.from === card.id ? link.to : link.from} · {t("common.remove")}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </article>
  );
}
