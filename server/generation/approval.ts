import type { ForgeDatabase, Project, MasterSpecification } from "../domain.ts";
import { digest, id, now } from "../lib.ts";
import { JsonStore } from "../store.ts";
import { fileManifestDigest, prepareGenerationRequest } from "./contract.ts";
import type { BaseReference, EngineActor, EngineMetadata, GenerationOptions, GenerationRequest } from "./engine.ts";
import type { PlanningSpecification } from "./planning.ts";
import { APPLICATION_TARGET, requireApplicationTarget } from "./targets.ts";

export type PlanRecord = {
  id: string;
  revision: number;
  specificationId: string;
  proposedSpecificationDigest: string;
  proposal: PlanningSpecification;
  base: BaseReference;
  engine: EngineMetadata;
  options: GenerationOptions;
  createdAt: string;
  digest: string;
  approval?: { planDigest: string; specificationDigest: string; subjectId: string; ownerId: string; confirmedAt: string };
};

/** Supplied by ForgeWeb's trusted request/auth layer, never by an engine or HTTP body. */
export type OwnerVerifier = (project: Readonly<Project>, actor: EngineActor) => boolean | Promise<boolean>;
const denyUnverifiedOwner: OwnerVerifier = () => false;
function requireGate(value: unknown, message: string): asserts value { if (!value) throw new TypeError(message); }

export function planRecordDigest(record: Omit<PlanRecord, "digest"> | PlanRecord): string {
  const { id: planId, revision, specificationId, proposedSpecificationDigest, proposal, base, engine, options, createdAt } = record;
  return digest(JSON.stringify({ planId, revision, specificationId, proposedSpecificationDigest, proposal, base, engine, options, createdAt }));
}

function currentBase(database: ForgeDatabase, project: Project): BaseReference {
  if (!project.currentVersionId) {
    requireGate(!project.currentBuildId || !database.files[project.currentBuildId]?.length, "Legacy source requires an explicit immutable base version");
    return { kind: "empty", manifestDigest: fileManifestDigest([]) };
  }
  const version = database.versions[project.currentVersionId];
  requireGate(version?.projectId === project.id && database.versionFiles[version.id], "Base version is missing or belongs to another project");
  return { kind: "version", versionId: version.id, manifestDigest: fileManifestDigest(database.versionFiles[version.id]) };
}

export class PlanningApprovalService {
  private readonly store: JsonStore;
  private readonly verifyOwner: OwnerVerifier;
  constructor(store: JsonStore, verifyOwner: OwnerVerifier = denyUnverifiedOwner) { this.store = store; this.verifyOwner = verifyOwner; }

  private async authorizeOwner(project: Project | undefined, actor: EngineActor): Promise<void> {
    requireGate(project && actor.kind === "authenticated" && actor.subjectId && actor.ownerId, "Verified ForgeWeb owner required");
    requireGate(await this.verifyOwner(structuredClone(project), structuredClone(actor)), "ForgeWeb owner authorization unavailable or denied");
  }

  async save(proposal: PlanningSpecification, base: BaseReference, engine: EngineMetadata, options: GenerationOptions): Promise<PlanRecord> {
    const snapshot = structuredClone({ proposal, base, engine, options });
    ({ proposal, base, engine, options } = snapshot);
    requireApplicationTarget(snapshot.proposal);
    requireGate(options.targetProfile === APPLICATION_TARGET.profile, "Unsupported application profile");
    requireGate(proposal.state === "proposed" && proposal.architecture && proposal.database && !proposal.files.length && !proposal.analysis.questions.length, "Complete planning proposal required");
    return this.store.mutate(async (database) => {
      const { scope } = snapshot.proposal;
      const project = database.projects[scope.projectId];
      await this.authorizeOwner(project, scope.actor);
      const build = database.builds[scope.buildId];
      requireGate(build?.projectId === project.id && project.currentBuildId === build.id && build.status === "awaiting_confirmation", "Build must be current and awaiting confirmation");
      requireGate(JSON.stringify(currentBase(database, project)) === JSON.stringify(base), "Base version changed");
      const records = database.planningRecords ??= {};
      const revision = Math.max(0, ...Object.values(records).filter((record) => record.proposal.scope.buildId === build.id).map((record) => record.revision)) + 1;
      const specificationId = id("spec");
      const facets = snapshot.proposal.analysis.facets;
      const specification: MasterSpecification = {
        id: specificationId, projectId: project.id, version: revision, status: "proposed", prompt: proposal.prompt,
        productName: facets?.productName ?? project.name, summary: proposal.prompt, roles: [...(facets?.roles ?? [])],
        entities: proposal.database!.entities.map((entity) => entity.name), assumptions: [...(facets?.missingRequirements ?? [])],
        requirements: proposal.analysis.proposedRequirements.map((requirement, index) => ({ ...structuredClone(requirement), acceptanceCriteria: [...requirement.acceptanceCriteria], id: `REQ-${String(index + 1).padStart(3, "0")}` })),
        architecture: structuredClone(proposal.architecture!.projection) as MasterSpecification["architecture"], createdAt: now(),
      };
      const record: PlanRecord = { ...snapshot, id: id("plan"), revision, specificationId, proposedSpecificationDigest: digest(JSON.stringify(specification)), createdAt: now(), digest: "" };
      record.digest = planRecordDigest(record);
      records[record.id] = record;
      database.specifications[specificationId] = specification;
      build.specificationId = specificationId;
      build.planningRecordId = record.id;
      build.confirmedAt = undefined;
      project.currentSpecificationId = specificationId;
      return structuredClone(record);
    });
  }

  private async checked(database: ForgeDatabase, planId: string, expectedDigest: string, projectId: string, actor: EngineActor): Promise<PlanRecord> {
    const record = database.planningRecords?.[planId];
    requireGate(record && record.proposal.scope.projectId === projectId, "Plan belongs to another project or is missing");
    await this.authorizeOwner(database.projects[projectId], actor);
    requireGate(JSON.stringify(actor) === JSON.stringify(record.proposal.scope.actor), "Plan belongs to another owner context");
    requireApplicationTarget(record.proposal);
    requireGate(record.digest === expectedDigest && record.digest === planRecordDigest(record), "Plan changed; new approval required");
    requireGate(database.builds[record.proposal.scope.buildId]?.planningRecordId === planId, "Plan was superseded");
    requireGate(database.builds[record.proposal.scope.buildId]?.specificationId === record.specificationId && database.projects[projectId].currentSpecificationId === record.specificationId, "Specification was superseded");
    requireGate(database.projects[projectId].currentBuildId === record.proposal.scope.buildId, "Build changed");
    requireGate(JSON.stringify(record.base) === JSON.stringify(currentBase(database, database.projects[projectId])), "Base version changed");
    return record;
  }

  async approve(planId: string, expectedDigest: string, projectId: string, actor: EngineActor): Promise<PlanRecord> {
    actor = structuredClone(actor);
    return this.store.mutate(async (database) => {
      const record = await this.checked(database, planId, expectedDigest, projectId, actor);
      const build = database.builds[record.proposal.scope.buildId];
      requireGate(build.status === "awaiting_confirmation", "Build is not awaiting confirmation");
      const specification = database.specifications[record.specificationId];
      requireGate(build.specificationId === specification?.id && JSON.stringify(specification.architecture) === JSON.stringify(record.proposal.architecture!.projection), "Specification changed");
      if (record.approval) {
        requireGate(record.approval.specificationDigest === digest(JSON.stringify(specification)), "Approved specification changed");
        return structuredClone(record);
      }
      requireGate(record.proposedSpecificationDigest === digest(JSON.stringify(specification)), "Proposed specification changed; replan before approval");
      specification.status = "approved";
      specification.confirmedAt = now();
      record.approval = { planDigest: record.digest, specificationDigest: digest(JSON.stringify(specification)), subjectId: actor.subjectId, ownerId: actor.ownerId!, confirmedAt: specification.confirmedAt };
      build.confirmedAt = specification.confirmedAt;
      build.stageDetail = "Plan approved. Generation capability is unavailable.";
      return structuredClone(record);
    });
  }

  /** Revalidates durable approval and current base; returns a structural request, never executes it. */
  async generationRequest(planId: string, expectedDigest: string, projectId: string, actor: EngineActor): Promise<GenerationRequest> {
    actor = structuredClone(actor);
    return this.store.mutate(async (database) => {
      const record = await this.checked(database, planId, expectedDigest, projectId, actor);
      const specification = database.specifications[record.specificationId];
      requireGate(record.approval?.planDigest === expectedDigest && record.approval.specificationDigest === digest(JSON.stringify(specification)), "Exact approved plan required");
      const design = { architecture: record.proposal.architecture!, database: record.proposal.database! };
      const base = record.base.kind === "empty"
        ? { ...record.base, projectId, files: [] as [] }
        : { ...record.base, projectId, files: database.versionFiles[record.base.versionId] };
      return prepareGenerationRequest({ scope: record.proposal.scope, base, options: record.options,
        approved: { specification: specification as GenerationRequest["approved"]["specification"], digest: record.approval!.specificationDigest, planDigest: digest(JSON.stringify(design)), planId: record.id, bindingDigest: record.digest }, design });
    });
  }
}
