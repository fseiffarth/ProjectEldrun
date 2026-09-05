import { splitPreface } from "./agentPrefaces";

export interface PromptAutoTagInput {
  message: string;
  agent?: string;
  preface?: string[];
  files?: string[];
  result?: string;
  recurring?: boolean;
  queued?: boolean;
  chained?: boolean;
}

/** Tags that can be reconstructed from a card are deliberately never stored. */
export function agentPromptAutoTags(input: PromptAutoTagInput): string[] {
  const tags: string[] = [];
  const add = (tag: string) => {
    const clean = tag.trim().toLowerCase();
    if (clean && !tags.includes(clean)) tags.push(clean);
  };
  if (input.agent) add(`agent:${input.agent}`);
  const { commands, model } = splitPreface(input.preface);
  if (model) add(`model:${model}`);
  for (const command of commands) {
    const name = /^\/([^\s]+)/.exec(command)?.[1];
    if (name) add(`cmd:${name}`);
  }
  for (const raw of input.files ?? []) {
    const file = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const parts = file.split("/").filter(Boolean);
    if (!parts.length) continue;
    add(`file:${parts[parts.length - 1]}`);
    if (parts.length > 1) add(`dir:${parts[0]}`);
  }
  if (input.result === "missed" || input.result === "failed") add(`result:${input.result}`);
  if (input.recurring) add("recurring");
  if (input.queued) add("queued");
  if (input.chained) add("chained");
  for (const match of input.message.matchAll(/```\s*([\w.+-]+)/g)) add(`lang:${match[1]}`);
  if (new TextEncoder().encode(input.message).byteLength > 2_048) add("long");
  return tags;
}
