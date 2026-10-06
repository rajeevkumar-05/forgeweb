# Phase 3.6 safety gates

Date: 2026-10-05. Branch: `codex/nexarch-integration-boundary`. Phase 4 has not started.

Checkpoint scope: **ForgeWeb integration baseline containing pre-existing ForgeWeb generation/product foundation work plus NexArch Phases 1–3.6 integration and safety-gate work.** It is not a claim that the entire working tree was created solely by the NexArch phases.

## Application target

PostgreSQL is the canonical generated-application target, preserving ForgeWeb's existing architecture direction. `generation/targets.ts` declares the `forgeweb-postgresql-v1` target; its name is an approval policy, not a claim that a working PostgreSQL generator exists. Missing or mismatched dialects fail before approval and before preparation of a future generation request. NexArch still supports only MySQL 8 experimental planning and reports `unsupported_capability` for PostgreSQL. Its real task scenario remains useful as a planning fixture, but cannot receive a canonical application approval. No conversion, provisioning, or generated schema execution is implemented.

## Durable approval

`PlanningApprovalService` is a ForgeWeb-owned service over the existing JsonStore. An additive optional `planningRecords` map preserves existing schema-version-2 records; initialization defaults absent maps to empty. Build records gain an optional current planning-record ID. Saving a complete canonical proposal creates a new immutable-by-identity plan revision and a proposed MasterSpecification. The stored digest covers identity, revision, project/build/operation/actor context, proposal/database dialect, base version/manifest, proposed specification digest, engine revision, profile/options and creation time.

Approval names the exact plan ID and digest. It verifies the trusted owner, current build/specification, current base, and stored bytes before recording the approval and approved specification digest. A new plan revision supersedes the old approval. The future request constructor rechecks these values after restart and returns a frozen structural request. Plan, specification, database, owner, project, profile or base drift cannot reuse the approval. Checks execute in JsonStore's serialized mutation queue. This is single-process coordination; a future dispatch/acceptance implementation still needs compare-and-swap at the time it writes a candidate or version.

Approval does not start generation. The existing legacy `BuildWorkflow.confirm()` rejects builds with a planning record, including a second check inside the transaction and a guard in execution. Revising the existing proposal clears the current planning-record reference. No new HTTP route or UI action is exposed for the service. A future authenticated controller must present and confirm the exact digest and call this service; the current UI/legacy workflow remains intact.

## Owner authority

ForgeWeb currently has no authenticated project-owner model. This phase does not invent one. `OwnerVerifier` is an injected trusted ForgeWeb authorization function, not engine logic or an HTTP-body field. The default verifier denies every approval operation, and local actors cannot authorize generation. Tests supply an explicit fixture verifier only. Deploying this service requires a real server-derived principal and project ownership check. `prepareGenerationRequest` performs structural checks; it is not proof of authentication and must follow the durable approval service.

## Workspace protection

`generation/layout.ts` recognizes the current managed layout and the exact legacy migration footprint. Unknown layouts return `LAYOUT_UNSUPPORTED` before automatic upgrade, edit, preview or export. Generated layout metadata must reference a matching durable approval; such versions are readable without automatic upgrade, while legacy edit/preview/export operations remain unavailable. Unknown restore targets are rejected. Upgrade writes additionally compare the original version and file snapshot inside the transaction. There is no automatic migration of unfamiliar source and no generated-layout acceptance writer in this phase.

## Candidate and validation boundaries

Candidates now require owner context, approved plan ID and binding digest, base reference, engine revision, timestamp, files/artifacts, and manifest digest. Their initial states are always `pending` validation and `unaccepted`; engine-provided passed/accepted states are rejected. No candidate persistence or acceptance writer is implemented.

`IsolatedValidator` requires separate evidence bound to the candidate ID and manifest, with isolated session/image identity and typecheck, build, tests, dependencies, security and startup/health checks. Failed, skipped, blocked, missing, duplicate or stale required evidence cannot establish readiness. Separate review evidence is also required. The readiness predicate has no store access and never accepts a version. Trusted validator/reviewer provenance must be supplied by ForgeWeb; these fields alone are not cryptographic proof. `UnavailableValidator` explicitly returns `unsupported_capability`; no host process or npm command executes generated source.

## Source and dependency review

REUSE AUTHORIZATION: CONFIRMED FOR FORGEWEB INTEGRATION

The pinned NexArch root package at `398f4cbd9e314954eda95540411ed4d06cd50cf3` was rechecked and still declares `UNLICENSED`; repository evidence alone does not establish an open-source license. Separately, the original NexArch author explicitly authorized the ForgeWeb owner to use, modify, adapt, and integrate the NexArch source into ForgeWeb. Preserve attribution to the original project/author and the pinned revision. Do not infer a particular license or rights beyond the stated permission. The replaceable `PlanningEngine` interface remains the boundary.

All 30 copied planning/shared files plus the local `upstream/planning.ts` are reachable through static relative imports. No new upstream files, package dependencies, generated artifacts, providers, auth, client, persistence, runner or generators were added. No files were removed. Existing unrelated dirty-worktree edits remain present.

## Verification and remaining work

Validation completed: TypeScript application/server checks passed; full server suite 43/43 passed; Vite client build passed; server TypeScript build passed. `git diff --check` found no whitespace errors. Build output remains ignored and untracked. No generated application code was executed.

Six new focused tests cover dialect rejection, restart-persistent exact approval, default-denied ownership, plan/specification/base/revision invalidation, unfamiliar-layout preservation, read-only generated layouts, candidate state rejection and unavailable/failed validation. Existing legacy layout and HTTP/workflow tests remain regression coverage. PostgreSQL approval fixtures are hand-authored contract fixtures, not claimed NexArch output. No generated application is executed by these tests.

Phase 4 remains blocked on a genuinely compatible PostgreSQL planning/generation profile, real ForgeWeb owner verification and authenticated approval wiring. Isolated execution and durable candidate acceptance remain implementation requirements before any generated output may become an accepted application. After those prerequisites are explicitly authorized, scope Phase 4 to backend/frontend candidate generation behind exact approved plans; runner, live preview, repair and engineering graph remain separately gated.
