import type { ProjectAgentPrompt, PromptLink } from "../stores/agentPrompts";

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
