# Phase 3 planning integration

> Phase 3.6 containment: `PlanningRequest.databaseDialect` is required; the adapter accepts only `mysql8` with `nexarch-mysql8-planning-v1`. `PlanningSpecification.databaseDialect` and `DatabaseDesign.dialect` repeat the decision in the proposal. PostgreSQL is unsupported, not silently converted. Existing approval/persistence paths remain untouched. The original NexArch author has explicitly authorized the ForgeWeb owner to use, modify, adapt, and integrate the NexArch source into ForgeWeb. This is project-specific authorization, not an assertion of an open-source license or broader unstated rights.

## Boundary and status

ForgeWeb remains the control plane. `server/generation/planning.ts` composes the three planning operations on the Phase 2 `GenerationEngine` boundary and returns a **proposed** planning specification. It never approves a specification, writes files, creates a project/version, provisions a database, or changes the product API/UI. The adapter is callable server-side but is **not yet wired into** the production `BuildWorkflow`; that workflow continues to use its current specification and generation path. Production rollout requires an explicit ForgeWeb approval/persistence mapping and a target-dialect decision. Do not present this as a live user feature yet.

The adapter is `server/generation/nexarch/adapter.ts`. It accepts ForgeWeb project/build/operation and actor context, validates base project identity, prompt, manifest, and the explicit `nexarch-mysql8-planning-v1` profile, and maps all results into ForgeWeb-owned types in `server/generation/engine.ts`. Complete analysis facets carry the information needed by the next stage. Architecture structure carries pages, services, entities, dependencies, decisions, and APIs for later code generation. Database design carries tables, field types, PKs, FKs, indexes, relationship delete behavior, and metadata. The database stage recomputes the deterministic architecture and rejects changed structural input. These are candidate planning artifacts; no `MasterSpecification.status = approved` is forged.

## Upstream source and scope

NexArch source was inspected at commit `398f4cbd9e314954eda95540411ed4d06cd50cf3` from `ashutoshsharma1309/nexarch`. The following pure planning source is retained under `server/generation/nexarch/upstream/`, with import extensions adapted from `.js` to `.ts` for ForgeWeb's Node/TypeScript setup:

| Upstream area | Files retained |
| --- | --- |
| `modules/analysis` | `analysis.types.ts`; `lib/completeness.ts`, `feature-extractor.ts`, `intent-detector.ts`, `knowledge-base.ts`, `lexicon.ts`, `normalize.ts`, `spec-builder.ts` |
| `modules/architecture` | `architecture.types.ts`; `lib/api-planner.ts`, `common.ts`, `database-planner.ts`, `dependency-planner.ts`, `folder-planner.ts`, `frontend-planner.ts`, `markdown-exporter.ts`, `module-planner.ts`, `scalability-planner.ts`, `security-planner.ts`, `technology-engine.ts` |
| `modules/database-designer` | `database-designer.types.ts`; `lib/column-inference.ts`, `knowledge.ts`, `optimization-planner.ts`, `relationship-engine.ts`, `table-designer.ts` |
| Shared contracts | `shared/types/requirement.ts`, `architecture.ts`, `design.ts`; `shared/utils/strings.ts` |

`upstream/planning.ts` is a small ForgeWeb-local orchestration adaptation of the three upstream services. The exact NexArch entry points are `analysis.service.ts:analyzeRequirements(prompt)`, `architecture.service.ts:planArchitecture(spec)`, and `database-designer.service.ts:designDatabase(architecture, requirements)`. The analysis service normalizes/detects/extracts/builds a spec or clarification questions. The architecture service composes the retained planners. The database service composes table, relationship, and optimization planners; this Phase 3 adaptation intentionally omits its Prisma/SQL/OpenAPI/ER/schema-emitter helpers because no schema or application code should be emitted here.

Upstream routers/controllers, logger/config, auth-stripping `public-mvp.ts`, database provisioning/persistence, AI orchestrators, agent mesh, runner, preview, repair, engineering graph, and backend/frontend generators are not imported. NexArch's upstream architecture service has a global `appAuth` switch that can strip authentication. This adaptation preserves the planner's authentication result and does not import that global config. No new package dependency was added.

The repository snapshot's root package declared `UNLICENSED` and no license file was visible during the audit. Repository metadata therefore does not independently establish a license. The user confirms explicit permission from the original NexArch author to use, modify, adapt, and integrate the source into ForgeWeb. Preserve attribution to the original project/author and the pinned source revision; do not infer rights beyond that stated permission.

## Compatibility and limits

- **Verified:** The deterministic task-management prompt produces `Users` and `Tasks` architecture entities, `/tasks` CRUD endpoints, a Tasks table, `assignee_id` FK to Users, and an index on that FK. The design-only adapter validates PK/FK/index references and relationship consistency. No provider call is made by these three selected planners.
- **Verified:** ForgeWeb scope/context is carried through each stage. The adapter rejects a changed project, actor, prompt, base project, or altered architecture. This is an internal server-side context check, not a substitute for deriving actor identity and authorizing project access in ForgeWeb's API.
- **Unresolved:** NexArch's planning database is MySQL 8 while ForgeWeb's current generated application path describes PostgreSQL. The adapter only accepts the explicit MySQL planning profile. Do not feed this plan to the current generator as if it were PostgreSQL-compatible.
- **Unresolved:** NexArch's deterministic default requirements and security choices are suggestions, not user-approved requirements. Human approval and ForgeWeb persistence mapping are not implemented in Phase 3.
- **Deployment-time adapter requirement:** If an AI-backed planner replaces the deterministic backend, inject it server-side through `PlanningBackend`; map its failure to `provider_failure`. No browser credential flow is added. Unexpected planner exceptions become sanitized `internal_engine_error` failures rather than fabricated plans.

## Validation and rollout

`server/tests/nexarch-planning.test.ts` exercises the real task prompt, three-stage adaptation, invalid input/profile, ownership context, tampered architecture, and an injected provider failure. The proposal has an empty files list and no Prisma/SQL schema payload. This test does not prove that a future generated application can build or run.

Before production use, add a ForgeWeb-owned approval step that turns a reviewed proposal into a `MasterSpecification` and records plan/database digests under ForgeWeb's project/version model; resolve MySQL versus PostgreSQL explicitly; derive actor context from the authenticated server request; and add isolated validation for any eventual generated source. These are later-phase gates, not Phase 3 behavior.
