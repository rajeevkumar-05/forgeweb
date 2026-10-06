# NexArch Integration Audit

> Phase 3.6 checkpoint update (2026-10-06): This document's original audit baseline and "no files copied" statements describe Phase 1, not the current integration branch. Phase 3 subsequently added 30 selected upstream planning files and a ForgeWeb adapter; see [Phase 3 source inventory](NEXARCH_PHASE3_PLANNING.md). The original NexArch author has explicitly authorized the ForgeWeb owner to use, modify, adapt, and integrate the NexArch source into ForgeWeb. This project-specific authorization does not assert that NexArch is open source, assign it a license, or imply rights beyond those stated. Preserve attribution to the original NexArch project and author.
>
> Checkpoint scope: **ForgeWeb integration baseline containing pre-existing ForgeWeb generation/product foundation work plus NexArch Phases 1–3.6 integration and safety-gate work.** The current working tree must not be represented as solely NexArch integration work.

Date: 2026-10-05. Status: inspection complete; implementation not authorized by this task.

## Executive Decision

Keep ForgeWeb as the product, control plane, approval authority, API, workspace, version store, and provider configuration authority. Integrate selected NexArch generation functions behind a ForgeWeb-owned, typed generation adapter. Do not merge the repositories, mount NexArch's API, replace ForgeWeb's client, or start NexArch's platform alongside ForgeWeb.

NexArch contributes substantive database/API design, backend/frontend emission, security overlays, artifact-aware context, dependency analysis, and bounded repair logic. It is not a drop-in production engine: its two orchestration paths differ, several stores are process-local, its runner executes on the host, and its default generated-app authentication and database dialect conflict with ForgeWeb's declared intent.

The inspected NexArch root manifest says `UNLICENSED`, and its tree contains no LICENSE/NOTICE grant; repository access alone therefore does not establish an open-source license. For this integration, however, the original NexArch author has explicitly authorized the ForgeWeb owner to use, modify, adapt, and integrate the NexArch source. That authorization resolves the integration reuse gate while leaving license classification and any rights beyond the stated permission unasserted.

Companion documents:

- [Exact module ownership and source selection](NEXARCH_MODULE_MAPPING.md)
- [Architecture, migration, validation, and rollback plan](NEXARCH_INTEGRATION_PLAN.md)
- [Prioritized risks, acceptance gates, and blockers](NEXARCH_MIGRATION_RISKS.md)

## Scope and Evidence

| Repository | Inspected baseline | Interpretation |
|---|---|---|
| ForgeWeb, canonical | Local `main`, HEAD `b41b79d4f7b7550bc0ce2057084a5e12c25ff4aa`; remote main matched at inspection | Findings describe the current working tree, including pre-existing uncommitted server, UI, provider, test, and configuration work. They are not all claims about committed main. |
| NexArch, upstream | Main pinned at `398f4cbd9e314954eda95540411ed4d06cd50cf3` | Read remotely through GitHub; recursive tree was complete. No clone, file copy, installation, or execution. |

ForgeWeb was inspected first: manifests, entry points, API/domain/store/policy/workflow, generated templates, project workspace, provider implementations, UI/API client, tests, and architecture/ADRs. NexArch inspection followed its app wiring and the requested services, contracts, relevant implementation helpers, generators, stores, runner, repair loop, and test sources. Additional auth and builder-agent paths were examined because they affect ownership and orchestration.

This is a static code audit, not a runtime certification. No application tests, dependency installs, database commands, generated applications, previews, or sandbox exploits were executed. Manifest versions are declared ranges, not a fresh dependency-resolution or vulnerability scan. Existing application files were fingerprinted before document creation for a final non-modification check. Pre-existing changes, deleted screenshots/scripts, and untracked provider/backend/test files must remain untouched.

Evidence precedence: executable source > tests as intended behavior > README/architecture aspirations. In particular, ForgeWeb's architecture document describes Next.js/NestJS, PostgreSQL, Redis, object storage, Git workspaces, and an isolated CRG runner; those are not the current runtime implementation.

## Compatibility Status

| Category | Audit conclusion |
|---|---|
| Verified by static inspection | Both repositories target a Node/TypeScript/React generation stack; their declared React 19, Tailwind 4 and `clsx` ranges overlap. ForgeWeb already has a confirmation gate, artifact snapshots, a static preview and provider calls that an adapter can target. This verifies the existence of integration points, **not** that either engine or its emitted application runs inside the other repository. |
| Proposed integration | Map approved ForgeWeb specifications to selected NexArch planning/emission functions, return candidate artifacts, and let ForgeWeb's policy, validation and version acceptance decide publication. No cross-repository adapter was implemented or executed in this audit. |
| Unresolved compatibility | Exact transitive imports and generated dependency lock; PostgreSQL versus NexArch's MySQL emitters; auth policy; file layout and 40-file budget; artifact/status/graph identity; provider response schemas; generated build, tests and browser behavior. These need targeted implementation and executable fixtures before claiming compatibility. Source reuse for this ForgeWeb integration is authorized by explicit permission from the original NexArch author; no open-source license is inferred. |
| Deployment-time adapter requirements | A server-derived ForgeWeb principal with project/run/version authorization, durable candidate/evidence storage and operation coordination, isolated build/test/preview workers with disposable databases, a separate preview origin/session gateway, scoped provider credentials and cleanup/rollback controls. Current development implementations do not supply this hosted boundary. |

No end-to-end ForgeWeb/NexArch compatibility was verified. The audit distinguishes observed code behavior from the recommended integration design throughout the following sections.

## Current Architecture Comparison

| Concern | ForgeWeb today | NexArch today | Integration implication |
|---|---|---|---|
| Product UI | React/Vite, ForgeWeb shell, proposal/confirmation, project library, Files/Preview/Database/Versions, scoped edits and ZIP export | Separate React/Vite console with router/query/store/graph libraries | Keep ForgeWeb UI and navigation; no upstream client import. |
| Platform server | Native Node HTTP; standalone server and Vite API middleware | Express 5 modular API under `/api/v1` | Call functions behind ForgeWeb services; do not transplant Express assembly. |
| Planning | AI-assisted or deterministic specification; architecture proposal and explicit confirmation/revision | Deterministic analysis/planners plus AI planning in pipeline/agents | Enrich the proposal before confirmation. Never generate source before approved intent. |
| Coordination | One workflow/state machine; four policy roles; in-process active-build tracking | Legacy pipeline, agent DAG/executor, plus builder-agent alternative | One ForgeWeb lifecycle; selected upstream workers, not multiple competing coordinators. |
| Source generation | Template fallback or model file generation; 15 baseline artifacts in the current template | Detailed database bundle, Express/Prisma modules, React CRUD screens/forms, security files, manifests | Strongest upstream contribution, after contracts and target profile adaptation. |
| Persistence | JSON schema version 2 with full immutable version file snapshots | Optional PostgreSQL/Prisma platform records; numerous memory stores | Do not introduce upstream project/run/artifact repositories. |
| Generated database | Proposal says PostgreSQL; generated backend actually uses in-memory Maps | MySQL-oriented SQL and Prisma generation; optional local MySQL provisioning | Neither currently supplies the proposed production PostgreSQL application profile end to end. |
| Identity | No platform authenticated principal or project owner in current domain | JWT user ownership when enabled; `AUTH_DISABLED` defaults true with shared local admin | Multi-user rollout requires ForgeWeb-owned identity; do not inherit upstream bypass. |
| Provider | Native-fetch Ollama and OpenAI-compatible providers with fallback metadata | Own registry, routing, cache, retries, prompt files, costs/history | Keep ForgeWeb credentials/provider authority; adapt prompt/context policy. |
| Graph | Hand-built requirement/task/file/check snapshot; CRG target label only | Artifact-derived engineering graph plus heuristic dependency graph | Complement ForgeWeb traceability and eventual CRG; do not mislabel heuristics as CRG. |
| Validation | Structural/layout/traceability checks; generated typecheck skipped; test-file presence | Runtime/integration/test meshes and repair validation, executed through local runner | Reuse evidence concepts only with an isolated, ForgeWeb-owned execution boundary. |
| Preview | Static `frontend/preview.html`; restrictive CSP and sandboxed iframe | Host-process dev servers with logs/health/ports | Preserve static mode; add live preview later through isolated sessions and a separate origin. |

Key ForgeWeb sources: [domain](../server/domain.ts), [workflow](../server/workflow.ts), [state machine](../server/build-state.ts), [policy](../server/policy.ts), [store](../server/store.ts), [workspace](../server/project-workspace.ts), [API](../server/app.ts), [provider](../server/llm/provider.ts), [generated backend](../server/generated-backend.ts), [workspace UI](../src/components/ProjectWorkspace.tsx). These links refer to the audited working-tree files, including uncommitted additions.

Key pinned NexArch sources: [app wiring](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/app.ts), [configuration](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/shared/config/env.ts), [platform schema](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/prisma/schema.prisma), [pipeline](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/pipeline/pipeline.service.ts), [agent orchestrator](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/agent-orchestrator/agent-orchestrator.service.ts).

## Capabilities and Limits

| Requested NexArch module | What ForgeWeb already covers | Additional upstream value and limit |
|---|---|---|
| `analysis` | Prompt/specification, assumptions, roles/entities, acceptance criteria | Intent/feature extraction, completeness and clarification questions. Mostly deterministic heuristics, not unrestricted semantic understanding. |
| `architecture` | User-visible architecture and capabilities | Structured endpoints, entity fields, middleware, technology decisions and dependency plans. Default public-MVP transform can remove authentication. |
| `database-designer` | Entity list and descriptive database UI | Tables, relationships, enums, Prisma/SQL, OpenAPI, ER, validation rules, integrity checks. MySQL-specific output requires real dialect work. |
| `backend-generator` | Generic CRUD backend and contracts | Per-module controllers/services/repositories, DTO validation, app/config/tests. Some non-CRUD routes are unimplemented stubs; consult manifest. |
| `frontend-generator` | Branded template and model-generated source | API-derived forms, routes, stores, entity pages and reusable UI. Always-emitted landing/dashboard/settings and default styling must become target-profile decisions. |
| `security-engine` | Policy path controls and demonstrative generated access control | JWT/password/RBAC/sanitization/file-security overlays and reports. Report resolution flags are not proof of functioning security. |
| `dependency-graph` | File/requirement traceability and scoped editing | Import/route/entity graphs, spec diffs, impact and merge helpers. Regex analysis is incomplete; regeneration merges supplied new output, not autonomous synthesis. |
| `agent-orchestrator` | Bounded tasks, role independence, events | Registry/DAG, retries/timeouts/cancellation, artifact contracts, review/validation/repair workers. Its service/store/lifecycle cannot replace ForgeWeb's. |
| `engineering-graph` | Snapshot with requirements, tasks, files, validation | Richer feature/API/service/entity/field/component/security/finding relationships. Name-based identity, forward-reference loss and mutable latest storage need adaptation. |
| `context-engine` | Prompt context assembled locally in workflow | Artifact/graph relevance, sanitization, token budgets, compression, trace/cache. Current service resolves legacy-pipeline artifacts and can mismatch project and run. |
| `ai-orchestrator` | Ollama/OpenAI-compatible calls, availability and fallback | Prompt templates, retry/budget/model-routing policy, usage accounting. Duplicate configuration/cache/history and weaker response validation must not become a second authority. |
| `pipeline` | Approved workflow end to end | Useful stage order and explicit security overlay composition. Starts from prompt without ForgeWeb's approval; in-memory outputs; exclude service integration. |
| `runner` | Static preview; no generated-code runner | Run planning, process/port/log management, health checks. Host execution is not a multi-tenant sandbox; provisioning includes destructive Prisma commands. |
| `workspace` | Canonical projects, versions, edits, restore, export | Owner-aware CRUD and optional DB, import/demo/documentation/history. Duplicate control plane and incompatible persistence; do not import. |
| Shared contracts | Canonical domain and API wire types | Rich intermediate artifacts, agent, graph, test and repair contracts. Translate privately; never barrel-re-export over ForgeWeb types. |

## Dependency Comparison

| Area | ForgeWeb declared | NexArch declared | Decision |
|---|---|---|---|
| Runtime/tooling | Node-based native TS stripping; pnpm lock; TypeScript `^7.0.2`; Node types `24.3.0` | Node >=22, npm >=10 workspaces; TS `^5.8.0`, `tsx ^4.19.0`, Node types `^22.15.0` | Keep platform toolchain. Adapt upstream imports/types and test under ForgeWeb's actual supported Node/TS versions. No workspace/lockfile merge. |
| React | `react`/`react-dom ^19.2.8` | `^19.1.0` | Same-major overlapping ranges are not inherently a conflict; no platform downgrade or duplicate React. Generated app has its own tested dependency set. |
| Bundler | Vite `^8.2.1`, React plugin `^6.0.5` | Vite `^6.3.0`, plugin `^4.4.0` | Real major-version/tooling differences; do not transplant client/build config. |
| CSS/utilities | Tailwind/plugin `^4.3.3`, clsx `^2.1.1`, tailwind-merge `^3.6.0` | Tailwind/plugin `^4.1.5`, same clsx, tailwind-merge `^3.2.0` | Mostly overlapping ranges; leave ForgeWeb styling and resolution unchanged. |
| Icons/animation | lucide `^1.31.0`, motion `^13.1.0`, animejs `^4.5.0`, gsap `^3.15.0`, ogl, three | lucide `^0.525.0`, framer-motion `^12.9.0` | Icon API/version and animation-package differences; no upstream console components. |
| Client state/routing | Existing ForgeWeb hooks/API client | TanStack Query, Zustand, Axios, React Router, React Hook Form, XYFlow, dagre | Not needed for server engine integration. Do not add to platform. |
| HTTP platform | Node HTTP/native fetch | Express `^5.1.0`, helmet, cors, rate limiting, cookie-parser, compression, express-validator | Exclude upstream platform server. Express may be a generated-app dependency, not a ForgeWeb dependency. |
| ORM/auth | JSON store; no platform Prisma/auth stack | Prisma/client `^6.8.0`, bcrypt `^6.0.0`, jsonwebtoken `^9.0.2` | Exclude platform schema/auth. Generated packages are separate; generated templates may use bcryptjs rather than platform native bcrypt. |
| Engine helpers | Node APIs/current providers | `gpt-tokenizer ^4.0.0`, `zod ^3.25.0`, winston/dotenv | Assess tokenizer/schema dependency only after extraction closure. Inject logging/config; do not add winston/dotenv just for copied imports. |

Sources: [ForgeWeb manifest](../package.json), pinned [server manifest](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/package.json), [client manifest](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/client/package.json), [root manifest/license declaration](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/package.json).

The platform's `package.json` is not the generated application's `package.json`. Engine imports, emitted dependency strings, preview-image dependencies, and export dependencies require separate allowlists and lockfiles. Do not install NexArch's root/server packages to obtain a few pure functions; its server has a Prisma-generating postinstall. Its shell-style `NODE_ENV=test` test command is also not directly portable to this PowerShell workspace.

## API Comparison

No literal collision exists between the default `/api` and `/api/v1` namespaces. The collision is domain ownership and incompatible payloads; removing a prefix would introduce route ambiguity. NexArch routes below are relative to `/api/v1` and reflect router code, not just README descriptions.

| ForgeWeb current API | NexArch counterpart | Required treatment |
|---|---|---|
| `POST /api/builds`; `GET /api/builds/:buildId` | `/pipeline/runs` POST/GET; `/projects/:projectId/agent-runs` POST/GET and run detail | Keep ForgeWeb build IDs, response shapes, status polling and error semantics. Engine runs remain internal. |
| `POST /api/builds/:buildId/confirm`, `/revise` | No equivalent approval gate on pipeline start | Mandatory ForgeWeb gate; upstream start is not exposed. |
| `GET /api/builds/:buildId/events` (SSE) | Agent-run events and pipeline stage polling | Translate worker progress into existing ForgeWeb events; client currently polls builds. |
| `GET /api/projects`, `/api/projects/:projectId`, `/workspace` | `/projects` POST/GET; `/project/:id` GET/PATCH/DELETE; duplicate/import/demo/history/statistics | Preserve canonical project/workspace API; upstream singular `/project` and envelopes are incompatible. |
| `POST /api/projects/:projectId/edits` | `/dependency/regenerate`; agent runs/repairs | Route edits through approved impact plan and candidate/version acceptance, not upstream mutation APIs. |
| `POST /api/projects/:projectId/versions/:versionId/restore` | No equivalent immutable ForgeWeb version restore contract | Keep ForgeWeb ownership and restore behavior; make derived graph/preview version-bound. |
| `GET /api/projects/:projectId/preview` | `/runner/plan`, `/runner/sessions`, session/logs/stop/restart | Keep static route; live execution needs an isolated gateway and new internal session contract. |
| `POST /api/projects/:projectId/export/validate`, `/export` | `/project/:id/export`, `/export`, `/documentation`; agent validation views | ForgeWeb validates and exports the same pinned version. No parallel packaging authority. |
| `GET /api/health`, `/api/llm/status` | `/health`, `/health/live`, `/health/ready`, `/health/security`; `/ai/*` | Preserve ForgeWeb availability/fallback contract; no credential/provider admin API transplant. |
| No direct generation-module API | `POST /analyze`, `/architecture`, `/database/design`, `/openapi/generate`, `/backend/generate`, `/frontend/generate` | Internal functions only. Actual analysis mount is `/analyze`. |
| No public security/dependency/graph/context API | `/security/{analyze,apply,report}`, `/dependency/{build,analyze,diff,regenerate,graph,statistics}`, project graph/context subroutes | Keep internal initially; any later routes require ForgeWeb authorization and version selection. |
| No platform auth API today | `/auth/{register,login,refresh,logout,me,onboarding/complete}` | Separate future ForgeWeb identity design; never silently mount upstream local-user behavior. |

Other upstream API families include builder, deployment, quality, insights, review, AI history/statistics/workflow/retry, agent findings/intelligence/repairs, graph impact/query and context benchmark/trace. They are not part of the proposed public API.

ForgeWeb errors are `{ error: { code, message } }`; NexArch uses success/data/message/meta and its own error envelope. ForgeWeb build submission/confirmation/revision return 202, edit returns 201, and export validation returns 200 or 422. Preserve these contracts and the current 64-KiB request limit unless separately approved. Generated-app `/api/v1/...` routes belong to a different application/origin, not the ForgeWeb control API.

## Types and Persistence Comparison

| Contract | Collision | Mapping rule |
|---|---|---|
| `Project` | ForgeWeb `project_*`, workflow status/current pointers; NexArch owner, UUID/cuid identities and DRAFT/ACTIVE/ARCHIVED | Keep the opaque ForgeWeb ID unchanged. Engine receives it, never creates a second platform project. |
| `MasterSpecification` vs `RequirementSpec` | ForgeWeb approval/spec version and requirement IDs; NexArch string lists/modules/fields without equivalent approval identity | Preserve original spec and an explicit requirement-to-engine-feature map, keyed by project/spec ID. Never map by array position alone. |
| `ArchitecturePlan` | ForgeWeb display-oriented frontend/backend/data/security; NexArch structured decisions/endpoints/entities/middleware | Private `NexArchitecturePlan` alias plus approved engine-plan artifact. Keep current UI projection; no blind structural cast. |
| `GeneratedFile` | ForgeWeb path/content/requirementIds/digest; NexArch path/content/language, often area-relative | Normalize area prefix once, validate paths, derive traceability, calculate digest after all overlays. Preserve language in optional internal metadata. |
| `AgentTask` and run statuses | Different role names, fields, readiness and lifecycle; upstream task completion is not validation success | ForgeWeb owns policy, scope, change budget and state transition. Engine task/attempt IDs are child records only. |
| `GraphNode`, `GraphEdge`, `DependencyGraph` | Several upstream definitions; richer uppercase types and edge directions vs ForgeWeb snapshot types | Explicit typed projection. `FEATURE -> IMPLEMENTS -> REQUIREMENT` is not a direct replacement for ForgeWeb `REQUIREMENT -> SATISFIED_BY -> FILE`. |
| Validation | Upstream PASS/FAIL/SKIPPED/BLOCKED, test statuses, summary gates vs ForgeWeb passed/failed/skipped | Preserve detailed reason internally. A required blocked/skipped check prevents acceptance; absence of failure is not a pass. |
| Artifact/run/version | Upstream mutable/latest typed artifacts and separate generation history vs ForgeWeb full version snapshots | Immutable artifact manifest indexed by project/build/attempt/base version/content digest. Never resolve acceptance inputs with `latest(project, type)`. |

ForgeWeb's JSON store clones reads and serializes writes in one process using a temporary file and rename. It is not a durable queue or a multi-process transaction system. Existing `versionFiles` are valuable and should not be migrated into NexArch's platform schema. NexArch's Prisma models (`User`, `Project`, `Generation`, `GraphNode`, `GraphEdge`, with role enum) are not a substitute for ForgeWeb approval/task/event/version history. Its project persistence is optional; pipeline outputs, agent artifacts/findings/repair state and caches are still process-local. Pipeline durable history does not make its full outputs recoverable after restart.

Keep three distinct data domains: ForgeWeb control records; immutable generated source/evidence; generated application's own runtime database. No table, credentials, migration lifecycle or user IDs should be implicitly shared among them.

## Provider and Pipeline Comparison

ForgeWeb's `server/llm` uses native fetch, `FORGEWEB_LLM_*` configuration (plus legacy aliases), Ollama or an OpenAI-compatible endpoint, availability checks, and recorded fallback. NexArch configures its own provider/model hierarchy, HTTP adapters for several services, a mock provider in tests, retry/cache/history/cost logic, and prompt templates. Adopting both would produce contradictory availability, credentials, fallback and accounting.

Bridge selected prompts/context/schema validation to ForgeWeb's provider interface. Preserve model/provider identity and total usage across calls. Never pass platform API keys into emitted files or runner environments. Cache keys need tenant, model/provider, prompt/schema versions and input artifact digests. Upstream cache identity omits important dimensions; a cached response can be returned with failed validation, so enforce runtime schemas independently at the boundary.

| Path | Actual sequence | Overlap and difference |
|---|---|---|
| ForgeWeb | Specify -> plan -> await confirmation -> generate -> independent review -> structural validation -> graph/version -> ready | Canonical approval and state machine. Model review is advisory and errors are downgraded; current checks do not certify runnable applications. |
| NexArch legacy pipeline | AI analysis -> deterministic architecture plus AI field design -> database -> backend -> frontend plus site copy -> security overlays -> dependency graph -> engineering graph | Good generation dataflow; no ForgeWeb confirmation. Source overlay makes hardened files replace base files intentionally. |
| NexArch agent mesh | Planned artifact-dependent tasks -> generation -> read-only reviews -> runtime/integration/test validation; repair invoked separately | Different artifact storage/context plumbing. Security reviewer analyzes rather than applying legacy security overlays. COMPLETED run/task is not identical to a passed validation gate. |
| NexArch builder-agent | Additional tool-driven iterative build session | Third competing orchestration path, not required for this integration. Exclude. |

## High-Impact Implementation Observations

1. **Foreign-layout overwrite risk:** `getReady` in ForgeWeb's workspace can automatically upgrade a project to the professional template on a read. `hasProfessionalFrontend` and stored validation expect ForgeWeb paths/markers. NexArch's `src/app/router.tsx` and `src/shared/styles/globals.css` can trigger overwrites or fail checks. Add versioned target-profile compatibility before accepting any new-layout version.
2. **Approval/security mismatch:** NexArch `architecture.service.ts` calls `withoutAuthentication` unless generated-app auth is enabled; this strips protected architecture even if ForgeWeb requirements call for it. ForgeWeb's own generated session/role headers are demonstrative, not real authentication. Neither shortcut is acceptable production auth.
3. **Unsafe execution boundary:** upstream runner and repair validator run npm/generated commands on the host. Child env filtering, shell=false, path checks and process limits help but do not isolate filesystem, network, CPU or credentials available through the host account.
4. **Database destructive operations:** runner provisioning includes `prisma db push --accept-data-loss` and a force-reset fallback. Database naming derives from a project slug, not owner/project/session identity. Never reuse this provisioning for tenant/customer databases.
5. **Graph incompleteness:** upstream graph builder links entities/features while creating them and silently ignores unavailable endpoints; forward references can disappear. Canonical names also replace explicit product IDs. ForgeWeb only builds a graph on initial generation; edits/restores can leave it stale.
6. **Repair acceptance defects to address:** upstream applies patches to latest artifacts before validation; a thrown validator exception bypasses the normal rollback path. Baseline regression checks skip a check kind already used in targeted validation, potentially missing failures outside the targeted files. Use isolated candidates and full acceptance validation.
7. **Context consistency/ownership:** context service checks project ownership but resolves legacy pipeline artifacts by run ID without proving that run belongs to that project. Agent artifacts are a separate store. Replace with a project/run/version-checked resolver; do not expose this service unchanged.
8. **Weak merge semantics:** dependency regeneration accepts already-generated new content; its merge retains old-only files and accepts some new files outside the affected set. It does not implement safe three-way conflict resolution, deletions or user-edit preservation by itself.
9. **Path/budget conflict:** ForgeWeb forbids `.env` and `.env.*`, including `.env.example`, and defaults to 40 implementation files. NexArch emits configuration samples and many files. Do not relax policy globally or silently truncate artifacts; use an approved target-specific budget and safe configuration metadata/documentation.
10. **Version consistency gaps:** scoped edits have no cross-operation compare-and-swap lease; export validates and later reads current content; preview URL version query is cache busting rather than immutable selection. Pin a version for generation, graph, validation, preview and export before adding more asynchronous work.

Pinned evidence: [public-MVP transform](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/architecture/lib/public-mvp.ts), [MySQL Prisma emitter](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/database-designer/lib/prisma-generator.ts), [runner service](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/runner/runner.service.ts), [database naming](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/runner/lib/database-provisioner.ts), [graph builder](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/engineering-graph/lib/graph-builder.ts), [repair loop](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/agent-orchestrator/lib/repair-engine.ts), [context service](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/context-engine/context-engine.service.ts), [merge helper](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/dependency-graph/lib/merge-engine.ts).

## Answers to the Requested Integration Questions

| # | Question | Decision |
|---|---|---|
| 1 | Existing ForgeWeb implementation | Product UI, specification approval, policy tasks, templates/AI generation, JSON versions, scoped edits, restore, static preview, structural checks, ZIP export and provider adapters. |
| 2 | NexArch-only capabilities | Rich database/OpenAPI design, module/page emitters, security overlays, dependency/engineering graphs, artifact context, task mesh, runtime evidence and bounded repair machinery. |
| 3 | Components to preserve | ForgeWeb UI/UX, API wire contracts, project/spec/version identity, approval authority, policy ownership, provider settings and existing snapshots. Bounded future server hooks are listed separately. |
| 4 | Modules to integrate | Adapt core analysis/design/generation/security functions first; graph/context/review helpers next; dependency-guided edits and repair last. |
| 5 | Modules not to integrate | NexArch client, platform workspace/auth/Prisma schema, routers/controllers/app, legacy pipeline service/stores, provider registry, host runner, builder/deployment/insights console features. |
| 6 | Type conflicts | ArchitecturePlan, GeneratedFile, Project, task/run/status types, multiple graph types, validation and artifact/version semantics; use explicit adapters. |
| 7 | Route conflicts | Mostly semantic overlap across different prefixes; do not mount a second control API. |
| 8 | Dependency conflicts | TS/Vite/plugin/icon versions and package-manager layouts; no wholesale manifests. Keep generated-app dependencies isolated. |
| 9 | Persistence conflicts | JSON versions vs optional platform PostgreSQL plus volatile stores; no dual writers. Generated MySQL is a separate concern. |
| 10 | AI/provider conflicts | Two registries/config/fallback/cache systems; ForgeWeb provider facade wins. |
| 11 | Pipeline overlap | ForgeWeb approved workflow, NexArch legacy pipeline and agent mesh all coordinate generation; retain one ForgeWeb state machine. |
| 12 | Clean boundary | Approved structured input + immutable base snapshot in; typed candidate artifacts, findings, usage and evidence out; no engine-side canonical mutation. |
| 13 | Artifact flow | Candidate staging -> overlays -> policy/schema/security/runtime checks -> graph -> atomic version acceptance -> existing workspace/preview/export projections. |
| 14 | Project IDs | Use the same ForgeWeb project ID everywhere; separate internal run/attempt IDs and derive storage/session keys from opaque IDs, never names. |
| 15 | Ownership/security | Server-derived ForgeWeb principal and project membership on every resource; distinct generated-app users; local prototype identity is not production tenancy. |
| 16 | Preview | Keep static sandboxed previews; later run pinned snapshots in disposable isolated environments with separate-origin signed access. |
| 17 | Validation | Runtime schemas, traceability, policy, real compile/build/test, API/auth/DB/browser checks; required blocked/skipped checks prevent acceptance. |
| 18 | Incremental regeneration | Version-pinned graph impact + task scopes + three-way merge + explicit deletion/conflict review + full acceptance gates; preserve manual edits. |
| 19 | Engineering graph | Snapshot-scoped semantic overlay with ForgeWeb IDs and provenance; explicit projection and eventual CRG structural adapter, never upstream mutable repository. |
| 20 | Self-repair | Isolated bounded patch proposals under ForgeWeb task policy; independent rerun of required checks; rollback on any failure/throw/cancel; sensitive changes require review. |
| 21 | Preserve UI/UX | Leave current components/styles/navigation intact; adapt server results to existing proposal/workspace/build interfaces. Any live-preview hook is a later small, reviewed change. |

## Recommendation

The source-reuse prerequisite for this ForgeWeb integration is satisfied by explicit permission from the original NexArch author. Any next phase still requires separate approval and must preserve the integration boundary rather than treating NexArch as a wholesale repository merge. Production rollout remains blocked on real ownership, isolated execution, target-dialect validation and atomic version/evidence handling.
