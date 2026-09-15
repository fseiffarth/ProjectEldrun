import type { ProjectAgentPrompt, PromptLink } from "../stores/agentPrompts";
import { MAX_PREFACE_COMMANDS, sanitizePrefaceCommand } from "./agentPrefaces";

export type PromptLinkKind = "related" | "after";

export interface ChainStrand {
  scheduleTargetId: string;
  label: string;
  sessionId?: string;
  agent?: string;
}

export interface ChainNext {
  link: PromptLink;
  prompt: ProjectAgentPrompt;
  strand?: ChainStrand;
  stopped: "closed" | null;
}

export function validPromptLink(link: PromptLink): boolean {
  return !!link.id && !!link.from && !!link.to && link.from !== link.to
    && (link.kind === "related" || link.kind === "after");
}

export function prunePromptLinks(links: PromptLink[], endpointIds: Iterable<string>): PromptLink[] {
  const ids = new Set(endpointIds);
  return links.filter((link) => validPromptLink(link) && ids.has(link.from) && ids.has(link.to));
}

/**
 * The command chips an edge offers: what the target tab's agent offers, then
 * any command the edge already carries that it no longer does — a chip that
 * disappeared would drop a command the edge still types.
 */
export function edgeCommandChoices(offered: readonly string[], preface: readonly string[] = []): string[] {
  const choices = offered.map(sanitizePrefaceCommand).filter(Boolean);
  for (const command of preface) if (!choices.includes(command)) choices.push(command);
  return choices;
}

/** An edge's commands with `command` switched on or off, in chip order. */
export function toggleEdgeCommand(choices: readonly string[], preface: readonly string[] = [], command: string): string[] {
  const on = new Set(preface);
  if (on.has(command)) on.delete(command);
  else on.add(command);
  return choices.filter((choice) => on.has(choice)).slice(0, MAX_PREFACE_COMMANDS);
}

/** Resolve the drafts an actual successful delivery should queue. */
export function nextAfter(
  deliveredId: string,
  links: PromptLink[],
  drafts: ProjectAgentPrompt[],
  strands: ChainStrand[],
  fallbackTarget?: string,
): ChainNext[] {
  const byId = new Map(drafts.map((prompt) => [prompt.id, prompt]));
  const strandById = new Map(strands.map((strand) => [strand.scheduleTargetId, strand]));
  return links.flatMap((link) => {
    const sourceMatches = link.from === deliveredId || deliveredId.startsWith(`${link.from}@`);
    if (link.kind !== "after" || !sourceMatches) return [];
    const prompt = byId.get(link.to);
    if (!prompt) return [];
    const strand = strandById.get(link.target ?? fallbackTarget ?? "");
    return [{ link, prompt, strand, stopped: strand ? null : "closed" }];
  });
}
