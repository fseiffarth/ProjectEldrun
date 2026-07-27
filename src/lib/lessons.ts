import type { TourStep } from "./tour";
import type { TranslationKey } from "./i18n";

/**
 * Task "lessons" — short, replayable narrated walkthroughs for specific jobs
 * (add a project, install an agent, use a local model, …). Each lesson is a
 * step list run through the same engine as the high-level tour (`TourHost` /
 * `useTourStore.startLesson`), so it reuses the spotlight, click-blocking, and
 * Back/Next navigation. Picked from the `LessonsMenu`.
 *
 * Most steps spotlight a persistent entry-point control (the + button, the gear,
 * the 🧠 menu) by a verified selector; menu/dialog internals — which only exist
 * while open and which the narrated, click-blocking overlay can't keep pinned —
 * are described as centered cards (`anchor: null`). Copy matches the terse,
 * friendly onboarding voice.
 *
 * Order is meaningful: lessons run easiest → hardest and are grouped into tiers
 * (`LESSON_CATEGORIES`). `LESSONS` stays sorted so each category's lessons are
 * contiguous and the picker can render a header per tier just by walking the
 * array. Within a tier the lessons themselves also ramp from simplest to most
 * involved.
 */

/** Difficulty tiers, in the order the picker shows them (easy → hard). Stable
 *  ids, not display text — `categoryLabel` resolves the translated label. */
export const LESSON_CATEGORIES = ["basics", "agentsModels", "advanced"] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

/** Translated tier label, by category id. */
export const LESSON_CATEGORY_LABEL_KEYS: Record<LessonCategory, TranslationKey> = {
  basics: "lessons.categoryBasics",
  agentsModels: "lessons.categoryAgentsModels",
  advanced: "lessons.categoryAdvanced",
};

export function categoryLabel(
  category: LessonCategory,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  return t(LESSON_CATEGORY_LABEL_KEYS[category]);
}

export interface Lesson {
  /** Stable id (also the React key in the picker). */
  id: string;
  /** Difficulty tier; groups the lesson under a header in the picker. */
  category: LessonCategory;
  /** Menu label. */
  titleKey: TranslationKey;
  /** One-line description shown under the title in the picker. */
  blurbKey: TranslationKey;
  steps: TourStep[];
}

/** Reveal the right-side file panel so a step's anchor exists to spotlight.
 *  AppShell listens for this (the panel is otherwise hover-revealed). */
const revealFilePanel = () => window.dispatchEvent(new Event("eldrun:reveal-right-panel"));

export const LESSONS: Lesson[] = [
  // ── Basics ──────────────────────────────────────────────────────────────
  {
    id: "add-project",
    category: "basics",
    titleKey: "lessons.addProject.title",
    blurbKey: "lessons.addProject.blurb",
    steps: [
      {
        id: "pill-strip",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.addProject.pillStripTitle",
        bodyKey: "lessons.addProject.pillStripBody",
      },
      {
        id: "add-button",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "bottom",
        titleKey: "lessons.addProject.addButtonTitle",
        bodyKey: "lessons.addProject.addButtonBody",
      },
      {
        id: "add-menu",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addProject.addMenuTitle",
        bodyKey: "lessons.addProject.addMenuBody",
      },
      {
        id: "new-dialog",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addProject.newDialogTitle",
        bodyKey: "lessons.addProject.newDialogBody",
      },
      {
        id: "scaffold-create",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addProject.scaffoldCreateTitle",
        bodyKey: "lessons.addProject.scaffoldCreateBody",
      },
      {
        id: "publish-remote",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.addProject.publishRemoteTitle",
        bodyKey: "lessons.addProject.publishRemoteBody",
      },
    ],
  },
  {
    id: "import-project",
    category: "basics",
    titleKey: "lessons.importProject.title",
    blurbKey: "lessons.importProject.blurb",
    steps: [
      {
        id: "open-add-menu",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "top",
        titleKey: "lessons.importProject.openAddMenuTitle",
        bodyKey: "lessons.importProject.openAddMenuBody",
      },
      {
        id: "pick-import",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.importProject.pickImportTitle",
        bodyKey: "lessons.importProject.pickImportBody",
      },
      {
        id: "browse-folder",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.importProject.browseFolderTitle",
        bodyKey: "lessons.importProject.browseFolderBody",
      },
      {
        id: "import-mode",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.importProject.importModeTitle",
        bodyKey: "lessons.importProject.importModeBody",
      },
      {
        id: "remote-import",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.importProject.remoteImportTitle",
        bodyKey: "lessons.importProject.remoteImportBody",
      },
      {
        id: "publish-remote",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.importProject.publishRemoteTitle",
        bodyKey: "lessons.importProject.publishRemoteBody",
      },
    ],
  },
  {
    id: "add-tab",
    category: "basics",
    titleKey: "lessons.addTab.title",
    blurbKey: "lessons.addTab.blurb",
    steps: [
      {
        id: "find-plus",
        anchor: '[data-hint-anchor="tab-add"]',
        placement: "bottom",
        titleKey: "lessons.addTab.findPlusTitle",
        bodyKey: "lessons.addTab.findPlusBody",
      },
      {
        id: "the-menu",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addTab.theMenuTitle",
        bodyKey: "lessons.addTab.theMenuBody",
      },
      {
        id: "shell-files",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addTab.shellFilesTitle",
        bodyKey: "lessons.addTab.shellFilesBody",
      },
      {
        id: "rename-close",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addTab.renameCloseTitle",
        bodyKey: "lessons.addTab.renameCloseBody",
      },
    ],
  },
  {
    id: "native-viewer",
    category: "basics",
    titleKey: "lessons.nativeViewer.title",
    blurbKey: "lessons.nativeViewer.blurb",
    steps: [
      {
        id: "reveal-tree",
        anchor: '[data-hint-anchor="file-tree-edge"]',
        placement: "left",
        titleKey: "lessons.nativeViewer.revealTreeTitle",
        bodyKey: "lessons.nativeViewer.revealTreeBody",
        prepare: revealFilePanel,
      },
      {
        id: "pin-panel",
        anchor: ".right-panel-pin",
        placement: "left",
        titleKey: "lessons.nativeViewer.pinPanelTitle",
        bodyKey: "lessons.nativeViewer.pinPanelBody",
        prepare: revealFilePanel,
      },
      {
        id: "open-file",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.nativeViewer.openFileTitle",
        bodyKey: "lessons.nativeViewer.openFileBody",
      },
      {
        id: "viewer-pane",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.nativeViewer.viewerPaneTitle",
        bodyKey: "lessons.nativeViewer.viewerPaneBody",
      },
      {
        id: "default-app",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.nativeViewer.defaultAppTitle",
        bodyKey: "lessons.nativeViewer.defaultAppBody",
      },
    ],
  },
  {
    id: "arrange-tabs",
    category: "basics",
    titleKey: "lessons.arrangeTabs.title",
    blurbKey: "lessons.arrangeTabs.blurb",
    steps: [
      {
        id: "intro",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.arrangeTabs.introTitle",
        bodyKey: "lessons.arrangeTabs.introBody",
      },
      {
        id: "tab-bar",
        anchor: ".tab-bar",
        placement: "bottom",
        titleKey: "lessons.arrangeTabs.tabBarTitle",
        bodyKey: "lessons.arrangeTabs.tabBarBody",
      },
      {
        id: "split",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.arrangeTabs.splitTitle",
        bodyKey: "lessons.arrangeTabs.splitBody",
      },
      {
        id: "drag-from-tree",
        anchor: '[data-hint-anchor="file-tree-edge"]',
        placement: "left",
        titleKey: "lessons.arrangeTabs.dragFromTreeTitle",
        bodyKey: "lessons.arrangeTabs.dragFromTreeBody",
        prepare: revealFilePanel,
      },
      {
        id: "detach",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.arrangeTabs.detachTitle",
        bodyKey: "lessons.arrangeTabs.detachBody",
      },
      {
        id: "drag-to-detached",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.arrangeTabs.dragToDetachedTitle",
        bodyKey: "lessons.arrangeTabs.dragToDetachedBody",
      },
      {
        id: "outro",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.arrangeTabs.outroTitle",
        bodyKey: "lessons.arrangeTabs.outroBody",
      },
    ],
  },
  {
    id: "yaml-viewer",
    category: "basics",
    titleKey: "lessons.yamlViewer.title",
    blurbKey: "lessons.yamlViewer.blurb",
    steps: [
      {
        id: "open-yaml",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.yamlViewer.openYamlTitle",
        bodyKey: "lessons.yamlViewer.openYamlBody",
      },
      {
        id: "three-views",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.yamlViewer.threeViewsTitle",
        bodyKey: "lessons.yamlViewer.threeViewsBody",
      },
      {
        id: "drill-cards",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.yamlViewer.drillCardsTitle",
        bodyKey: "lessons.yamlViewer.drillCardsBody",
      },
      {
        id: "edit-safely",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.yamlViewer.editSafelyTitle",
        bodyKey: "lessons.yamlViewer.editSafelyBody",
      },
      {
        id: "copy-paste",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.yamlViewer.copyPasteTitle",
        bodyKey: "lessons.yamlViewer.copyPasteBody",
      },
    ],
  },
  {
    id: "pdf-viewer",
    category: "basics",
    titleKey: "lessons.pdfViewer.title",
    blurbKey: "lessons.pdfViewer.blurb",
    steps: [
      {
        id: "open-pdf",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.pdfViewer.openPdfTitle",
        bodyKey: "lessons.pdfViewer.openPdfBody",
      },
      {
        id: "contents",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.pdfViewer.contentsTitle",
        bodyKey: "lessons.pdfViewer.contentsBody",
      },
      {
        id: "page-tools",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.pdfViewer.pageToolsTitle",
        bodyKey: "lessons.pdfViewer.pageToolsBody",
      },
      {
        id: "save-pdf",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.pdfViewer.savePdfTitle",
        bodyKey: "lessons.pdfViewer.savePdfBody",
      },
      {
        id: "synctex",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.pdfViewer.synctexTitle",
        bodyKey: "lessons.pdfViewer.synctexBody",
      },
    ],
  },
  {
    id: "run-python",
    category: "basics",
    titleKey: "lessons.runPython.title",
    blurbKey: "lessons.runPython.blurb",
    steps: [
      {
        id: "open-py",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.runPython.openPyTitle",
        bodyKey: "lessons.runPython.openPyBody",
      },
      {
        id: "run-file",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.runPython.runFileTitle",
        bodyKey: "lessons.runPython.runFileBody",
      },
      {
        id: "breakpoints",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.runPython.breakpointsTitle",
        bodyKey: "lessons.runPython.breakpointsBody",
      },
      {
        id: "debug-file",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.runPython.debugFileTitle",
        bodyKey: "lessons.runPython.debugFileBody",
      },
      {
        id: "go-to-def",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.runPython.goToDefTitle",
        bodyKey: "lessons.runPython.goToDefBody",
      },
    ],
  },
  {
    id: "file-search",
    category: "basics",
    titleKey: "lessons.fileSearch.title",
    blurbKey: "lessons.fileSearch.blurb",
    steps: [
      {
        id: "reveal-tree",
        anchor: '[data-hint-anchor="file-tree-edge"]',
        placement: "left",
        titleKey: "lessons.fileSearch.revealTreeTitle",
        bodyKey: "lessons.fileSearch.revealTreeBody",
        prepare: revealFilePanel,
      },
      {
        id: "name-vs-content",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.fileSearch.nameVsContentTitle",
        bodyKey: "lessons.fileSearch.nameVsContentBody",
      },
      {
        id: "jump-and-open",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.fileSearch.jumpAndOpenTitle",
        bodyKey: "lessons.fileSearch.jumpAndOpenBody",
      },
      {
        id: "scope-root",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.fileSearch.scopeRootTitle",
        bodyKey: "lessons.fileSearch.scopeRootBody",
      },
    ],
  },
  {
    id: "calendar",
    category: "basics",
    titleKey: "lessons.calendarLesson.title",
    blurbKey: "lessons.calendarLesson.blurb",
    steps: [
      {
        id: "open-calendar",
        anchor: '[data-hint-anchor="tab-add"]',
        placement: "bottom",
        titleKey: "lessons.calendarLesson.openCalendarTitle",
        bodyKey: "lessons.calendarLesson.openCalendarBody",
      },
      {
        id: "views",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.calendarLesson.viewsTitle",
        bodyKey: "lessons.calendarLesson.viewsBody",
      },
      {
        id: "drag-create",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.calendarLesson.dragCreateTitle",
        bodyKey: "lessons.calendarLesson.dragCreateBody",
      },
      {
        id: "event-editor",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.calendarLesson.eventEditorTitle",
        bodyKey: "lessons.calendarLesson.eventEditorBody",
      },
      {
        id: "ics",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.calendarLesson.icsTitle",
        bodyKey: "lessons.calendarLesson.icsBody",
      },
    ],
  },
  {
    id: "usage-recap",
    category: "basics",
    titleKey: "lessons.usageRecap.title",
    blurbKey: "lessons.usageRecap.blurb",
    steps: [
      {
        id: "what-it-is",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.usageRecap.whatItIsTitle",
        bodyKey: "lessons.usageRecap.whatItIsBody",
      },
      {
        id: "when-it-opens",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.usageRecap.whenItOpensTitle",
        bodyKey: "lessons.usageRecap.whenItOpensBody",
      },
      {
        id: "windows",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.usageRecap.windowsTitle",
        bodyKey: "lessons.usageRecap.windowsBody",
      },
      {
        id: "open-anytime",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        titleKey: "lessons.usageRecap.openAnytimeTitle",
        bodyKey: "lessons.usageRecap.openAnytimeBody",
      },
    ],
  },

  // ── Agents & models ─────────────────────────────────────────────────────
  {
    id: "install-agent",
    category: "agentsModels",
    titleKey: "lessons.installAgent.title",
    blurbKey: "lessons.installAgent.blurb",
    steps: [
      {
        id: "open-add-menu",
        anchor: '[data-hint-anchor="tab-add"]',
        placement: "bottom",
        titleKey: "lessons.installAgent.openAddMenuTitle",
        bodyKey: "lessons.installAgent.openAddMenuBody",
      },
      {
        id: "pick-from-list",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.installAgent.pickFromListTitle",
        bodyKey: "lessons.installAgent.pickFromListBody",
      },
      {
        id: "only-installed",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.installAgent.onlyInstalledTitle",
        bodyKey: "lessons.installAgent.onlyInstalledBody",
      },
      {
        id: "manage-agents",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        titleKey: "lessons.installAgent.manageAgentsTitle",
        bodyKey: "lessons.installAgent.manageAgentsBody",
      },
      {
        id: "set-default",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        titleKey: "lessons.installAgent.setDefaultTitle",
        bodyKey: "lessons.installAgent.setDefaultBody",
      },
    ],
  },
  {
    id: "local-model",
    category: "agentsModels",
    titleKey: "lessons.localModel.title",
    blurbKey: "lessons.localModel.blurb",
    steps: [
      {
        id: "brain-button",
        anchor: '[aria-label="Local model"]',
        placement: "bottom",
        titleKey: "lessons.localModel.brainButtonTitle",
        bodyKey: "lessons.localModel.brainButtonBody",
      },
      {
        id: "pick-default",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.localModel.pickDefaultTitle",
        bodyKey: "lessons.localModel.pickDefaultBody",
      },
      {
        id: "role-chips",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.localModel.roleChipsTitle",
        bodyKey: "lessons.localModel.roleChipsBody",
      },
      {
        id: "manage-models",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        titleKey: "lessons.localModel.manageModelsTitle",
        bodyKey: "lessons.localModel.manageModelsBody",
      },
      {
        id: "agents-section",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.localModel.agentsSectionTitle",
        bodyKey: "lessons.localModel.agentsSectionBody",
      },
      {
        id: "use-autocomplete",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.localModel.useAutocompleteTitle",
        bodyKey: "lessons.localModel.useAutocompleteBody",
      },
    ],
  },
  {
    id: "add-local-model",
    category: "agentsModels",
    titleKey: "lessons.addLocalModel.title",
    blurbKey: "lessons.addLocalModel.blurb",
    steps: [
      {
        id: "open-brain",
        anchor: '[aria-label="Local model"]',
        placement: "bottom",
        titleKey: "lessons.addLocalModel.openBrainTitle",
        bodyKey: "lessons.addLocalModel.openBrainBody",
      },
      {
        id: "manage-models",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addLocalModel.manageModelsTitle",
        bodyKey: "lessons.addLocalModel.manageModelsBody",
      },
      {
        id: "pull-from-catalog",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addLocalModel.pullFromCatalogTitle",
        bodyKey: "lessons.addLocalModel.pullFromCatalogBody",
      },
      {
        id: "pull-by-name",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addLocalModel.pullByNameTitle",
        bodyKey: "lessons.addLocalModel.pullByNameBody",
      },
      {
        id: "manage-agents",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        titleKey: "lessons.addLocalModel.manageAgentsTitle",
        bodyKey: "lessons.addLocalModel.manageAgentsBody",
      },
    ],
  },

  // ── Advanced ────────────────────────────────────────────────────────────
  {
    id: "project-boxes",
    category: "advanced",
    titleKey: "lessons.projectBoxes.title",
    blurbKey: "lessons.projectBoxes.blurb",
    steps: [
      {
        id: "why-boxes",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.projectBoxes.whyBoxesTitle",
        bodyKey: "lessons.projectBoxes.whyBoxesBody",
      },
      {
        id: "new-box",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "bottom",
        titleKey: "lessons.projectBoxes.newBoxTitle",
        bodyKey: "lessons.projectBoxes.newBoxBody",
      },
      {
        id: "assign-members",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.projectBoxes.assignMembersTitle",
        bodyKey: "lessons.projectBoxes.assignMembersBody",
      },
      {
        id: "box-dropdown",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.projectBoxes.boxDropdownTitle",
        bodyKey: "lessons.projectBoxes.boxDropdownBody",
      },
      {
        id: "box-scope",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.projectBoxes.boxScopeTitle",
        bodyKey: "lessons.projectBoxes.boxScopeBody",
      },
    ],
  },
  {
    id: "docker-sandbox",
    category: "advanced",
    titleKey: "lessons.dockerSandbox.title",
    blurbKey: "lessons.dockerSandbox.blurb",
    steps: [
      {
        id: "why-sandbox",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.dockerSandbox.whySandboxTitle",
        bodyKey: "lessons.dockerSandbox.whySandboxBody",
      },
      {
        id: "open-pill-menu",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.dockerSandbox.openPillMenuTitle",
        bodyKey: "lessons.dockerSandbox.openPillMenuBody",
      },
      {
        id: "flip-toggle",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.dockerSandbox.flipToggleTitle",
        bodyKey: "lessons.dockerSandbox.flipToggleBody",
      },
      {
        id: "image",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.dockerSandbox.imageTitle",
        bodyKey: "lessons.dockerSandbox.imageBody",
      },
      {
        id: "lifetime",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.dockerSandbox.lifetimeTitle",
        bodyKey: "lessons.dockerSandbox.lifetimeBody",
      },
    ],
  },
  {
    id: "add-ssh-project",
    category: "advanced",
    titleKey: "lessons.addSshProject.title",
    blurbKey: "lessons.addSshProject.blurb",
    steps: [
      {
        id: "open-add-menu",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "top",
        titleKey: "lessons.addSshProject.openAddMenuTitle",
        bodyKey: "lessons.addSshProject.openAddMenuBody",
      },
      {
        id: "flip-ssh-toggle",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addSshProject.flipSshToggleTitle",
        bodyKey: "lessons.addSshProject.flipSshToggleBody",
      },
      {
        id: "optional-vpn",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addSshProject.optionalVpnTitle",
        bodyKey: "lessons.addSshProject.optionalVpnBody",
      },
      {
        id: "connect-ssh",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addSshProject.connectSshTitle",
        bodyKey: "lessons.addSshProject.connectSshBody",
      },
      {
        id: "browse-remote",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addSshProject.browseRemoteTitle",
        bodyKey: "lessons.addSshProject.browseRemoteBody",
      },
      {
        id: "create-mount",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.addSshProject.createMountTitle",
        bodyKey: "lessons.addSshProject.createMountBody",
      },
    ],
  },
  {
    id: "ssh-via-openvpn",
    category: "advanced",
    titleKey: "lessons.sshViaOpenvpn.title",
    blurbKey: "lessons.sshViaOpenvpn.blurb",
    steps: [
      {
        id: "open-add-menu",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "top",
        titleKey: "lessons.sshViaOpenvpn.openAddMenuTitle",
        bodyKey: "lessons.sshViaOpenvpn.openAddMenuBody",
      },
      {
        id: "flip-ssh-toggle",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.sshViaOpenvpn.flipSshToggleTitle",
        bodyKey: "lessons.sshViaOpenvpn.flipSshToggleBody",
      },
      {
        id: "enable-vpn",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.sshViaOpenvpn.enableVpnTitle",
        bodyKey: "lessons.sshViaOpenvpn.enableVpnBody",
      },
      {
        id: "pick-ovpn",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.sshViaOpenvpn.pickOvpnTitle",
        bodyKey: "lessons.sshViaOpenvpn.pickOvpnBody",
      },
      {
        id: "connect-vpn",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.sshViaOpenvpn.connectVpnTitle",
        bodyKey: "lessons.sshViaOpenvpn.connectVpnBody",
      },
      {
        id: "connect-ssh",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.sshViaOpenvpn.connectSshTitle",
        bodyKey: "lessons.sshViaOpenvpn.connectSshBody",
      },
      {
        id: "browse-and-create",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.sshViaOpenvpn.browseAndCreateTitle",
        bodyKey: "lessons.sshViaOpenvpn.browseAndCreateBody",
      },
    ],
  },
  {
    id: "vpn-tunnel",
    category: "advanced",
    titleKey: "lessons.vpnTunnel.title",
    blurbKey: "lessons.vpnTunnel.blurb",
    steps: [
      {
        id: "machine-wide",
        anchor: ".vpn-indicator-btn",
        placement: "bottom",
        titleKey: "lessons.vpnTunnel.machineWideTitle",
        bodyKey: "lessons.vpnTunnel.machineWideBody",
      },
      {
        id: "add-config",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.vpnTunnel.addConfigTitle",
        bodyKey: "lessons.vpnTunnel.addConfigBody",
      },
      {
        id: "up-down",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.vpnTunnel.upDownTitle",
        bodyKey: "lessons.vpnTunnel.upDownBody",
      },
      {
        id: "auto-launch",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.vpnTunnel.autoLaunchTitle",
        bodyKey: "lessons.vpnTunnel.autoLaunchBody",
      },
    ],
  },
  {
    id: "extend-to-remote",
    category: "advanced",
    titleKey: "lessons.extendToRemote.title",
    blurbKey: "lessons.extendToRemote.blurb",
    steps: [
      {
        id: "why-extend",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.extendToRemote.whyExtendTitle",
        bodyKey: "lessons.extendToRemote.whyExtendBody",
      },
      {
        id: "right-click-pill",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.extendToRemote.rightClickPillTitle",
        bodyKey: "lessons.extendToRemote.rightClickPillBody",
      },
      {
        id: "connect-host",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.extendToRemote.connectHostTitle",
        bodyKey: "lessons.extendToRemote.connectHostBody",
      },
      {
        id: "pick-remote-folder",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.extendToRemote.pickRemoteFolderTitle",
        bodyKey: "lessons.extendToRemote.pickRemoteFolderBody",
      },
      {
        id: "review-and-extend",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.extendToRemote.reviewAndExtendTitle",
        bodyKey: "lessons.extendToRemote.reviewAndExtendBody",
      },
    ],
  },
  {
    id: "compute-machines",
    category: "advanced",
    titleKey: "lessons.computeMachines.title",
    blurbKey: "lessons.computeMachines.blurb",
    steps: [
      {
        id: "why-machines",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.computeMachines.whyMachinesTitle",
        bodyKey: "lessons.computeMachines.whyMachinesBody",
      },
      {
        id: "open-hub",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.computeMachines.openHubTitle",
        bodyKey: "lessons.computeMachines.openHubBody",
      },
      {
        id: "shared-vs-synced",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.computeMachines.sharedVsSyncedTitle",
        bodyKey: "lessons.computeMachines.sharedVsSyncedBody",
      },
      {
        id: "sync-and-pull",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.computeMachines.syncAndPullTitle",
        bodyKey: "lessons.computeMachines.syncAndPullBody",
      },
      {
        id: "global-machines",
        anchor: ".machines-indicator-btn",
        placement: "bottom",
        titleKey: "lessons.computeMachines.globalMachinesTitle",
        bodyKey: "lessons.computeMachines.globalMachinesBody",
      },
      {
        id: "run-on-host",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.computeMachines.runOnHostTitle",
        bodyKey: "lessons.computeMachines.runOnHostBody",
      },
    ],
  },
  {
    id: "persistent-sessions",
    category: "advanced",
    titleKey: "lessons.persistentSessions.title",
    blurbKey: "lessons.persistentSessions.blurb",
    steps: [
      {
        id: "why-sessions",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.persistentSessions.whySessionsTitle",
        bodyKey: "lessons.persistentSessions.whySessionsBody",
      },
      {
        id: "which-tabs",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.persistentSessions.whichTabsTitle",
        bodyKey: "lessons.persistentSessions.whichTabsBody",
      },
      {
        id: "close-detaches",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.persistentSessions.closeDetachesTitle",
        bodyKey: "lessons.persistentSessions.closeDetachesBody",
      },
      {
        id: "sessions-view",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.persistentSessions.sessionsViewTitle",
        bodyKey: "lessons.persistentSessions.sessionsViewBody",
      },
      {
        id: "kill-rename",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.persistentSessions.killRenameTitle",
        bodyKey: "lessons.persistentSessions.killRenameBody",
      },
    ],
  },
  {
    id: "hpc-pipeline",
    category: "advanced",
    titleKey: "lessons.hpcPipeline.title",
    blurbKey: "lessons.hpcPipeline.blurb",
    steps: [
      {
        id: "why-hpc",
        anchor: ".project-pills-region",
        placement: "top",
        titleKey: "lessons.hpcPipeline.whyHpcTitle",
        bodyKey: "lessons.hpcPipeline.whyHpcBody",
      },
      {
        id: "open-add-menu",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "bottom",
        titleKey: "lessons.hpcPipeline.openAddMenuTitle",
        bodyKey: "lessons.hpcPipeline.openAddMenuBody",
      },
      {
        id: "step-login",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.hpcPipeline.stepLoginTitle",
        bodyKey: "lessons.hpcPipeline.stepLoginBody",
      },
      {
        id: "step-project",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.hpcPipeline.stepProjectTitle",
        bodyKey: "lessons.hpcPipeline.stepProjectBody",
      },
      {
        id: "step-data",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.hpcPipeline.stepDataTitle",
        bodyKey: "lessons.hpcPipeline.stepDataBody",
      },
      {
        id: "step-run-account",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.hpcPipeline.stepRunAccountTitle",
        bodyKey: "lessons.hpcPipeline.stepRunAccountBody",
      },
      {
        id: "step-run-submit",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.hpcPipeline.stepRunSubmitTitle",
        bodyKey: "lessons.hpcPipeline.stepRunSubmitBody",
      },
      {
        id: "step-watch",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.hpcPipeline.stepWatchTitle",
        bodyKey: "lessons.hpcPipeline.stepWatchBody",
      },
      {
        id: "without-wizard",
        anchor: null,
        placement: "bottom",
        titleKey: "lessons.hpcPipeline.withoutWizardTitle",
        bodyKey: "lessons.hpcPipeline.withoutWizardBody",
      },
    ],
  },
];
