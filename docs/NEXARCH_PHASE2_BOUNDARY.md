# Phase 2 Generation Boundary

Status: contract spike only. Branch: `codex/nexarch-integration-boundary`.

## Location

ForgeWeb remains a single React/Vite application with a native Node server. The internal boundary lives at [server/generation/engine.ts](../server/generation/engine.ts); [server/generation/contract.ts](../server/generation/contract.ts) checks and copies the request and candidate data. This location keeps the interface beside `server/workflow.ts`, `server/domain.ts`, and `server/policy.ts` without changing their current behavior. The contract has no production caller in Phase 2.

The future ForgeWeb adapter can live at `server/generation/adapter.ts`. It should implement the `GenerationEngine` interface and translate ForgeWeb's approved specification, policy and immutable version snapshot into engine input. A later, separately authorized NexArch implementation can live beneath `server/generation/nexarch/`. ForgeWeb's workflow should depend on `GenerationEngine`, never NexArch module types, stores, routers or configuration. No adapter or NexArch implementation exists yet.

## Contract

| Data or operation | Boundary rule |
|---|---|
| Project, build and operation IDs | Supplied by ForgeWeb. Results must carry the same project and approved specification IDs; the engine cannot create a canonical project. |
| Actor | Supplied by a ForgeWeb server-side caller. `local` represents the current unauthenticated development mode; `authenticated` is a future ownership context. This contract does not implement login or authorization. |
| Base snapshot | Explicitly `empty` for first generation or `version` with the ForgeWeb version ID. Files and a manifest digest are copied and frozen; no mutable `ProjectVersion` or store handle crosses the boundary. |
| Approved specification and design | Generation requests require `status: approved`, a confirmation timestamp, matching specification and plan digests, and an architecture projection matching the approved specification. Analysis/planning requests are separate so proposal work can precede confirmation. The future workflow must obtain the plan digest from an actual approval record; a caller cannot self-certify approval. |
| Nine engine operations | `analyzeRequirements`, `planArchitecture`, `designDatabase`, `generateBackend`, `generateFrontend`, `reviewSecurity`, `buildEngineeringGraph`, `validateCandidate`, and `repairCandidate` are typed but have no implementation. |
| Candidate files and artifacts | Paths, contents, requirement links and digests form an immutable candidate manifest. `state` can only be `candidate`; there is no accepted-version field or method. |
| Evidence | Validation checks retain required status, including `blocked` and `skipped`. Security findings and graph drafts are separate outputs. Engine evidence cannot mark a version accepted. |
| Failure | The result union distinguishes validation, generation, provider, capability, security, dependency, runner and internal engine failures. Messages must be safe to expose; future adapters must catch unexpected throws as internal failures. |

`prepareGenerationRequest` and `prepareCandidate` enforce identity, digests, basic path safety, budgets and traceability, then return frozen copies. They prove data does not alias the caller's objects. They do not replace ForgeWeb authorization, policy review, generated application validation, sandboxing or version acceptance. A future acceptance workflow must independently validate the final candidate and commit it through ForgeWeb's store. Failed candidates remain unaccepted.

## Future Flow

```text
ForgeWeb workflow and policy
  -> approved specification + ForgeWeb base version -> generation adapter
  -> candidate files/artifacts + engine findings/evidence
  -> ForgeWeb independent validation and review
  -> ForgeWeb version acceptance and graph snapshot
  -> existing workspace, preview and export
```

The current `BuildWorkflow.execute` still calls its existing generator and checks. The current JSON schema, project/version model, UI, API routes, provider configuration, preview and export were not changed for this spike. No mock generated an application.

## Unresolved Before Wiring

- Current ForgeWeb projects have no stored owner or authenticated principal. Production callers must supply a server-derived actor and enforce project/version access before using an engine.
- ForgeWeb does not yet persist approval of a richer structured engine design. Before wiring an engine, the workflow must bind the plan digest to the user-confirmed proposal; this spike only checks consistency of the supplied data.
- The engine interface has no persistence capability by design. Durable candidate staging, operation leases, compare-and-swap, and acceptance transactions remain later ForgeWeb work.
- A target profile must settle emitted layout, database dialect, authentication and dependencies. The contract does not claim NexArch's current output is compatible.
- Runtime build/test/preview and repair execution require an isolated runner in a later phase. `validateCandidate` and `repairCandidate` are interface operations only here.
- Digest serialization is local to this contract spike. Before distributed or cross-language adapters use it, define a canonical manifest encoding and versioned schema, and test across platforms.
- At Phase 2, NexArch's visible repository manifest was `UNLICENSED`, repository evidence alone did not establish reuse permission, and no NexArch source or dependency was imported. The original NexArch author subsequently explicitly authorized the ForgeWeb owner to use, modify, adapt, and integrate the NexArch source into ForgeWeb. This later authorization does not assert an open-source license or alter the historical Phase 2 implementation scope.

See the [Phase 1 audit](NEXARCH_INTEGRATION_AUDIT.md), [module mapping](NEXARCH_MODULE_MAPPING.md), [integration plan](NEXARCH_INTEGRATION_PLAN.md), and [risk register](NEXARCH_MIGRATION_RISKS.md).
