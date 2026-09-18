import type { PromptChartCard } from "./chart";
import type { PromptLink } from "../../../stores/agentPrompts";

/** Resolve the whole draft sequence from any member. Only one incoming
 * dependency per card is supported by the delivery runtime. Cycles and joins
 * have no unambiguous start, so never schedule an arbitrary member of them. */
export function draftSequence(id: string, cards: PromptChartCard[], links: PromptLink[]): PromptChartCard[] | null {
  const drafts = new Map(cards.filter((card) => card.prompt && !card.schedule && !card.history).map((card) => [card.id, card]));
  if (!drafts.has(id)) return null;
  const edges = links.filter((link) => link.kind === "after" && drafts.has(link.from) && drafts.has(link.to));
  const members = new Set([id]);
  for (const member of members) {
    for (const edge of edges) {
      if (edge.from === member) members.add(edge.to);
      if (edge.to === member) members.add(edge.from);
    }
  }
  const incoming = (member: string) => links.filter((link) => link.kind === "after" && link.to === member);
  if ([...members].some((member) => incoming(member).length > 1)) return null;
  const roots = [...members].filter((member) => incoming(member).length === 0);
  if (roots.length !== 1) return null;
  const ordered = [roots[0]];
  const seen = new Set(ordered);
  for (const member of ordered) {
    for (const edge of edges.filter((link) => link.from === member)) {
      if (seen.has(edge.to)) return null;
      seen.add(edge.to);
      ordered.push(edge.to);
    }
  }
  return ordered.length === members.size ? ordered.map((member) => drafts.get(member)!) : null;
}
