import { useT } from "../../../lib/i18n";
import { openProjectDialog, type ProjectDialogKind } from "../../../lib/projects/projectDialogEvent";
import { useProjectsStore } from "../../../stores/projects";
import { UntestedTag } from "../../common/UntestedTag";
import { IntroActions, IntroStatus, IntroStep, IntroSteps, startLessonById } from "./introUi";

/**
 * Intro page 2 — what a project is, local vs remote, and the one click that
 * creates one. The buttons open the header + menu's own dialogs
 * (`openProjectDialog`); the wizard stays open underneath, so the ✓ below
 * lights up the moment the new pill lands.
 */
export function ProjectsPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const loaded = useProjectsStore((s) => s.loaded);
  const count = useProjectsStore((s) => s.projects.filter((p) => p.status !== "inactive").length);
  const open = (kind: ProjectDialogKind) => openProjectDialog(kind);

  return (
    <>
      <p className="settings-help">{t("intro.projects.lead")}</p>
      <IntroStatus ok={loaded ? count > 0 : null}>
        {!loaded
          ? t("intro.checking")
          : count > 0
            ? t("intro.projects.haveSome", { count })
            : t("intro.projects.none")}
      </IntroStatus>

      <div className="intro-compare">
        <div className="settings-card">
          <div className="how-to-start-step-title">{t("intro.projects.localTitle")}</div>
          <div className="settings-help">{t("intro.projects.localBody")}</div>
        </div>
        <div className="settings-card">
          <div className="how-to-start-step-title">{t("intro.projects.remoteTitle")}</div>
          <div className="settings-help">{t("intro.projects.remoteBody")}</div>
        </div>
      </div>

      <IntroSteps>
        <IntroStep num={1} title={t("intro.projects.step1Title")} done={count > 0}>
          <div className="settings-help">{t("intro.projects.step1Body")}</div>
          <IntroActions>
            <button type="button" className="settings-btn primary" onClick={() => open("new")}>
              {t("intro.projects.newProject")}
            </button>
            <button type="button" className="settings-btn" onClick={() => open("import")}>
              {t("intro.projects.importFolder")}
            </button>
            <button type="button" className="settings-btn" onClick={() => open("clone")}>
              {t("intro.projects.cloneRepo")}
            </button>
            <UntestedTag id="desktop.intro.projects" />
          </IntroActions>
        </IntroStep>
        <IntroStep num={2} title={t("intro.projects.step2Title")}>
          <div className="settings-help">{t("intro.projects.step2Body")}</div>
        </IntroStep>
        <IntroStep num={3} title={t("intro.projects.step3Title")}>
          <div className="settings-help">{t("intro.projects.step3Body")}</div>
          <IntroActions>
            <button type="button" className="settings-btn sm" onClick={() => startLessonById("add-project", onClose)}>
              {t("intro.walkMeThrough")}
            </button>
          </IntroActions>
        </IntroStep>
      </IntroSteps>
    </>
  );
}
