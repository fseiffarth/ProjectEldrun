import { formatRemoteTarget, type ProjectEntry } from "../../types";

/** Display name for a hosting provider. */
export function providerName(provider: unknown): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

export function gitTypeLabel(gitType: unknown, provider?: unknown): string {
  switch (gitType) {
    case "remote-public":
      return `${providerName(provider)} · public`;
    case "remote-private":
      return `${providerName(provider)} · private`;
    case "none":
      return "No git (no repo)";
    default:
      return "Local repo (not pushed)";
  }
}

/** One colored tag in the pill hover overlay marking a facet of the project's
 *  type. Facets are independent axes, so a project can carry several at once
 *  (e.g. an SSH host published to GitHub → both "GitHub" and "SSH"). */
export interface ProjectTypeTag {
  key: string;
  label: string;
  /** 6-digit hex; text + border use it solid, background gets an alpha tint. */
  color: string;
  title: string;
}

/** Derive the colored type tags for a project. The git axis contributes exactly
 *  one tag (no git / local / GitHub / GitLab); the SSH-remote and missing-
 *  scaffold axes each contribute an independent tag on top. */
export function projectTypeTags(project: ProjectEntry, scaffoldMissing: boolean): ProjectTypeTag[] {
  const tags: ProjectTypeTag[] = [];
  const gitType = typeof project.git_type === "string" ? project.git_type : "local";
  if (gitType === "none") {
    tags.push({ key: "git", label: "no git", color: "#8b949e", title: "No git repository" });
  } else {
    // The provider badge normally rides on an Eldrun-published `remote-*`
    // git_type, but a repo pushed to a host *outside* Eldrun carries only a
    // detected provider (sniffed from `origin`; git_type stays "local"). Either
    // one lights up the badge; the ·public/·private suffix stays exclusive to
    // Eldrun-published repos, since visibility can't be sniffed from the URL.
    const published = gitType.startsWith("remote");
    const provider = project.git_provider ?? project.detected_provider;
    // A repo always carries the base "git" tag; when it's published, the hosting
    // provider rides alongside it as a parallel tag (git + GitHub / git + GitLab).
    tags.push({
      key: "git",
      label: "git",
      color: "#3fb950",
      title: published
        ? gitTypeLabel(gitType, project.git_provider)
        : provider
          ? `Local git repo · origin on ${providerName(provider)}`
          : "Local git repo (not pushed to a remote)",
    });
    if (published || provider) {
      const label = provider === "gitlab" ? "GitLab" : "GitHub";
      const color = provider === "gitlab" ? "#fc6d26" : "#a371f7";
      const title = published
        ? gitTypeLabel(gitType, provider)
        : `origin on ${providerName(provider)} (detected — not published via Eldrun)`;
      tags.push({ key: "provider", label, color, title });
    }
  }
  if (project.remote) {
    tags.push({
      key: "ssh",
      label: "SSH",
      color: "#58a6ff",
      title: `Remote host · ${formatRemoteTarget(project.remote)}`,
    });
  }
  if (scaffoldMissing) {
    tags.push({
      key: "scaffold",
      label: "no scaffold",
      color: "#d29922",
      title: "Missing scaffold files — run “Repair scaffold files”",
    });
  }
  return tags;
}
