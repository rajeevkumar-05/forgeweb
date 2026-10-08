import {
  Check,
  Code2,
  Database,
  Download,
  Expand,
  ExternalLink,
  FileCode2,
  History,
  Laptop,
  LoaderCircle,
  Monitor,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyProjectEdit,
  ApiRequestError,
  downloadProjectZip,
  getProjectWorkspace,
  openSafePreview,
  restoreProjectVersion,
  validateProjectExport,
  type ExportSummary,
  type ProjectWorkspace as Workspace,
} from "../lib/forgeweb-api";

type ProjectWorkspaceProps = {
  projectId: string;
  safeGeneration?: boolean;
  initialFilePaths: string[];
  validationCount: number;
  onProjectUpdated?: () => void;
};

type WorkspaceTab = "files" | "preview" | "database" | "versions";
type PreviewMode = "desktop" | "tablet" | "mobile";

const editPhases = ["Understanding request", "Identifying affected files", "Updating scoped source", "Validating project", "Refreshing preview"];
const viewportWidths: Record<PreviewMode, string> = { desktop: "100%", tablet: "768px", mobile: "390px" };

export default function ProjectWorkspace({ projectId, safeGeneration = false, initialFilePaths, validationCount, onProjectUpdated }: ProjectWorkspaceProps) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("files");
  const [mode, setMode] = useState<PreviewMode>("desktop");
  const [refreshKey, setRefreshKey] = useState(0);
  const [previewSrc, setPreviewSrc] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [safePreviewState, setSafePreviewState] = useState<"idle" | "starting" | "ready" | "unavailable" | "failed" | "unauthorized">("idle");
  const [safePreviewMessage, setSafePreviewMessage] = useState("");
  const pendingPreview = useRef<{ versionId: string; open: () => void } | undefined>(undefined);
  const previewExpiryTimer = useRef<number | undefined>(undefined);
  const [workspaceError, setWorkspaceError] = useState("");
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [openFile, setOpenFile] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const [completedPhases, setCompletedPhases] = useState<string[]>([]);
  const [restoring, setRestoring] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportSummary, setExportSummary] = useState<ExportSummary | null>(null);
  const isSafeVersion = safeGeneration || Boolean(workspace?.currentVersion?.candidateId);
  const workspaceSequence = useRef(0);

  const loadWorkspace = useCallback(async () => {
    const sequence = ++workspaceSequence.current;
    setLoading(true);
    setWorkspaceError("");
    try {
      const result = await getProjectWorkspace(projectId);
      if (sequence === workspaceSequence.current) setWorkspace(result);
    } catch (error) {
      if (sequence === workspaceSequence.current) setWorkspaceError(error instanceof Error ? error.message : "The stored project workspace could not be loaded.");
    } finally {
      if (sequence === workspaceSequence.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadWorkspace();
    return () => { workspaceSequence.current++; };
  }, [loadWorkspace]);

  useEffect(() => {
    if (tab !== "preview" || loading || !workspace || isSafeVersion) return;
    const url = `/api/projects/${encodeURIComponent(projectId)}/preview?v=${encodeURIComponent(workspace?.currentVersion?.id ?? "current")}&refresh=${refreshKey}`;
    let active = true;
    setPreviewError("");
    void fetch(url).then((response) => {
      if (!active) return;
      if (!response.ok) throw new Error("Preview could not start for this project version.");
      setPreviewSrc(url);
    }).catch((error) => {
      if (active) setPreviewError(error instanceof Error ? error.message : "Preview could not start.");
    });
    return () => { active = false; };
  }, [projectId, refreshKey, tab, workspace, loading, isSafeVersion]);

  useEffect(() => {
    setSafePreviewState("idle");
    setSafePreviewMessage("");
    pendingPreview.current = undefined;
    return () => {
      pendingPreview.current = undefined;
      window.clearTimeout(previewExpiryTimer.current);
    };
  }, [projectId, workspace?.currentVersion?.id]);

  const openRuntimePreview = async () => {
    if (loading || workspace?.project.id !== projectId || !workspace.currentVersion || safePreviewState === "starting") return;
    setSafePreviewState("starting");
    setSafePreviewMessage("Preview starting...");
    try {
      const pending = pendingPreview.current;
      pendingPreview.current = undefined;
      window.clearTimeout(previewExpiryTimer.current);
      if (pending && pending.versionId === workspace.currentVersion.id) {
        pending.open();
        setSafePreviewState("ready");
        setSafePreviewMessage("Preview opened in a new tab.");
        return;
      }
      const result = await openSafePreview(projectId, workspace.currentVersion.id);
      setSafePreviewState(result.status);
      if (result.status === "ready" && !result.opened) {
        pendingPreview.current = { versionId: workspace.currentVersion.id, open: result.open };
        setSafePreviewMessage("Preview ready. Your browser blocked automatic opening; select Open Preview to open the new tab.");
        previewExpiryTimer.current = window.setTimeout(() => {
          pendingPreview.current = undefined;
          setSafePreviewState("idle");
          setSafePreviewMessage("The preview session expired. Select Open Preview to create a fresh session.");
        }, Math.max(0, result.expiresAt - Date.now()));
      } else {
        setSafePreviewMessage(result.status === "ready" ? "Preview opened in a new tab." : result.message);
      }
    } catch (error) {
      const unauthorized = error instanceof ApiRequestError && [401, 403].includes(error.status);
      setSafePreviewState(unauthorized ? "unauthorized" : "failed");
      setSafePreviewMessage(unauthorized ? "Your session expired or this version belongs to another owner. Authenticate and try again." : error instanceof Error ? error.message : "Preview could not start.");
    }
  };

  const files = workspace?.files.map((file) => file.path) ?? initialFilePaths;
  const currentVersionId = workspace?.currentVersion?.id;

  const applyEdit = async () => {
    if (editBusy || editPrompt.trim().length < 12) return;
    setEditBusy(true);
    setEditError("");
    setChangedFiles([]);
    setCompletedPhases([]);
    try {
      const result = await applyProjectEdit(projectId, editPrompt);
      setCompletedPhases(result.phases);
      setWorkspace(result.workspace);
      setChangedFiles(result.modifiedFiles);
      setEditPrompt("");
      setRefreshKey((value) => value + 1);
      setTab("preview");
      onProjectUpdated?.();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Changes could not be applied. Your previous version is safe.");
      await loadWorkspace();
    } finally {
      setEditBusy(false);
    }
  };

  const restore = async (versionId: string) => {
    if (restoring) return;
    setRestoring(versionId);
    setEditError("");
    try {
      const restored = await restoreProjectVersion(projectId, versionId);
      setWorkspace(restored);
      setRefreshKey((value) => value + 1);
      setChangedFiles([]);
      onProjectUpdated?.();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "The version could not be restored.");
    } finally {
      setRestoring("");
    }
  };

  const prepareExport = async () => {
    setExportBusy(true);
    setExportError("");
    try {
      setExportSummary(await validateProjectExport(projectId));
      await loadWorkspace();
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Project validation failed.");
    } finally {
      setExportBusy(false);
    }
  };

  const makeZip = async () => {
    setExportBusy(true);
    setExportError("");
    try {
      await downloadProjectZip(projectId);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "ZIP creation failed.");
    } finally {
      setExportBusy(false);
    }
  };

  const versionLabel = workspace?.currentVersion ? `Version ${workspace.currentVersion.versionNumber}` : "Loading version";
  const orderedTabs = useMemo<Array<{ id: WorkspaceTab; label: string; icon: typeof FileCode2 }>>(() => [
    { id: "files", label: "Files", icon: FileCode2 },
    { id: "preview", label: "Preview", icon: Monitor },
    { id: "database", label: "Database", icon: Database },
    { id: "versions", label: "Versions", icon: History },
  ], []);

  return (
    <div className="project-workspace">
      <div className="workspace-tabs" role="tablist" aria-label="Generated project workspace">
        {orderedTabs.map(({ id, label, icon: Icon }, index) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "is-active" : index > 1 ? "is-secondary" : ""}
            onClick={() => setTab(id)}
            key={id}
          >
            <Icon />{label}
          </button>
        ))}
        <span>{versionLabel} · {workspace?.project.status.replaceAll("_", " ") ?? "loading"}</span>
      </div>

      {workspaceError && <div className="workspace-error"><strong>Project workspace unavailable.</strong><p>{workspaceError}</p><button type="button" onClick={() => void loadWorkspace()}><RefreshCw /> Retry workspace</button></div>}

      {isSafeVersion && !loading && workspace?.project.id === projectId && workspace.currentVersion?.validationStatus === "passed" && (
        <div className="preview-actions">
          <button type="button" className="button workspace-button" onClick={() => void openRuntimePreview()} disabled={safePreviewState === "starting"}>
            {safePreviewState === "starting" ? <LoaderCircle className="animate-spin" /> : <ExternalLink />}
            {safePreviewState === "starting" ? "Starting preview..." : "Open Preview"}
          </button>
          {safePreviewMessage && <p role="status" className={["failed", "unauthorized", "unavailable"].includes(safePreviewState) ? "workspace-error" : "workspace-muted"}>{safePreviewMessage}</p>}
        </div>
      )}

      {tab === "files" && (
        <div className="workspace-files" role="tabpanel">
          {(workspace?.files ?? []).map((file) => (
            <code key={file.path} className={openFile === file.path ? "is-open" : ""} onClick={() => setOpenFile(openFile === file.path ? "" : file.path)} role="button" tabIndex={0}>
              {file.path}
              {file.requirementIds.length > 0 && <span className="file-reqs">{file.requirementIds.join(", ")}</span>}
            </code>
          ))}
          {openFile && workspace?.files.find((file) => file.path === openFile) && (
            <pre className="file-viewer">{workspace.files.find((file) => file.path === openFile)!.content}</pre>
          )}
          {!workspace && files.map((path) => <code key={path}>{path}</code>)}
          {loading && <p className="workspace-muted"><LoaderCircle className="animate-spin" /> Loading stored project source…</p>}
        </div>
      )}

      {tab === "preview" && isSafeVersion && (
        <div className="workspace-preview" role="tabpanel"><p className="workspace-muted">{workspace?.project.name} · {versionLabel}</p></div>
      )}

      {tab === "preview" && !isSafeVersion && (
        <div className="workspace-preview" role="tabpanel">
          <div className="preview-toolbar">
            <div className="preview-modes" aria-label="Preview viewport">
              {([
                ["desktop", "Desktop", Laptop],
                ["tablet", "Tablet", Tablet],
                ["mobile", "Mobile", Smartphone],
              ] as const).map(([id, label, Icon]) => (
                <button type="button" className={mode === id ? "is-active" : ""} aria-pressed={mode === id} onClick={() => setMode(id)} key={id}><Icon />{label}</button>
              ))}
            </div>
            <button type="button" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw /> Refresh preview</button>
          </div>
          {previewError ? (
            <div className="workspace-error"><strong>Preview could not start.</strong><p>{previewError}</p><button type="button" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw /> Retry preview</button></div>
          ) : (
            <div className={`preview-stage is-${mode}`}>
              <iframe
                key={previewSrc}
                title={`${workspace?.project.name ?? "Generated project"} preview`}
                src={previewSrc || "about:blank"}
                sandbox=""
                style={{ width: viewportWidths[mode] }}
              />
            </div>
          )}
          <div className="preview-actions">
            <button type="button" className="button button-acid" onClick={() => setEditOpen(true)}><PencilLine /> Edit with AI</button>
            <button type="button" className="button workspace-button" onClick={() => { setTab("preview"); document.querySelector(".workspace-preview")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}><Expand /> Preview project</button>
          </div>
        </div>
      )}

      {tab === "database" && (
        <div className="workspace-database" role="tabpanel">
          <div className="database-heading"><div><span>Generated application database</span><h3>{workspace?.database.engine ?? "Loading…"}</h3></div><strong>{workspace?.database.tables.length ?? 0} tables</strong></div>
          <div className="database-tables">
            {workspace?.database.tables.map((table) => <article key={table.name}><Database /><div><code>{table.name}</code><p>{table.purpose}</p></div></article>)}
          </div>
          <p className="database-separation">{workspace?.database.separationNote}</p>
        </div>
      )}

      {tab === "versions" && (
        <div className="workspace-versions" role="tabpanel">
          {workspace?.versions.map((version) => {
            const current = version.id === currentVersionId;
            return (
              <article className={current ? "is-current" : ""} key={version.id}>
                <div className="version-number"><span>Version {version.versionNumber}</span>{current ? <strong><Check /> Current</strong> : <button type="button" onClick={() => void restore(version.id)} disabled={Boolean(restoring)}>{restoring === version.id ? <LoaderCircle className="animate-spin" /> : <RotateCcw />} Restore</button>}</div>
                <h3>{version.label}</h3>
                <p>{version.editPrompt}</p>
                <div className="version-meta"><span>{version.modifiedFiles.length} files</span><span>{version.validationStatus}</span><time>{new Date(version.createdAt).toLocaleString()}</time></div>
                <div className="version-files">{version.modifiedFiles.map((path) => <code key={path}>{path}</code>)}</div>
              </article>
            );
          })}
        </div>
      )}

      {editOpen && (
        <div className="workspace-edit-panel" aria-label="Edit generated project with AI">
          <div className="workspace-panel-heading"><div><span>Scoped project change</span><h3>Edit with AI</h3></div><button type="button" aria-label="Close edit panel" onClick={() => setEditOpen(false)}><X /></button></div>
          <label htmlFor={`edit-prompt-${projectId}`}>What would you like to change?</label>
          <textarea id={`edit-prompt-${projectId}`} value={editPrompt} onChange={(event) => setEditPrompt(event.target.value)} rows={4} placeholder="Make the navbar smaller, add a glass effect, and keep everything else unchanged." />
          {(editBusy || completedPhases.length > 0) && <div className="edit-progress">{editPhases.map((phase) => <span className={completedPhases.includes(phase) ? "is-complete" : editBusy ? "is-running" : ""} key={phase}>{completedPhases.includes(phase) ? <Check /> : <LoaderCircle className={editBusy ? "animate-spin" : ""} />}{phase}</span>)}</div>}
          {editError && <div className="workspace-error"><strong>Changes could not be applied.</strong><p>{editError}</p><small>Your previous working version remains safe.</small></div>}
          {changedFiles.length > 0 && <div className="changed-files"><strong><Check /> Changes applied · {changedFiles.length} files updated</strong>{changedFiles.map((path) => <code key={path}>{path}</code>)}</div>}
          <div className="workspace-panel-actions"><button type="button" className="button workspace-button" onClick={() => setEditOpen(false)}>Cancel</button><button type="button" className="button button-acid" disabled={editBusy || editPrompt.trim().length < 12} onClick={() => void applyEdit()}>{editBusy ? <LoaderCircle className="animate-spin" /> : <Code2 />}{editBusy ? "Applying changes…" : "Apply changes"}</button></div>
        </div>
      )}

      <div className="workspace-footer">
        <div><strong><Check /> Saved automatically</strong><span>{validationCount} generation checks passed · {workspace?.currentVersion?.validationStatus ?? "loading"}</span></div>
        <button type="button" className="button button-acid" onClick={() => void prepareExport()} disabled={exportBusy}>{exportBusy ? <LoaderCircle className="animate-spin" /> : <Download />} Make ZIP</button>
      </div>

      {exportError && <div className="workspace-error export-error"><strong>Project validation failed.</strong><p>{exportError}</p><small>Fix the issues before exporting this version.</small></div>}
      {exportSummary && (
        <div className="export-summary">
          <div className="workspace-panel-heading"><div><span>Validation passed</span><h3>Ready to export</h3></div><button type="button" aria-label="Close export summary" onClick={() => setExportSummary(null)}><X /></button></div>
          <dl><div><dt>Project</dt><dd>{exportSummary.projectName}</dd></div><div><dt>Current version</dt><dd>Version {exportSummary.versionNumber}</dd></div><div><dt>Frontend</dt><dd><Check /> {exportSummary.frontend}</dd></div><div><dt>Backend</dt><dd><Check /> {exportSummary.backend}</dd></div><div><dt>Database</dt><dd><Check /> {exportSummary.database}</dd></div><div><dt>Files</dt><dd>{exportSummary.fileCount}</dd></div></dl>
          <div className="workspace-panel-actions"><button type="button" className="button workspace-button" onClick={() => setExportSummary(null)}>Back to project</button><button type="button" className="button button-acid" disabled={exportBusy} onClick={() => void makeZip()}><Download /> Make ZIP</button></div>
        </div>
      )}
    </div>
  );
}
