/**
 * The guided **HPC pipeline wizard** (`docs/quirky-knitting-umbrella` plan Phase B).
 *
 * A newcomer to a SLURM cluster has to log in, create a project on the host, get
 * their data there, write a batch script, submit it, and tail the log — a lot of
 * steps, each easy to get subtly wrong. This stepper walks the whole path **by
 * composing the existing flows** rather than reimplementing them:
 *
 *  1. **Login** — `RemoteProjectSection` + `useRemoteSession` (SSH connect + optional
 *     OpenVPN + the live remote folder browser).
 *  2. **Project** — a name + local-mirror location → `create_project` (git-backed
 *     remote ⇒ lockstep on by default) → the project is created and activated.
 *  3. **Load data** (skippable) — pick local files → stream them to the host over
 *     the pooled SFTP (`remote_upload_file`).
 *  4. **Run job** — edit a starter `.slurm`'s `#SBATCH` directives (the Phase-A
 *     splice helpers), write it to the host, and **Submit** it (Phase-A
 *     `submitSlurmJob`, which opens a log tab).
 *  5. **Watch** — the log tab is already tailing; point at the Jobs view (⚙) and
 *     finish.
 *
 * Everything new is `untested` until QA'd on a real cluster.
 */

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { RemoteProjectSection } from "./RemoteProjectSection";
import { useRemoteSession } from "./useRemoteSession";
import { useHpcPipelineStore } from "../../stores/hpcPipeline";
import { useProjectsStore, stashRemotePassword } from "../../stores/projects";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
import { basename } from "../../lib/paths";
import { writeFileText } from "../embed/fileAccess";
import { UntestedTag } from "../common/UntestedTag";
import {
  parseSbatchDirectives,
  directiveValue,
  spliceDirective,
  submitSlurmJob,
  COMMON_SBATCH_KEYS,
} from "../../lib/slurm";

type Step = "login" | "project" | "data" | "run" | "watch";

/** Human labels for the `#SBATCH` keys the run step surfaces. */
const SBATCH_LABELS: Record<string, string> = {
  "job-name": "Job name",
  partition: "Partition",
  time: "Time",
  nodes: "Nodes",
  ntasks: "Tasks",
  "cpus-per-task": "CPUs/task",
  mem: "Memory",
  gres: "GRES",
  output: "Output",
};

/** A sensible starter batch script. Edit the `#SBATCH` directives to match your
 *  cluster's partitions/limits and your job's needs. */
const STARTER_SLURM = `#!/bin/bash
#SBATCH --job-name=myjob
#SBATCH --partition=<partition>
#SBATCH --time=01:00:00
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=8G
#SBATCH --output=slurm-%j.out

# Runs on a compute node via SLURM — never the login node.
# Check your cluster's usage policy (e.g. any acknowledgement it asks for).

module load Python
python --version
echo "Replace this with your job."
`;

const STARTER_NAME = "job.slurm";

/** Mounted once in AppShell; renders the wizard when the store says it's open. */
export function HpcPipelineWizardHost() {
  const open = useHpcPipelineStore((s) => s.open);
  const close = useHpcPipelineStore((s) => s.close);
  if (!open) return null;
  return <HpcPipelineWizard onClose={close} />;
}

function HpcPipelineWizard({ onClose }: { onClose: () => void }) {
  const addProject = useProjectsStore((s) => s.addProject);
  const remote = useRemoteSession({ kind: "new" });
  const {
    isRemoteProject,
    toggleRemoteProject,
    remoteBrowsePath,
    remoteChosenPath,
    setRemoteChosenPath,
    rememberChosenPath,
    remotePassword,
    buildRemoteSpec,
  } = remote;

  const [step, setStep] = useState<Step>("login");
  const [projectsRoot, setProjectsRoot] = useState("");
  const [mirrorParent, setMirrorParent] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<ProjectEntry | null>(null);

  // Force remote on for the whole wizard — an HPC project is remote by definition.
  useEffect(() => {
    if (!isRemoteProject) toggleRemoteProject(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the local roots from the backend defaults (mirror of ProjectDialog).
  useEffect(() => {
    invoke<string>("projects_root_dir").then(setProjectsRoot).catch(() => {});
    invoke<string>("remote_mirror_root_dir")
      .then((dir) => setMirrorParent((cur) => cur || dir.replace(/\/+$/, "")))
      .catch(() => {});
  }, []);

  const safeName = useMemo(
    () => name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""),
    [name],
  );

  // Commit the browsed remote folder and advance — mirrors ProjectDialog's
  // `useThisRemoteFolder`.
  const useThisFolder = () => {
    const chosen = remoteBrowsePath || "/";
    setRemoteChosenPath(chosen);
    rememberChosenPath(chosen);
    setStep("project");
  };

  const chooseMirror = async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: mirrorParent || undefined });
    if (typeof picked === "string") setMirrorParent(picked.replace(/\/+$/, ""));
  };

  const canCreate = Boolean(name.trim() && safeName && remoteChosenPath && mirrorParent.trim());

  const createProject = async () => {
    setError("");
    setBusy(true);
    try {
      const remoteSpec = buildRemoteSpec(safeName);
      const targetDir = projectsRoot ? `${projectsRoot}/${safeName}` : "";
      const project = await invoke<ProjectEntry>("create_project", {
        req: {
          name,
          directory: targetDir,
          description: "",
          gitType: "local",
          skipScaffold: false,
          remote: remoteSpec,
          mirrorParent,
        },
      });
      // Hand the just-authenticated credential to the project's first pooled
      // connect (single-use, never persisted — see stashRemotePassword).
      if (remotePassword) stashRemotePassword(project.id, remotePassword);
      rememberChosenPath();
      await addProject(project); // adds + activates (which connects)
      setCreated(project);
      setStep("data");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog hpc-wizard" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          HPC pipeline <UntestedTag />
        </h2>
        <StepTrail step={step} />
        {error && <div className="project-dialog-error">{error}</div>}

        {step === "login" && (
          <>
            <p className="ssh-optional-hint">
              Log in to your cluster. If it's only reachable through your
              institution's VPN, bring up the OpenVPN tunnel first (in the SSH
              section below).
            </p>
            <RemoteProjectSection
              kind="new"
              safeName={safeName}
              onClose={onClose}
              onUseThisFolder={useThisFolder}
              remote={remote}
            />
          </>
        )}

        {step === "project" && (
          <>
            <label>
              Project name
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-experiment"
              />
            </label>
            <label>
              Local location (synced mirror)
              <div className="folder-picker-row">
                <span title={mirrorParent}>{mirrorParent || "No folder selected"}</span>
                <button type="button" onClick={chooseMirror}>Browse...</button>
              </div>
              <span className="ssh-optional-hint">
                On the host: {remoteChosenPath}/{safeName || "<name>"}
              </span>
            </label>
            <div className="project-dialog-actions">
              <button type="button" onClick={() => setStep("login")}>Back</button>
              <button type="button" disabled={!canCreate || busy} onClick={() => void createProject()}>
                {busy ? "Creating…" : "Create project"}
              </button>
            </div>
          </>
        )}

        {step === "data" && created && (
          <DataStep
            project={created}
            onBack={() => setStep("project")}
            onNext={() => setStep("run")}
          />
        )}

        {step === "run" && created && (
          <RunStep
            project={created}
            onBack={() => setStep("data")}
            onSubmitted={() => setStep("watch")}
          />
        )}

        {step === "watch" && (
          <>
            <p>
              Your job was submitted and a log tab is now tailing its output. Open the
              Jobs view (the <strong>⚙</strong> toggle in the file panel) to see it
              queue, run, and finish — with per-job <em>Watch</em> and <em>Cancel</em>.
            </p>
            <div className="project-dialog-actions">
              <button type="button" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The step breadcrumb across the top of the wizard. */
function StepTrail({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "login", label: "Login" },
    { id: "project", label: "Project" },
    { id: "data", label: "Load data" },
    { id: "run", label: "Run job" },
    { id: "watch", label: "Watch" },
  ];
  const idx = steps.findIndex((s) => s.id === step);
  return (
    <div className="hpc-wizard-trail">
      {steps.map((s, i) => (
        <span
          key={s.id}
          className={`hpc-wizard-trail-step${i === idx ? " active" : ""}${i < idx ? " done" : ""}`}
        >
          {i + 1}. {s.label}
        </span>
      ))}
    </div>
  );
}

/** Step 3: upload local files to the host over the pooled SFTP. Skippable. */
function DataStep({
  project,
  onBack,
  onNext,
}: {
  project: ProjectEntry;
  onBack: () => void;
  onNext: () => void;
}) {
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const addFiles = async () => {
    setError("");
    const picked = await open({ multiple: true, directory: false });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    setBusy(true);
    try {
      for (const p of paths) {
        const name = basename(p);
        await invoke("remote_upload_file", {
          projectId: project.id,
          localPath: p,
          destRel: name,
        });
        setUploaded((u) => [...u, name]);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="ssh-optional-hint">
        Optionally upload input files to the project on the host. Large trees are
        better marked auto-sync in the file panel; this is for a few files.
      </p>
      {error && <div className="project-dialog-error">{error}</div>}
      <div className="folder-picker-row">
        <button type="button" disabled={busy} onClick={() => void addFiles()}>
          {busy ? "Uploading…" : "Add files…"}
        </button>
      </div>
      {uploaded.length > 0 && (
        <ul className="hpc-wizard-uploaded">
          {uploaded.map((f) => (
            <li key={f}>✓ {f}</li>
          ))}
        </ul>
      )}
      <div className="project-dialog-actions">
        <button type="button" onClick={onBack}>Back</button>
        <button type="button" onClick={onNext}>
          {uploaded.length ? "Next" : "Skip"}
        </button>
      </div>
    </>
  );
}

/** Step 4: edit a starter `.slurm`'s directives, write it to the host, submit. */
function RunStep({
  project,
  onBack,
  onSubmitted,
}: {
  project: ProjectEntry;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const [script, setScript] = useState(STARTER_SLURM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields = useMemo(() => parseSbatchDirectives(script), [script]);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const remoteRoot = project.remote?.remote_path ?? "";
  const scriptPath = `${remoteRoot.replace(/\/+$/, "")}/${STARTER_NAME}`;
  const projectDir = resolveProjectDirectory(project);

  const valueFor = (key: string) => edits[key] ?? directiveValue(fields, key);
  const commit = (key: string) => {
    const v = edits[key];
    if (v === undefined) return;
    setScript((s) => spliceDirective(s, key, v));
  };

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      // Write the (possibly edited) script to the host, then submit it.
      await writeFileText(scriptPath, script, project.id);
      await submitSlurmJob({
        file: scriptPath,
        projectDir,
        cwd: projectDir,
        projectId: project.id,
        scope: project.id,
        isRemote: true,
      });
      onSubmitted();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="ssh-optional-hint">
        A starter batch script (<code>{STARTER_NAME}</code>) will be written to the
        project. Adjust its resources, then submit — it runs on a compute node.
      </p>
      {error && <div className="project-dialog-error">{error}</div>}
      <div className="slurm-directive-grid">
        {COMMON_SBATCH_KEYS.map((key) => (
          <label key={key} className="slurm-directive-field">
            <span className="slurm-directive-key">{SBATCH_LABELS[key] ?? key}</span>
            <input
              className="file-viewer-run-args-input"
              value={valueFor(key)}
              spellCheck={false}
              onChange={(e) => setEdits((m) => ({ ...m, [key]: e.target.value }))}
              onBlur={() => commit(key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit(key);
                }
              }}
            />
          </label>
        ))}
      </div>
      <div className="project-dialog-actions">
        <button type="button" onClick={onBack}>Back</button>
        <button type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? "Submitting…" : "⏫ Submit job"}
        </button>
      </div>
    </>
  );
}
