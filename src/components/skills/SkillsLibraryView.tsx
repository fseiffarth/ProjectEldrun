import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { renderMarkdown } from "../../lib/viewers/markdown";
import {
  addSkillSource,
  getSkillDetail,
  installSkill,
  listInstalledSkills,
  listSkillCatalog,
  listSkillSources,
  refreshSkillSource,
  removeSkillSource,
  uninstallSkill,
} from "../../lib/skills";
import type {
  InstalledSkill,
  SkillCatalogEntry,
  SkillDetail,
  SkillSource,
} from "../../types/skills";

export interface SkillsLibraryViewProps {
  /** Absolute path to the project skills install into. */
  projectDir: string;
  visible?: boolean;
}

/**
 * The Skills Library's whole UI (`docs/skills_plan.md`): a sources bar, this
 * project's already-installed skills, a browsable/filterable catalog, and a
 * preview panel that is the ONLY place the install action lives — showing a
 * skill's content before it is copied into agent-trusted territory (the
 * project's `.claude/skills/`) is the one piece of the original security
 * posture worth keeping even at this scope, and it costs nothing extra to
 * build beyond putting the button here rather than on the list row.
 *
 * There is deliberately no manifest on this side either: `installed` is a
 * plain read of `<projectDir>/.claude/skills/*`, so a hand-authored skill
 * shows up exactly like one this UI installed, and re-installing is a plain
 * overwrite the user confirms rather than a tracked version bump.
 */
export function SkillsLibraryView({ projectDir, visible = true }: SkillsLibraryViewProps) {
  const t = useT();

  const [sources, setSources] = useState<SkillSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<SkillCatalogEntry | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);

  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  const [addLabel, setAddLabel] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const reloadInstalled = useCallback(() => {
    listInstalledSkills(projectDir)
      .then(setInstalled)
      .catch((e) => setError(String(e)));
  }, [projectDir]);

  // Sources + this project's installed list load once the tab is first shown.
  useEffect(() => {
    if (!visible) return;
    listSkillSources()
      .then((list) => {
        setSources(list);
        setSelectedSourceId((prev) => prev || list[0]?.id || "");
      })
      .catch((e) => setError(String(e)));
    reloadInstalled();
    // Deliberately once per mount (not re-run on every `visible` flip): a
    // background tab keeps its already-loaded list, matching diskusage/files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // The catalog is re-derived from the source's cache on every selection —
  // nothing about it is persisted, and no clone/pull happens here (only an
  // explicit Refresh click does that).
  useEffect(() => {
    if (!selectedSourceId) {
      setCatalog([]);
      return;
    }
    setLoadingCatalog(true);
    setSelectedEntry(null);
    setDetail(null);
    listSkillCatalog(selectedSourceId)
      .then(setCatalog)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingCatalog(false));
  }, [selectedSourceId]);

  useEffect(() => {
    if (!selectedEntry) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    getSkillDetail(selectedEntry.source_id, selectedEntry.rel_path)
      .then(setDetail)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingDetail(false));
  }, [selectedEntry]);

  const installedNames = useMemo(() => new Set(installed.map((s) => s.name)), [installed]);

  const filteredCatalog = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
    );
  }, [catalog, filter]);

  const detailHtml = useMemo(() => (detail ? renderMarkdown(detail.body) : ""), [detail]);

  async function handleAddSource() {
    if (!addUrl.trim()) return;
    setAddBusy(true);
    setError("");
    try {
      const created = await addSkillSource(addLabel.trim() || addUrl.trim(), addUrl.trim());
      setSources((prev) => (prev.some((s) => s.id === created.id) ? prev : [...prev, created]));
      setSelectedSourceId(created.id);
      setAddLabel("");
      setAddUrl("");
      setAddOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRemoveSource(source: SkillSource) {
    if (!window.confirm(t("skillsLibrary.confirmRemoveSource", { label: source.label }))) return;
    try {
      await removeSkillSource(source.id);
      const remaining = sources.filter((s) => s.id !== source.id);
      setSources(remaining);
      if (selectedSourceId === source.id) {
        setSelectedSourceId(remaining[0]?.id ?? "");
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleRefresh(source: SkillSource) {
    setRefreshingId(source.id);
    setError("");
    try {
      await refreshSkillSource(source.id);
      if (source.id === selectedSourceId) {
        setLoadingCatalog(true);
        setCatalog(await listSkillCatalog(source.id));
        setLoadingCatalog(false);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshingId(null);
    }
  }

  async function handleInstall() {
    if (!selectedEntry || !detail) return;
    if (installedNames.has(detail.name)) {
      if (!window.confirm(t("skillsLibrary.confirmReinstall", { name: detail.name }))) return;
    }
    setInstalling(true);
    setError("");
    try {
      await installSkill(projectDir, selectedEntry.source_id, selectedEntry.rel_path);
      reloadInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  }

  async function handleUninstall(skill: InstalledSkill) {
    if (!window.confirm(t("skillsLibrary.confirmUninstall", { name: skill.name }))) return;
    try {
      await uninstallSkill(projectDir, skill.name);
      reloadInstalled();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="skills-pane">
      <div className="skills-toolbar">
        <span className="skills-title">{t("skillsLibrary.title")}</span>
        <select
          className="skills-source-select"
          value={selectedSourceId}
          onChange={(e) => setSelectedSourceId(e.target.value)}
          disabled={sources.length === 0}
        >
          {sources.length === 0 && <option value="">{t("skillsLibrary.noSources")}</option>}
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {sources.map((s) =>
          s.id === selectedSourceId ? (
            <button
              key={s.id}
              className="skills-btn small"
              disabled={refreshingId === s.id}
              onClick={() => handleRefresh(s)}
            >
              {refreshingId === s.id ? t("skillsLibrary.refreshing") : t("skillsLibrary.refresh")}
            </button>
          ) : null,
        )}
        {selectedSourceId && (
          <button
            className="skills-btn small danger"
            onClick={() => {
              const source = sources.find((s) => s.id === selectedSourceId);
              if (source) handleRemoveSource(source);
            }}
          >
            {t("skillsLibrary.removeSource")}
          </button>
        )}
        <span className="skills-toolbar-spacer" />
        <button className="skills-btn small" onClick={() => setAddOpen((v) => !v)}>
          {t("skillsLibrary.addSource")}
        </button>
      </div>

      {addOpen && (
        <div className="skills-add-source">
          <input
            className="skills-input"
            placeholder={t("skillsLibrary.addSourceLabelPlaceholder")}
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
          />
          <input
            className="skills-input"
            placeholder={t("skillsLibrary.addSourceUrlPlaceholder")}
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddSource();
            }}
          />
          <button className="skills-btn small" disabled={addBusy || !addUrl.trim()} onClick={handleAddSource}>
            {t("skillsLibrary.add")}
          </button>
        </div>
      )}

      {error && <div className="skills-strip error">{error}</div>}

      <div className="skills-body">
        <div className="skills-list-col">
          <section className="skills-installed">
            <div className="skills-section-title">{t("skillsLibrary.installed")}</div>
            {installed.length === 0 ? (
              <div className="skills-empty">{t("skillsLibrary.noInstalled")}</div>
            ) : (
              installed.map((skill) => (
                <div className="skills-installed-row" key={skill.name}>
                  <div className="skills-installed-info">
                    <span className="skills-installed-name">{skill.name}</span>
                    <span className="skills-installed-desc">{skill.description}</span>
                  </div>
                  <button className="skills-btn small danger" onClick={() => handleUninstall(skill)}>
                    {t("skillsLibrary.uninstall")}
                  </button>
                </div>
              ))
            )}
          </section>

          <input
            className="skills-input skills-filter"
            placeholder={t("skillsLibrary.searchPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />

          <div className="skills-catalog">
            {loadingCatalog ? (
              <div className="skills-empty">{t("skillsLibrary.loading")}</div>
            ) : filteredCatalog.length === 0 ? (
              <div className="skills-empty">{t("skillsLibrary.noCatalog")}</div>
            ) : (
              filteredCatalog.map((entry) => (
                <div
                  key={`${entry.source_id}:${entry.rel_path}`}
                  className={`skills-catalog-row${
                    selectedEntry?.rel_path === entry.rel_path ? " selected" : ""
                  }`}
                  onClick={() => setSelectedEntry(entry)}
                >
                  <div className="skills-catalog-row-head">
                    <span className="skills-catalog-name">{entry.name}</span>
                    {installedNames.has(entry.name) && (
                      <span className="skills-badge">{t("skillsLibrary.installedBadge")}</span>
                    )}
                    {entry.has_scripts && <span className="skills-scripts-dot" title={t("skillsLibrary.hasScripts")} />}
                  </div>
                  <div className="skills-catalog-desc">{entry.description}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="skills-preview">
          {!selectedEntry ? (
            <div className="skills-empty skills-preview-empty">{t("skillsLibrary.noSelection")}</div>
          ) : loadingDetail || !detail ? (
            <div className="skills-empty">{t("skillsLibrary.loading")}</div>
          ) : (
            <>
              <div className="skills-preview-head">
                <span className="skills-preview-name">{detail.name}</span>
                <button className="skills-btn primary" disabled={installing} onClick={handleInstall}>
                  {installedNames.has(detail.name)
                    ? t("skillsLibrary.reinstall")
                    : t("skillsLibrary.install")}
                </button>
              </div>
              <div className="skills-preview-desc">{detail.description}</div>
              {detail.has_scripts && (
                <div className="skills-strip notice">{t("skillsLibrary.hasScriptsWarning")}</div>
              )}
              {detail.files.length > 0 && (
                <div className="skills-preview-files">
                  <div className="skills-section-title">{t("skillsLibrary.bundledFiles")}</div>
                  <ul>
                    {detail.files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div
                className="skills-preview-body markdown-body"
                dangerouslySetInnerHTML={{ __html: detailHtml }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
