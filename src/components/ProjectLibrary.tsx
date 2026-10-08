import { FolderOpen, LoaderCircle, Menu, MoreVertical, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { claimExistingProjects, deleteProject, getBuild, getProjectWorkspace, listProjects, type BuildResponse, type ProjectSummary } from "../lib/forgeweb-api";

type ProjectLibraryProps = {
  activeProjectId?: string;
  refreshToken: number;
  userId?: string;
  busy?: boolean;
  migration: { standard: number; verified: number };
  account: ReactNode;
  onOpen: (build: BuildResponse) => void;
  onNew: () => void;
  onDeleted: (projectId: string) => void;
  onClaimed: () => Promise<void>;
};

export default function ProjectLibrary({ activeProjectId, refreshToken, userId, busy = false, migration, account, onOpen, onNew, onDeleted, onClaimed }: ProjectLibraryProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState("");
  const [error, setError] = useState("");
  const loadSequence = useRef(0);
  const openingSequence = useRef(0);
  const previousAuthentication = useRef(userId);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!userId) { setProjects([]); setLoading(false); setError(""); return; }
    setLoading(true);
    setError("");
    try {
      const result = await listProjects();
      if (sequence === loadSequence.current) setProjects([...new Map(result.map(project => [project.id, project])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
    } catch (loadError) {
      if (sequence === loadSequence.current) { setProjects([]); setError(loadError instanceof Error ? loadError.message : "Projects could not be loaded."); }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (previousAuthentication.current !== userId) {
      setProjects([]);
      setOpening("");
      previousAuthentication.current = userId;
    }
    void load();
    return () => { loadSequence.current++; };
  }, [load, refreshToken, userId]);

  const openProject = async (project: ProjectSummary) => {
    if (!project.currentBuildId || busy) return;
    const sequence = loadSequence.current;
    const opening = ++openingSequence.current;
    const current = () => sequence === loadSequence.current && opening === openingSequence.current;
    setOpening(project.id);
    setError("");
    try {
      await getProjectWorkspace(project.id);
      if (!current()) return;
      const build = await getBuild(project.currentBuildId);
      if (!current()) return;
      onOpen(build);
      setOpen(false);
      window.setTimeout(() => { if (current()) document.querySelector(".build-proposal")?.scrollIntoView({ behavior: "smooth", block: "start" }); }, 50);
    } catch (openError) {
      if (current()) setError(openError instanceof Error ? openError.message : "Project could not be opened.");
    } finally {
      if (opening === openingSequence.current) setOpening("");
    }
  };

  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (deleting) dialog.current?.showModal(); else dialog.current?.close(); }, [deleting]);
  useEffect(() => { setDeleting(null); }, [userId]);
  const remove = async () => {
    if (!deleting || pending) return;
    setPending(true); setError("");
    try { await deleteProject(deleting.id); onDeleted(deleting.id); setDeleting(null); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Project deletion failed."); }
    finally { setPending(false); }
  };
  const claim = async () => {
    setPending(true); setError("");
    try { await claimExistingProjects(migration.verified > 0); await onClaimed(); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Ownership claim failed."); }
    finally { setPending(false); }
  };
  return createPortal(<>
    <button type="button" className="project-sidebar-toggle" aria-label="Open Projects sidebar" onClick={() => setOpen(true)}><Menu size={20} /></button>
    {open && <button type="button" className="project-sidebar-backdrop" aria-label="Close Projects sidebar" onClick={() => setOpen(false)} />}
    <aside className={`project-sidebar ${open ? "is-open" : ""}`} aria-label="Projects sidebar">
      <header><a href="#top"><img src="/forgeweb-logo-gold.png" alt="" />ForgeWeb</a><button className="sidebar-close" type="button" aria-label="Close Projects sidebar" onClick={() => setOpen(false)}><X size={18} /></button></header>
      <button type="button" className="sidebar-new" disabled={!userId || busy} onClick={() => { openingSequence.current++; setOpening(""); onNew(); setOpen(false); }}><Plus size={18} />New Project</button>
      {account}
      {userId && (migration.standard > 0 || migration.verified > 0) && <div className="project-claim"><p>{migration.standard + migration.verified} unowned local projects</p><button type="button" disabled={pending || busy} onClick={() => void claim()}>Claim existing projects</button></div>}
      <div className="sidebar-heading"><h2>Projects</h2><button type="button" title="Refresh projects" aria-label="Refresh projects" disabled={!userId || pending} onClick={() => void load()}><RefreshCw size={16} className={loading ? "animate-spin" : ""} /></button></div>
      {error && <p className="workspace-error" role="alert">{error}</p>}
      <div className="sidebar-projects" aria-busy={loading}>
        {loading && <p role="status"><LoaderCircle size={16} className="animate-spin" /> Loading projects...</p>}
        {projects.map(project => <div className={`sidebar-project ${project.id === activeProjectId ? "is-active" : ""}`} key={project.id}>
          <button type="button" className="sidebar-project-open" aria-current={project.id === activeProjectId ? "page" : undefined} disabled={busy || pending || !project.currentBuildId || opening === project.id} onClick={() => void openProject(project)}>
            {opening === project.id ? <LoaderCircle size={16} className="animate-spin" /> : <FolderOpen size={16} />}<span><strong>{project.name}</strong><small>{project.status.replaceAll("_", " ")} · v{project.currentVersionNumber ?? 0}</small></span>
          </button>
          <details className="sidebar-actions"><summary aria-label={`Actions for ${project.name}`} title="Project actions"><MoreVertical size={16} /></summary><div><button type="button" disabled={busy || pending} onClick={() => void openProject(project)}><FolderOpen size={14} />Open</button><button type="button" disabled={busy || pending} onClick={() => { setError(""); setDeleting(project); }}><Trash2 size={14} />Delete</button></div></details>
        </div>)}
        {userId && !loading && !error && !projects.length && <p>No projects yet</p>}
      </div>
    </aside>
    <dialog ref={dialog} className="project-delete-dialog" onCancel={event => { if (pending) event.preventDefault(); else setDeleting(null); }} aria-labelledby="delete-project-title">
      <h2 id="delete-project-title">Delete "{deleting?.name}"?</h2><p>This will remove the project and its associated project data.</p>{error && <p role="alert">{error}</p>}
      <div><button type="button" disabled={pending} onClick={() => setDeleting(null)}>Cancel</button><button type="button" className="delete-confirm" disabled={pending} onClick={() => void remove()}><Trash2 size={16} />{pending ? "Deleting..." : "Delete Project"}</button></div>
    </dialog>
  </>, document.body);
}
