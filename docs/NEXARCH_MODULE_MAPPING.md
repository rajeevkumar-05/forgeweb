# NexArch Module Mapping

> Phase 3.6 update (2026-10-06): The original tables below are the Phase 1 proposal. The implemented Phase 3 subset is the 30 planning/shared files enumerated in [the Phase 3 inventory](NEXARCH_PHASE3_PLANNING.md), plus local orchestration and adapter files. All copied files are in the transitive closure of the selected analysis, architecture, or database-design planning helpers. No upstream router, controller, client, auth, provider, persistence, runner, generator, or agent module was included. Type-only shared design contracts contain future artifact shapes but do not execute schema emitters. No NexArch package dependency was added. The original NexArch author has explicitly authorized this use, modification, adaptation, and integration into ForgeWeb; this does not assert an open-source license or broader unstated rights.

Date: 2026-10-05. Proposal only: none of the source paths described below were created, copied, moved or modified in this audit.

Upstream root: [NexArch at 398f4cbd9e314954eda95540411ed4d06cd50cf3](https://github.com/ashutoshsharma1309/nexarch/tree/398f4cbd9e314954eda95540411ed4d06cd50cf3), created by the original NexArch author. Upstream paths are relative to that repository, not ForgeWeb. This is a bounded, authorized extraction/adaptation, subject to technical gates and tests, not a wholesale copy instruction.

## Ownership Table

| Responsibility | Final owner | ForgeWeb surface | NexArch treatment |
|---|---|---|---|
| Product shell, proposal, library, workspace UX | ForgeWeb | `src/App.tsx`, `src/components/BuildProposal.tsx`, `ProjectWorkspace.tsx`, `ProjectLibrary.tsx`, `SiteNav.tsx`, styles/assets | Exclude `client/` entirely. |
| API and error/status contract | ForgeWeb | `server/app.ts`, `src/lib/forgeweb-api.ts` | No upstream routers/controllers or response helpers. |
| Project/spec identity and approval | ForgeWeb | `server/domain.ts`, `server/workflow.ts`, `server/build-state.ts` | Map intermediate requirements/architecture; never call upstream project creation/start APIs. |
| Versions, edits, restore, export | ForgeWeb | `server/store.ts`, `server/project-workspace.ts`, existing ZIP helpers | Exclude upstream repositories; add candidate acceptance behind existing operations. |
| Task policy, scope, budget | ForgeWeb | `server/policy.ts` | Upstream roles never override policy. |
| Provider credentials and fallback | ForgeWeb | `server/llm/`, `server/env.ts` | Adapt prompts/context/usage; exclude provider registry/config/history. |
| Database/API design and source emission | ForgeWeb adapter | Proposed `server/generation/` | Adapt analysis, architecture, database, backend, frontend and security helpers. |
| Semantic graph and dependency impact | ForgeWeb snapshot service | Current graph projection plus proposed adapter | Adapt pure builders/queries; exclude upstream graph repository. |
| Context construction | ForgeWeb adapter | Proposed pinned artifact resolver/provider bridge | Adapt compiler/budget/sanitization; replace service/store lookup. |
| Runtime validation and preview | ForgeWeb execution boundary | Proposed isolated runner port | Reference upstream planning/evidence; exclude host runner and destructive provisioning. |
| Repair | ForgeWeb workflow/policy | Proposed repair adapter | Adapt eligibility/planning/strategies later; never mutate upstream latest-artifact stores. |
| Generated database/auth/users | Generated application | Its own versioned schema/config/runtime | Never share ForgeWeb control data, principals or credentials. |

## Preserve Versus Extend

**No replacement or redesign:** ForgeWeb branding, animation, layout, navigation, proposal/confirmation flow, project IDs, existing snapshots, restore history, ZIP expectations, response envelopes, provider choice, and policy/approval/independent-review authority. Keep generated templates separate from platform-only UI assets and licensing.

**Unchanged during the initial spike:** `src/`, `public/`, root `package.json`, lockfiles, Vite config, templates in `server/generated-frontend.ts` and `server/generated-backend.ts`, existing projects and JSON data. The legacy engine stays available for legacy-profile projects.

**Bounded future extensions, separately authorized:** `server/workflow.ts` for strategy selection after confirmation; `server/project-workspace.ts` for profile-aware compatibility, pinned preview/export and acceptance; `server/domain.ts`/`server/store.ts` for additive manifest/evidence/profile metadata; `server/policy.ts` for approved target budgets; `server/app.ts` only for later authorized preview-session routes. Preserve ownership, not a false promise that these server files will never need changes.

New-layout versions must never trigger the existing automatic legacy frontend upgrade. The compatibility guard must change before new output is accepted. Do not simply disable existing validation.

## Proposed ForgeWeb Files

These files are proposals, not files created by this audit. Keep the current single-server layout rather than introducing a new monorepo.

| Proposed destination | Responsibility |
|---|---|
| `server/generation/contracts.ts` | Runtime-validated IO, artifact/evidence/provenance and policy contracts; no public upstream types. |
| `server/generation/engine.ts` | Legacy/NexArch strategy selection pinned to operation and profile. |
| `server/generation/profiles.ts` | Versioned layout, dialect, dependencies, commands, preview capabilities and budgets. |
| `server/generation/artifacts.ts` | Candidate manifest, path/collision/traceability/digest checks, immutable lookup. |
| `server/generation/acceptance.ts` | Required gates, operation lease, compare-and-swap and atomic source/evidence/graph acceptance. |
| `server/generation/nexarch/adapter.ts` | Selected planners/emitters with injected config/logger/clock; returns candidates only. |
| `server/generation/nexarch/mapping.ts` | Requirement/spec/architecture/task/status/file translations and UI projections. |
| `server/generation/nexarch/provider-bridge.ts` | Existing provider calls, prompt versions, budgets, usage and strict response schemas. |
| `server/generation/nexarch/graph.ts` | Dependency/semantic graph adaptation, stable IDs, two-pass links, provenance. |
| `server/generation/nexarch/context.ts` | Project/run/version-verified context resolver; no legacy pipeline lookup. |
| `server/generation/nexarch/repair.ts` | Later bounded candidate patch loop; no direct canonical mutation. |
| `server/generation/runner-port.ts` | Isolated execution/evidence/session contract; no host npm execution. |
| `server/tests/generation-contracts.test.ts` | Type/traceability/path/profile/status/API compatibility fixtures. |
| `server/tests/generation-acceptance.test.ts` | Concurrency, crash/retry, evidence consistency and rollback. |
| `server/tests/nexarch-adapter.test.ts` | Deterministic fixtures, provider failure, overlays and dialect tests. |

The authorized integration source location is `server/generation/nexarch/`, retaining selected module-relative names and provenance to the original project and pinned revision. Any future reorganization should preserve that provenance. Prefer leaf imports: module `index.ts` files can wire routers, stores and observers.

## Core Generation Source Selection

The six service/type pairs and helper inventories below define the candidate source set. An import inside an emitted template is not an engine runtime dependency. Adapt shared strings once; inject logging/configuration rather than importing upstream singletons.

### analysis

Upstream directory: `server/src/modules/analysis/`.

Entry points: `analysis.service.ts`, `analysis.types.ts`. Helpers proposed for selective adaptation:

- `lib/completeness.ts`
- `lib/feature-extractor.ts`
- `lib/intent-detector.ts`
- `lib/knowledge-base.ts`
- `lib/lexicon.ts`
- `lib/normalize.ts`
- `lib/spec-builder.ts`

### architecture

Upstream directory: `server/src/modules/architecture/`.

Entry points: `architecture.service.ts`, `architecture.types.ts`. Helpers proposed for selective adaptation:

- `lib/api-planner.ts`
- `lib/common.ts`
- `lib/database-planner.ts`
- `lib/dependency-planner.ts`
- `lib/folder-planner.ts`
- `lib/frontend-planner.ts`
- `lib/markdown-exporter.ts`
- `lib/module-planner.ts`
- `lib/public-mvp.ts`
- `lib/scalability-planner.ts`
- `lib/security-planner.ts`
- `lib/technology-engine.ts`

### database-designer

Upstream directory: `server/src/modules/database-designer/`.

Entry points: `database-designer.service.ts`, `database-designer.types.ts`. Helpers proposed for selective adaptation:

- `lib/column-inference.ts`
- `lib/entity-metadata-generator.ts`
- `lib/er-diagram-generator.ts`
- `lib/knowledge.ts`
- `lib/openapi-generator.ts`
- `lib/optimization-planner.ts`
- `lib/prisma-generator.ts`
- `lib/relationship-engine.ts`
- `lib/schema-validator.ts`
- `lib/sql-generator.ts`
- `lib/table-designer.ts`
- `lib/validation-generator.ts`

### backend-generator

Upstream directory: `server/src/modules/backend-generator/`.

Entry points: `backend-generator.service.ts`, `backend-generator.types.ts`. Helpers proposed for selective adaptation:

- `lib/emit-app.ts`
- `lib/emit-auth-module.ts`
- `lib/emit-module.ts`
- `lib/emit-project-files.ts`
- `lib/emit-shared.ts`
- `lib/emit-tests.ts`
- `lib/file-tree.ts`
- `lib/project-model.ts`
- `lib/type-map.ts`

### frontend-generator

Upstream directory: `server/src/modules/frontend-generator/`.

Entry points: `frontend-generator.service.ts`, `frontend-generator.types.ts`. Helpers proposed for selective adaptation:

- `lib/emit-api.ts`
- `lib/emit-entity-pages.ts`
- `lib/emit-fixed-pages.ts`
- `lib/emit-forms.ts`
- `lib/emit-landing.ts`
- `lib/emit-layouts.ts`
- `lib/emit-project-files.ts`
- `lib/emit-routing.ts`
- `lib/emit-stores.ts`
- `lib/emit-styles.ts`
- `lib/emit-ui-data.ts`
- `lib/emit-ui-overlays.ts`
- `lib/emit-ui-primitives.ts`
- `lib/file-tree.ts`
- `lib/project-model.ts`
- `lib/site-content.ts`
- `lib/type-map.ts`

### security-engine

Upstream directory: `server/src/modules/security-engine/`.

Entry points: `security-engine.service.ts`, `security-engine.types.ts`. Helpers proposed for selective adaptation:

- `lib/authentication-module.ts`
- `lib/file-security.ts`
- `lib/file-tree.ts`
- `lib/frontend-security.ts`
- `lib/jwt-generator.ts`
- `lib/owasp-analyzer.ts`
- `lib/password-policy.ts`
- `lib/rbac-generator.ts`
- `lib/report-generator.ts`
- `lib/sanitization.ts`
- `lib/security-config.ts`
- `lib/security-model.ts`
- `lib/security-scanner.ts`
- `lib/type-map.ts`

## Mandatory Core Adaptations

| Module | Required adaptation | Not accepted unchanged |
|---|---|---|
| Analysis | Project/spec-qualified requirement mapping; ambiguities become clarification | Heuristics silently expanding approved scope. |
| Architecture | Structured design before confirmation; explicit target/auth policy | Global appAuth default. `public-mvp.ts` may only apply to explicitly approved public apps. |
| Database | Dialect selection across knowledge/inference/relationships/Prisma native types/SQL/metadata, verified with a real database | MySQL output labeled PostgreSQL; changing only URL or metadata. |
| Backend | Approved API manifest, implemented/stub classification, isolated target package and safe config metadata | Stub routes counted as implemented; base auth scaffold counted as hardened. |
| Frontend | Approved route set, actual backend capability, profile-owned layout/entry point/styling | Forced marketing landing page, upstream branding, or changes to ForgeWeb platform UI. |
| Security | Approved overlay collision list, dependency reconciliation, negative auth tests | Resolution flags treated as execution evidence; unauthorized path replacement. |

## Graph and Incremental Sources

Under `server/src/modules/dependency-graph/`, adapt computation in `dependency-graph.service.ts`, its `dependency-graph.types.ts`, and these helpers:

- `lib/change-detector.ts`, `lib/spec-differ.ts`, `lib/impact-analyzer.ts`
- `lib/project-scanner.ts`, `lib/import-analyzer.ts`, `lib/entity-analyzer.ts`, `lib/route-analyzer.ts`
- `lib/graph-builder.ts`, `lib/graph-optimizer.ts`, `lib/graph-serializer.ts`, `lib/node-id.ts`
- `lib/quality-analyzer.ts`, `lib/token-optimizer.ts`, `lib/file-tree.ts`

Use `lib/merge-engine.ts` only as a change-category reference; replace acceptance semantics with a ForgeWeb three-way merge. Exclude `lib/version-manager.ts`, a memory store keyed by project name. Remove service writes to that store. Unknown imports/dynamic paths broaden validation rather than implying no impact.

Under `server/src/modules/engineering-graph/`, adapt:

- `lib/graph-builder.ts`, `lib/canonical.ts`
- `lib/graph-validator.ts`, `lib/graph-queries.ts`, `lib/impact-analysis.ts`

Exclude `lib/graph-repository.ts` and service persistence/ownership orchestration. Build nodes before edges, preserve ForgeWeb IDs, and surface missing links. Do not import graph tables or describe this builder as CRG.

## Context and AI Sources

Under `server/src/modules/context-engine/`, adapt `context-engine.types.ts` and:

- `lib/compiler.ts`, `lib/resolver.ts`, `lib/artifact-selector.ts`
- `lib/budgets.ts`, `lib/compressor.ts`, `lib/relevance.ts`, `lib/sanitizer.ts`, `lib/token-counter.ts`

The service and `lib/context-cache.ts` are design references, not imported singletons. Replace ownership, legacy pipeline lookup and graph repository access with immutable resolution. Defer `lib/benchmark.ts` and trace/benchmark endpoints. Token budgets must reflect the configured provider/model, not upstream hardcoded capacity.

Under `server/src/modules/ai-orchestrator/`, selectively adapt:

- `lib/prompt-engine.ts`, `lib/prompt-compressor.ts`, `lib/context-builder.ts`
- `lib/retry-manager.ts`, `lib/token-estimator.ts`, `lib/cost-estimator.ts`
- `prompts/requirement-analyzer.md`, `prompts/architecture-planner.md`, `prompts/entity-fields.md`
- `prompts/backend-generator.md`, `prompts/frontend-generator.md`, `prompts/database-generator.md`
- `prompts/security-engine.md`, `prompts/dependency-engine.md`, `prompts/context-task.md`
- Later: `prompts/repair-engineer.md`, `prompts/test-planner.md`, `prompts/ux-reviewer.md`

Replace `lib/response-validator.ts` shallow checks with strict versioned runtime schemas. Reimplement scoped cache/usage at the ForgeWeb boundary. Exclude the AI service, `lib/workflow-engine.ts`, `lib/providers/`, `lib/model-router.ts`, `lib/cache-manager.ts`, `lib/generation-history.ts` and `lib/request-logger.ts` as runtime authorities. Product/site-copy prompts are deferred target decisions; builder prompts are excluded.

## Agent Review and Repair Sources

The mesh is not required for the first deterministic engine. Paths in this table are relative to `server/src/modules/agent-orchestrator/`.

| Exact sources | Proposed use | Adaptation |
|---|---|---|
| `lib/planner.ts`, `lib/scheduler.ts`, `lib/executor.ts` | Optional task DAG/execution helpers | ForgeWeb policy, deadlines, durable attempts, serialized writes; no independent Build lifecycle. |
| `lib/registry.ts`, `agents/requirement-analyst.ts`, `agents/architecture-agent.ts`, `agents/database-architect.ts`, `agents/backend-engineer.ts`, `agents/frontend-engineer.ts` | Reference role IO and specialist functions | Core service adapter first; no duplicate planning via legacy pipeline and mesh. |
| `lib/generation-manifest.ts`, `lib/consistency.ts`, `lib/contract-audit.ts` | Manifest/contract review | Pin candidate digests and approved requirement/API map. |
| `lib/dependency-review.ts`, `lib/quality-review.ts`, `lib/source-security.ts`, `lib/ux-checks.ts`, `lib/ux-improvements.ts`, `lib/review-summary.ts` | Additional findings | Read-only; distinguish heuristic findings from executed evidence. |
| `lib/test-plan.ts`, `lib/validation-summary.ts` | Test planning and evidence presentation | Required-check policy stays ForgeWeb-owned. |
| `lib/runtime-validation.ts`, `lib/integration-validation.ts`, `lib/test-executor.ts`, `lib/runnable-project.ts` | Reference commands/probes/file assembly | Replace host execution/session dependencies with isolated runner and explicit overlays. |
| `lib/repair-eligibility.ts`, `lib/repair-analysis.ts`, `lib/repair-strategies.ts`, `lib/line-diff.ts` | Later repair planning and proposals | Base hashes, authorized scope, fixed budgets and sensitive-change review. |
| `lib/repair-engine.ts`, `lib/repair-files.ts`, `lib/repair-validator.ts`, `agents/repair-engineer.ts` | Reference bounded loop | Reimplement with candidates, exception-safe discard, full regression gates and hard deadlines; not direct imports. |

Exclude the agent service and state authorities `lib/artifact-store.ts`, `lib/run-store.ts`, `lib/finding-store.ts`, `lib/repair-store.ts`, `lib/validation-store.ts`, `lib/validation-session.ts`, `lib/agent-result-cache.ts`, `lib/graph-sync.ts`. Translate useful records into ForgeWeb manifests/evidence. No cross-task inputs from mutable latest artifacts.

## Pipeline, Runner and Workspace

| Exact upstream source | Decision |
|---|---|
| `server/src/modules/pipeline/pipeline.service.ts` | Reference stage order/security overlays only; exclude start/run maps and automatic lifecycle. |
| `server/src/modules/pipeline/lib/ai-stages.ts` | Reference planning/fallback; selected calls use ForgeWeb providers before approval. |
| `server/src/modules/pipeline/pipeline.types.ts` | Private type subset only if needed by pure builders; sever dependency on service. |
| `server/src/modules/pipeline/lib/run-store.ts` and recorder wiring | Exclude; ForgeWeb owns operations/artifacts. |
| `server/src/modules/runner/lib/command-planner.ts`, `runner.types.ts` | Reference pure plan/evidence shapes; adapt to target profiles and approved commands. |
| `server/src/modules/runner/lib/workspace-writer.ts`, `child-env.ts` | Reference checks, not proof of isolation. Enforce containment/secrets in new runner. |
| `server/src/modules/runner/runner.service.ts`, `lib/process-supervisor.ts`, `lib/database-provisioner.ts` and other host lifecycle helpers | Exclude execution path and destructive provisioning. |
| `server/src/modules/workspace/workspace.service.ts`, `lib/project-store.ts`, workspace import/demo/persistence API | Exclude; preserve ForgeWeb projects, versions and export. |

## Shared Contracts

Adapt private subsets of these exact upstream paths:

- `server/src/shared/types/requirement.ts`, `architecture.ts`, `design.ts`
- `server/src/shared/types/product.ts`, `validation.ts`, `repair.ts`
- `server/src/shared/contracts/artifact.ts`, `agent-context.ts`, `agent.ts`, `task.ts`, `agent-registry.ts`, `engineering-graph.ts`
- `server/src/shared/utils/strings.ts`

Keep names private/namespaced. Validate IDs, size limits, statuses, paths, evidence and versions at runtime. Model output never supplies authoritative principal, requirement IDs or policy digests.

Exclude `shared/contracts/project.ts` as canonical project, `shared/types/generation.ts` as canonical run state, `shared/types/api.ts`/`express.d.ts` as wire contracts, and contract/module barrels as import surfaces. Exclude `shared/config/`, `shared/database/`, platform logger/middleware/auth and `server/prisma/`.

## Explicit Non-Integration List

- Upstream manifests, lockfiles, workspace/build/lint scripts, and container/compose deployment stack.
- `client/`, `server/src/app.ts`, server entry point, controllers/routers and wiring `index.ts` files.
- Platform auth/workspace/health APIs and PostgreSQL user/project/generation/graph schema.
- `builder-agent`, `deployment`, `insights`, `review` scaffold, standalone `quality` platform module. Selected agent review helpers above are a separate bounded choice.
- State singletons, project-name versioning, provider registry, default local admin, host runner and destructive provisioning.
- Demo/import/console flows, dashboard graph components, branding and platform-only assets in customer exports.

## Test References

Each core module has `<module>.service.test.ts` at its root. Relevant additional tests: `agent-orchestrator.service.test.ts`, `planning-mesh.test.ts`, `generation-mesh.test.ts`, `review-mesh.test.ts`, `validation-mesh.test.ts`, `repair-loop.test.ts`, `agent-cache.test.ts` under agent-orchestrator, plus the dependency-graph, engineering-graph, context-engine, ai-orchestrator, pipeline and runner service tests under their modules. No tests were copied or executed.

Do not run `engineering-graph.integration.test.ts` or `workspace.integration.test.ts` against ForgeWeb data: they assume upstream Prisma persistence. Port behavioral assertions into ForgeWeb fixtures; add exception/concurrency/hostile-input coverage. Verify the transitive import closure and template/third-party notices in the authorized extraction spike before adding dependencies.

See [audit](NEXARCH_INTEGRATION_AUDIT.md), [plan](NEXARCH_INTEGRATION_PLAN.md), and [risks](NEXARCH_MIGRATION_RISKS.md).
