# NexArch Migration Risks

Phase 3.6 update: [implemented safeguards and remaining blockers](NEXARCH_PHASE3_6_SAFETY_GATES.md). R02 now has durable plan/digest/base binding; R07 has a layout guard; candidate and isolated-validation contracts are explicit. R01 is resolved for use, modification, adaptation, and integration into ForgeWeb through explicit permission from the original NexArch author. That permission does not establish an open-source license or broader unstated rights. R04 actual owner authentication, R08 PostgreSQL engine capability, and R09/R10/R11 execution and durable acceptance remain unresolved.

## Phase 3.5 gate status (2026-10-05)

Phase 3 planning remains preserved and server-callable only. The following gates are **open**, not waived by passing planning tests: production approval-to-plan dispatch, ForgeWeb owner authentication/authorization, PostgreSQL generation capability, isolated generated-code validation, and durable candidate/CAS handling. Layout auto-upgrade protection and durable plan/digest/base binding were added in Phase 3.6, but still require their production integration paths to be exercised. These remaining gates prevent Phase 4 generator rollout. No accepted version is changed by the isolated planner, and no database is provisioned. The explicit planning dialect/profile rejects PostgreSQL instead of converting it. Reassess each technical gate with executable evidence before enabling new generation.

Date: 2026-10-05. Static inspection findings and proposed release gates. No application code, dependency or schema changes were made for this audit.

References: [audit and source evidence](NEXARCH_INTEGRATION_AUDIT.md), [module mapping](NEXARCH_MODULE_MAPPING.md), [phased plan and rollback](NEXARCH_INTEGRATION_PLAN.md). Upstream paths refer to NexArch revision `398f4cbd9e314954eda95540411ed4d06cd50cf3`; ForgeWeb paths refer to its inspected working tree, not only committed main.

## Severity and Release Policy

- **Critical:** blocks source reuse or any relevant hosted/executing release; risk of unauthorized access, host compromise, data loss or invalid approval.
- **High:** blocks new-profile acceptance or the specific feature until fixed and tested.
- **Medium:** must have an explicit mitigation/accepted limitation before cohort expansion.
- Findings are code-derived hazards, not claims that an exploit was reproduced or that every generated application fails.

Pure, local shadow planning can proceed after authorization/permission without enabling host execution or mutating existing projects. It does not waive production gates.

## Risk Register

| ID | Severity / affected phase | Evidence and impact | Required mitigation / acceptance proof | Proposed owner |
|---|---|---|---|---|
| R01 | Resolved for this integration / scope-limited | NexArch root `package.json` declares `UNLICENSED`; no LICENSE/NOTICE grant exists in the inspected tree, so repository metadata does not establish an open-source license. The original NexArch author explicitly authorized the ForgeWeb owner to use, modify, adapt, and integrate the NexArch source into ForgeWeb. | Preserve original-project/author attribution and pinned-revision provenance. Do not infer rights beyond the stated permission; separately confirm any future use outside this ForgeWeb integration. | Product/repository owners |
| R02 | Critical / all new generation | ForgeWeb confirmation gate versus NexArch pipeline/agent start from prompt; separate status machines. Importing services can generate before approval or accept drifted design. | Exact approved spec/engine-plan digest required at adapter; negative tests for unconfirmed/revised/stale specs; one ForgeWeb status authority. | Workflow architect |
| R03 | Critical / authenticated targets | NexArch `architecture.service.ts` calls `withoutAuthentication` by default; `GENERATED_APP_AUTH` false removes auth. ForgeWeb generated session accepts client roles and uses role/user headers, not real credentials. | Explicit approved public/authenticated target; real identity/session/authorization checks. Never accept auth stripping or illustrative headers as secure auth. | Security + generation |
| R04 | Critical / hosted use | ForgeWeb `Project` has no owner and API has no authenticated principal. NexArch defaults to shared local ADMIN when AUTH_DISABLED is true. | ForgeWeb-owned identity/membership; safe legacy ownership assignment; per-resource authorization/association tests. Never mount upstream bypass. | Platform security |
| R05 | Critical / runtime and repair | NexArch runner and `repair-validator.ts` spawn npm/generated processes on host. shell=false/env allowlist do not prevent malicious JS reading host/network or exhausting resources. | Disposable nonprivileged sandbox, network/filesystem/resource controls, hard kill/cleanup and security review; hostile package/code tests. Exclude host runner. | Runtime/security |
| R06 | Critical / database execution | `runner.service.ts` uses db push accept-data-loss and force-reset fallback; `database-provisioner.ts` names DB by project slug. Same-named projects can target same DB. | No destructive automatic migration; unique project/owner/session isolation and least-privilege DB credentials; disposable DB fixtures; explicit production migration review. | Runtime/data |
| R07 | High / first new-profile write | ForgeWeb `getReady`/professional-frontend checks can overwrite foreign layouts on a workspace read; stored validation assumes ForgeWeb App/CSS/preview paths. | Profile/version-aware compatibility guard before rollout; unknown profiles read-only; test repeated GET leaves every digest unchanged. | Workspace |
| R08 | High / target design | ForgeWeb proposal says PostgreSQL but template stores Maps. NexArch SQL/Prisma/inference are MySQL-oriented. A URL-only change produces invalid or misleading output. | Agree target profile; true dialect adaptation with enums/native types/relations/default tests on real disposable PostgreSQL, or explicitly approved MySQL profile. | Data/generation |
| R09 | High / acceptance | ForgeWeb structural validation skips generated typecheck and largely checks markers/test-file existence. Upstream task COMPLETED and report resolved flags are not executed evidence. | Required real compile/build/API/auth/DB/browser gates; immutable evidence. BLOCKED/SKIPPED required checks cannot accept. | Validation |
| R10 | High / persistence | NexArch pipeline outputs, agent artifacts/findings/repair/cache are process-local even with platform DB; artifact store is bounded/latest-oriented. Restart or eviction loses operation inputs. | ForgeWeb-owned immutable manifests/checkpoints and explicit interrupted state; no independent upstream stores; recovery and replay tests. | Persistence |
| R11 | High / concurrent operations | ForgeWeb edits lack cross-operation CAS/lease; export re-reads current after validation; preview query does not pin historical content. More async workers increase stale writes/mismatched output. | Per-project writer lease and expected-version CAS; pin preview/export/graph/evidence to version; interleaved edit/restore/export tests. | Workspace/workflow |
| R12 | High / graphs | Upstream graph links during node creation and silently drops missing endpoints; name-based identity can collapse meanings. ForgeWeb graph is stale after some edits/restores. | Two-pass construction, qualified IDs, explicit requirement map, unresolved-link errors and per-version snapshots; forward-reference/collision/restore tests. | Graph |
| R13 | High / context | Context service verifies project but gets pipeline artifacts by run ID without proving run-project match; agent artifacts use another store. Cache/graph versions can mismatch content. | Inject authorized immutable resolver; validate project/run/version association before cache; cache by tenant/model/schema/source digests; negative cross-run/project tests. | Context/security |
| R14 | High / repair | Upstream patch applies to latest artifacts before checks; thrown validator errors bypass normal rollback. Outer catch marks failure without restoring files. | Candidate-only patching and exception/cancel-safe discard; inject failure after apply and prove accepted digests unchanged. | Repair/workflow |
| R15 | High / repair | Regression guard skips full check kinds already in targeted checks. A scoped pass can hide a regression elsewhere; budgets checked between findings do not hard-stop inner calls. | Full required/baseline regression checks on final candidate; hard per-call/session deadlines, cancellation and token caps; non-target regression tests. | Repair/validation |
| R16 | High / regeneration | Dependency merge retains old-only files, accepts additions and uses supplied regenerated content; no real three-way merge/conflict/deletion protocol. Regex impact misses dynamic dependencies. | Base/current/candidate merge, explicit deletion/rename conflicts, strict task scope and conservative impact widening; manual-edit survival tests. | Generation/graph |
| R17 | High / policy/artifacts | NexArch emits .env.example and more files than ForgeWeb's default 40-file budget. Current safePath normalizes some absolute forms rather than robust materialization validation. | Preserve secret-path ban; config metadata/docs; approved bounded profile budget; reject Windows drives/UNC/case/reserved names and traversal before writing; physical containment/symlink/size checks in sandbox. | Policy/runtime |
| R18 | High / generated features | Backend emitter marks custom routes unimplemented; frontend uses manifests/placeholders. Security agent reviews, whereas legacy pipeline applies overlays. Combining paths naively omits hardening or claims stub functionality. | One explicit backend -> frontend -> approved security overlay composition; assert implemented acceptance routes and run auth/contract tests on final bytes. | Generation/security |
| R19 | High / dependencies | Vite/TS/plugin/icon versions and npm/pnpm layouts differ; platform Prisma postinstall and generated package scripts are executable. Template imports can be mistaken for platform imports. | No manifest/lockfile merge. Separate engine/runtime/generated dependency sets, pinned profile locks and isolated installs; closure/license/supply-chain review. | Build/security |
| R20 | High / AI and cache | Two provider configs/fallback policies; upstream prompt/model cache misses tenant/provider/schema dimensions and may return cached data with invalid schema. | ForgeWeb provider authority; strict validation on every response/cache hit, scoped key and usage; malformed/cross-tenant/cache tests. | Provider |
| R21 | High / previews | Static preview is not real app execution and can drift after AI edits. Enabling scripts on same-origin preview or exposing runner localhost URLs is unsafe/nonfunctional for hosted users. | Version-bound static projection; later separate-origin authenticated session gateway, limited iframe permissions and disposable DB; cross-origin/session expiry tests. | Preview/security |
| R22 | High / migration rollback | New metadata/profile outputs cannot safely be read by original assumptions. Disabling engine alone could send NexArch versions through legacy auto-upgrade. | Compatibility bridge release, read-only/export mode for disabled new profiles, tested schema backup/reader compatibility; no old-binary blind downgrade. | Release/persistence |
| R23 | Medium / baseline | Canonical working tree already contains substantial modifications/deletions/untracked files; committed GitHub main is incomplete relative to inspected state. | Record agreed baseline with owners; preserve all pre-existing work; characterize current behavior before refactor. Do not reset/stash/commit unrelated work. | Repository maintainer |
| R24 | Medium / UX and architecture | Upstream client/style/forced landing routes and response envelopes conflict with ForgeWeb product. Design docs overstate runtime infrastructure in both repos. | Server projections preserve current UI/API; target-specific generated UX; use executable evidence, not aspirational docs, in release claims. | Product/frontend |
| R25 | Medium / operations | Current JSON queue is single-process; provider histories/artifacts/logs can grow or leak prompts/secrets; fallback may hide degraded generation quality. | Serial local scope initially; quotas/retention/redaction/usage visibility, truthful fallback, then separately approved durable coordinated storage/workers. | Platform operations |

## Focused Evidence

These source locations support the highest-risk decisions:

- ForgeWeb [workspace compatibility, validation, edit, restore and export](../server/project-workspace.ts), [workflow and structural graph](../server/workflow.ts), [policy](../server/policy.ts), [path helper](../server/lib.ts), [domain/ownership shape](../server/domain.ts), [generated backend](../server/generated-backend.ts).
- NexArch [auth defaults](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/shared/config/env.ts), [auth removal](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/architecture/lib/public-mvp.ts), [runner service](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/runner/runner.service.ts), [repair host validation](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/agent-orchestrator/lib/repair-validator.ts).
- NexArch [repair acceptance/rollback](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/agent-orchestrator/lib/repair-engine.ts), [graph builder](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/engineering-graph/lib/graph-builder.ts), [context lookup](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/context-engine/context-engine.service.ts), [artifact store](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/agent-orchestrator/lib/artifact-store.ts).
- NexArch [AI service/cache result handling](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/ai-orchestrator/ai-orchestrator.service.ts), [agent security reviewer](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/agent-orchestrator/agents/security-engineer.ts), [merge semantics](https://github.com/ashutoshsharma1309/nexarch/blob/398f4cbd9e314954eda95540411ed4d06cd50cf3/server/src/modules/dependency-graph/lib/merge-engine.ts).

The runner does have environment filtering, path checks, process/session limits and cleanup logic; those controls are useful references. The risk is their insufficiency as a hostile-code isolation boundary, not a claim that no safeguards exist. Similarly, repair tests exercise ordinary rollback, but do not establish exception-safe canonical-state protection.

## Blockers Versus Decisions

### Source integration authorization

The original NexArch author has explicitly authorized the ForgeWeb owner to use, modify, adapt, and integrate NexArch into ForgeWeb. The root manifest remains `UNLICENSED`, so this records project-specific authorization rather than an open-source license or a general grant of unstated rights. Preserve attribution and provenance.

The current checkpoint scope is **ForgeWeb integration baseline containing pre-existing ForgeWeb generation/product foundation work plus NexArch Phases 1–3.6 integration and safety-gate work.** Phase 4 remains separately gated and is not authorized by this documentation correction.

GitHub repository access was available for both repositories and did not block this audit.

### Blocks production acceptance or specific features

- Real ForgeWeb ownership and authenticated resource access before remote multi-user exposure.
- Profile-aware workspace compatibility and atomic source/version/evidence handling before any new-layout version is accepted.
- True target-dialect implementation and runnable validation before generated applications are described as functional.
- Isolated execution and non-destructive database provisioning before runtime validation, live preview or repair execution.
- Version-correct graph/context and candidate-only exception-safe repair before those features are enabled.

These are engineering prerequisites discovered by static review, not missing repository access. A bounded shadow/contract spike can validate design without pretending these are solved.

### Not established by this audit

- Production safety, dependency vulnerability status, load capacity, generated-app compile success or browser correctness.
- An open-source license or rights beyond the original author's stated ForgeWeb integration permission.
- A passing test suite, usable PostgreSQL target, CRG runtime or isolated runner.
- Whether upstream custom/non-CRUD endpoint behavior meets every product requirement.

Do not convert these unknowns into assumed passes.

## Rollout and Rollback Controls

Keep generation, graph/context, live preview and repair independently gated. Freeze engine/profile selection per operation/version, keep legacy projects on legacy behavior, and enable new profiles only for explicit cohorts. Release acceptance requires all applicable Critical/High entries to have verified evidence, not merely a ticket or mitigation proposal.

Rollback must preserve accepted source/history: cancel future work, quarantine candidates, stop sessions, retain diagnostic evidence, and keep new-profile projects readable/exportable using the bridge. It must not invoke legacy regeneration on new output, drop graph/version history or force-reset app databases. Restore selects a known passing same-project snapshot and its matching graph/evidence. Any future schema rollback needs a tested backup/compatibility procedure.

Operational stop signals: unapproved spec drift, cross-project artifact access, host/network sandbox breach, workspace GET changing a new-profile file, source/evidence digest mismatch, generated auth bypass, failed required checks marked successful, repair changing accepted files before acceptance, or rollback damaging a legacy project. Any one stops the affected capability immediately.

## Verification Before Expansion

| Proof | Minimum expectation |
|---|---|
| Legacy preservation | Existing API/UI tests and repeated workspace reads preserve source digests; versions/restore/export still work. |
| Authorized generation | No source before confirmation; changed spec/profile rejected; real feature/auth criteria tested. |
| Artifact isolation | Different owners/projects/runs with identical names cannot share files, DBs, caches, graph or contexts. |
| Atomicity | Fault injection after each stage leaves either old accepted version or complete new version, never mixed pointers/artifacts. |
| Repair safety | Validator throw/cancel/timeouts and non-target regressions discard candidates; no policy/test weakening. |
| Runtime safety | Hostile package/code and resource-exhaustion fixtures confined to disposable environments; cleanup proven. |
| Recovery | Restart/retry and rollback rehearsed on mixed profiles with backups; unknown profiles fail read-only. |
| Honest UI | Degraded generation, blocked validation, static versus live preview and database configuration versus provisioning are not misrepresented. |

This task's verification is limited to document completeness, source/path consistency, and preservation of pre-existing files. Application/runtime acceptance remains work for a later authorized phase.
