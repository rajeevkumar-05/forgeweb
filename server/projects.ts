import type { AuthenticatedUser } from "./auth.ts";
import type { ForgeDatabase, Project } from "./domain.ts";
import { ApiError, now } from "./lib.ts";
import { JsonStore } from "./store.ts";
import { BuildWorkflow } from "./workflow.ts";
import type { SafeGenerationActivationService } from "./generation/activation.ts";

export class OwnedProjects {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly store: JsonStore;
  private readonly workflow: BuildWorkflow;
  private readonly safe?: SafeGenerationActivationService;

  constructor(workflow: BuildWorkflow, safe?: SafeGenerationActivationService) {
    this.workflow = workflow;
    this.store = workflow.store;
    this.safe = safe;
  }

  requireOwner(projectId: string, user: AuthenticatedUser, database = this.store.read()): Project {
    const project = database.projects[projectId];
    if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found.");
    if (project.ownerId !== user.id) throw new ApiError(403, "PROJECT_ACCESS_DENIED", "This project is not owned by your ForgeWeb account.");
    return project;
  }

  list(user: AuthenticatedUser): Project[] {
    return this.workflow.listProjects().filter(project => project.ownerId === user.id);
  }

  // Serialize preview startup, workspace mutations and deletion for this project,
  // without blocking unrelated projects or using global Docker disposal.
  async run<T>(projectId: string, user: AuthenticatedUser, operation: () => Promise<T> | T): Promise<T> {
    const prior = this.locks.get(projectId) ?? Promise.resolve();
    const task = prior.catch(() => undefined).then(() => { this.requireOwner(projectId, user); return operation(); });
    this.locks.set(projectId, task);
    try { return await task; }
    finally { if (this.locks.get(projectId) === task) this.locks.delete(projectId); }
  }

  eligible(user: AuthenticatedUser): { standard: number; verified: number } {
    if (!user.canClaimLocalProjects) return { standard: 0, verified: 0 };
    const database = this.store.read();
    let standard = 0; let verified = 0;
    for (const project of Object.values(database.projects)) {
      if (project.ownerId) continue;
      if (this.isSafe(project, database)) { if (this.safe?.canClaimLegacy(project)) verified++; }
      else standard++;
    }
    return { standard, verified };
  }

  private isSafe(project: Project, database: ForgeDatabase): boolean {
    return Object.values(database.builds).some(build => build.projectId === project.id && build.generationMode === "safe");
  }

  async claim(user: AuthenticatedUser, confirmed: unknown, allowVerified: boolean): Promise<{ claimed: number }> {
    if (confirmed !== true) throw new ApiError(400, "CLAIM_CONFIRMATION_REQUIRED", "Explicitly confirm Claim existing projects.");
    if (!user.canClaimLocalProjects) throw new ApiError(403, "LOCAL_MIGRATION_OWNER_REQUIRED", "Only the first local ForgeWeb account can perform the legacy ownership migration.");
    return this.store.mutate(database => {
      let claimed = 0;
      for (const project of Object.values(database.projects)) {
        if (project.ownerId) continue;
        if (this.isSafe(project, database) && (!allowVerified || !this.safe?.canClaimLegacy(project))) continue;
        project.ownerId = user.id;
        project.ownershipClaim = { userId: user.id, claimedAt: now(), source: "local-migration" };
        project.updatedAt = project.ownershipClaim.claimedAt;
        claimed++;
      }
      return { claimed };
    });
  }

  async delete(projectId: string, user: AuthenticatedUser, confirmed: unknown): Promise<void> {
    if (confirmed !== true) throw new ApiError(400, "DELETE_CONFIRMATION_REQUIRED", "Confirm deletion before removing a project.");
    await this.run(projectId, user, async () => {
      const database = this.store.read();
      const builds = Object.values(database.builds).filter(build => build.projectId === projectId);
      if (this.workflow.isProjectRunning(projectId) || builds.some(build => !["awaiting_confirmation", "completed", "failed", "needs_context"].includes(build.status))) {
        throw new ApiError(409, "PROJECT_BUSY", "Wait for the active build to stop before deleting this project.");
      }
      await this.safe?.stopProjectPreview(projectId);
      await this.store.mutate(db => {
        this.requireOwner(projectId, user, db);
        const buildIds = new Set(Object.values(db.builds).filter(build => build.projectId === projectId).map(build => build.id));
        for (const [key, value] of Object.entries(db.versions)) if (value.projectId === projectId) { delete db.versionFiles[key]; delete db.versions[key]; }
        for (const [key, value] of Object.entries(db.generationCandidates)) if (value.projectId === projectId) delete db.generationCandidates[key];
        for (const [key, value] of Object.entries(db.planningRecords ?? {})) if (value.proposal.scope.projectId === projectId) delete db.planningRecords![key];
        for (const [key, value] of Object.entries(db.specifications)) if (value.projectId === projectId) delete db.specifications[key];
        for (const [key, value] of Object.entries(db.graphs)) if (value.projectId === projectId) delete db.graphs[key];
        for (const [key, value] of Object.entries(db.tasks)) if (buildIds.has(value.buildId)) delete db.tasks[key];
        for (const key of buildIds) { delete db.files[key]; delete db.events[key]; delete db.builds[key]; }
        // Snapshots are project/version-owned arrays, not digest-shared blobs.
        delete db.projects[projectId];
      });
    });
  }
}
