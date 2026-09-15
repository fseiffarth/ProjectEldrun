import { PROMPT_CHART_WINDOWS, type PromptChartFilter, type PromptChartWindow } from "../../lib/agentPromptChart";
import { useT } from "../../lib/i18n";
import { Dropdown } from "../common/Dropdown";

interface Props {
  filter: PromptChartFilter;
  onChange: (next: PromptChartFilter) => void;
  placeholder: string;
  agents: string[];
  tags: { tag: string; count: number }[];
  hideOthers: boolean;
  onHideOthers: () => void;
  /** The timeline's facets; the drafts strip has no outcome and no instant. */
  results?: boolean;
  window?: PromptChartWindow;
  onWindow?: (next: PromptChartWindow) => void;
  testId: string;
}

/**
 * One filter over one part of the chart. The drafts strip and the timeline
 * each carry their own, because they answer different questions — "which
 * prompt do I send next" is not "what went to Codex this morning" — and a
 * search typed to find a draft must not blank the axis, or the other way.
 */
export function PromptChartFilterBar({ filter, onChange, placeholder, agents, tags, hideOthers, onHideOthers, results, window, onWindow, testId }: Props) {
  const t = useT();
  return (
    <div className="agent-prompt-chart-filter" data-testid={testId}>
      <div className="agent-prompt-chart-facets">
        <input type="search" value={filter.text} placeholder={placeholder} aria-label={placeholder} onChange={(event) => onChange({ ...filter, text: event.target.value })} />
        {agents.length > 0 && <Dropdown value={filter.agent} title={t("agentPrompts.filterAgent")} options={[{ value: "", label: t("agentPrompts.filterAgentAll") }, ...agents.map((agent) => ({ value: agent, label: agent }))]} onChange={(agent) => onChange({ ...filter, agent })} />}
        {results && <Dropdown value={filter.result} title={t("agentPrompts.filterResult")} options={[{ value: "", label: t("agentPrompts.filterResultAll") }, ...["delivered", "queued", "missed", "failed"].map((result) => ({ value: result, label: t(`promptChart.result.${result}` as "promptChart.result.delivered") }))]} onChange={(result) => onChange({ ...filter, result })} />}
        {window && onWindow && <Dropdown value={window} title={t("promptChart.window")} options={PROMPT_CHART_WINDOWS.map((value) => ({ value, label: t(`promptChart.window.${value}` as "promptChart.window.any") }))} onChange={(value) => onWindow(value as PromptChartWindow)} />}
        <button className={`agent-composer-chip${hideOthers ? " active" : ""}`} type="button" aria-pressed={hideOthers} onClick={onHideOthers}>{t("promptChart.hideOthers")}</button>
      </div>
      {tags.length > 0 && (
        <div className="agent-prompts-tags">
          {tags.map(({ tag, count }) => (
            <button key={tag} type="button" className={`agent-composer-chip agent-prompts-tag${filter.tag === tag ? " active" : ""}${tag.includes(":") ? " is-auto" : ""}`} onClick={() => onChange({ ...filter, tag: filter.tag === tag ? "" : tag })}>
              #{tag}<span>{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
