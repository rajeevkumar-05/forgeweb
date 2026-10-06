import { ArrowRight, Boxes, Check, Code2, Database, ExternalLink, FileCode2, PencilLine, Server, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import type { BuildResponse } from "../lib/forgeweb-api";
import ProjectWorkspace from "./ProjectWorkspace";

type BuildProposalProps = {
  build: BuildResponse | null;
  busy: boolean;
  onConfirm: () => void;
  onRevise?: (notes: string) => void;
  onProjectUpdated?: () => void;
};

export default function BuildProposal({ build, busy, onConfirm, onRevise, onProjectUpdated }: BuildProposalProps) {
  const specification = build?.specification;
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseNotes, setReviseNotes] = useState("");
  if (!build || !specification || build.status === "queued" || build.status === "specifying" || build.status === "planning") return null;

  const architecture = specification.architecture;
  const awaiting = build.status === "awaiting_confirmation";
  const complete = build.status === "completed";

  const submitRevision = () => {
    if (!onRevise || reviseNotes.trim().length < 12 || busy) return;
    onRevise(reviseNotes.trim());
    setReviseOpen(false);
    setReviseNotes("");
  };

  return (
    <motion.section
      className="build-proposal"
      aria-label="Generated requirements and architecture"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      <div className="build-proposal-heading">
        <div>
          <p className="build-proposal-kicker"><span /> {awaiting ? "Approval required" : complete ? "Verified build" : "Generation in progress"}</p>
          <h2>{specification.productName}</h2>
          <p>{specification.summary}</p>
        </div>
        <div className={`build-proposal-state ${complete ? "is-complete" : ""}`}>
          {complete ? <Check /> : <Boxes />}
          {complete ? "Generated" : specification.status === "approved" ? "Approved" : "Proposed"}
        </div>
      </div>

      <div className="build-proposal-section">
        <div className="build-proposal-title"><FileCode2 /> Requirements <span>{specification.requirements.length}</span></div>
        <div className="build-requirements-grid">
          {specification.requirements.map((requirement) => (
            <article key={requirement.id}>
              <span>{requirement.id} · {requirement.priority}</span>
              <h3>{requirement.title}</h3>
              <p>{requirement.description}</p>
            </article>
          ))}
        </div>
      </div>

      <div className="build-proposal-section">
        <div className="build-proposal-title"><Boxes /> Proposed architecture</div>
        <p className="build-system-shape">{architecture.systemShape}</p>
        <div className="architecture-grid">
          <article><Code2 /><span>Frontend</span><strong>{architecture.frontend.framework}</strong><p>{architecture.frontend.pages.slice(0, 3).join(" · ")}</p></article>
          <article><Server /><span>Backend</span><strong>{architecture.backend.runtime}</strong><p>{architecture.backend.apiStyle}</p></article>
          <article><Database /><span>Data</span><strong>{architecture.data.database}</strong><p>{architecture.data.entities.join(" · ")}</p></article>
          <article><ShieldCheck /><span>Security</span><strong>Server enforced</strong><p>{architecture.security.slice(0, 2).join(" · ")}</p></article>
        </div>
      </div>

      <div className="build-proposal-section">
        <div className="build-proposal-title"><ExternalLink /> Customer-app capabilities</div>
        <p className="build-capability-note">These integrations are for the application your user generates—not decorations added to ForgeWeb itself.</p>
        <div className="build-capabilities">
          {architecture.capabilities.map((capability) => (
            <a href={capability.sourceUrl} target="_blank" rel="noreferrer" key={capability.id}>
              <span>{capability.name}<ExternalLink /></span>
              <p>{capability.usage}</p>
            </a>
          ))}
        </div>
      </div>

      <details className="architecture-file" open>
        <summary><span><FileCode2 /> ARCHITECTURE.md</span><span>Generated proposal</span></summary>
        <pre>{architecture.markdown}</pre>
      </details>

      {awaiting && (
        <div className="build-confirmation-gate">
          <div>
            <strong>Ready for your decision</strong>
            <p>Confirming freezes this specification, then starts frontend and backend generation.</p>
          </div>
          <div className="build-confirmation-actions">
            {onRevise && (
              <button type="button" className="button workspace-button" onClick={() => setReviseOpen((value) => !value)} disabled={busy}>
                <PencilLine /> Revise
              </button>
            )}
            <button type="button" className="button button-acid" onClick={onConfirm} disabled={busy}>
              {busy ? "Starting build…" : "Confirm requirements & generate"}<ArrowRight />
            </button>
          </div>
        </div>
      )}

      {awaiting && reviseOpen && (
        <div className="build-revise-panel">
          <label htmlFor="revise-notes">What should be changed in the specification?</label>
          <textarea id="revise-notes" value={reviseNotes} onChange={(event) => setReviseNotes(event.target.value)} rows={3} placeholder="Add a public storefront page, remove the admin role, change the database to SQLite…" />
          <div className="build-revise-actions">
            <button type="button" className="button workspace-button" onClick={() => setReviseOpen(false)}>Cancel</button>
            <button type="button" className="button button-acid" disabled={busy || reviseNotes.trim().length < 12} onClick={submitRevision}>
              <PencilLine /> {busy ? "Revising…" : "Submit revision"}
            </button>
          </div>
        </div>
      )}

      {build.filePaths.length > 0 && (
        <div className="generated-artifacts">
          <div className="build-proposal-title"><Code2 /> Generated frontend + backend <span>{build.filePaths.length} files</span></div>
          <ProjectWorkspace projectId={build.projectId} initialFilePaths={build.filePaths} validationCount={build.validationChecks.filter((check) => check.status === "passed").length} onProjectUpdated={onProjectUpdated} />
          {complete && <p><Check /> {build.validationChecks.filter((check) => check.status === "passed").length} validation checks passed{build.validationChecks.some((check) => check.status === "skipped") ? `, ${build.validationChecks.filter((check) => check.status === "skipped").length} skipped` : ""}. Requirement graph synchronized.</p>}
        </div>
      )}
    </motion.section>
  );
}
