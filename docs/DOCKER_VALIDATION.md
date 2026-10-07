# Disposable Docker validation and preview

This is an opt-in adapter behind the existing `SandboxExecutor`,
`DisposablePostgresProvider` and `RuntimePreviewExecutor` contracts. The existing
approval, validation, engineering-graph and CAS acceptance gates are unchanged.
Missing required Docker, dependency or database evidence fails validation closed.
Missing TLS configuration leaves preview unavailable, separately from validated
candidate acceptance.

## Local setup

Use a local **Linux** Docker engine with default seccomp protection. Remote Docker
contexts are rejected. Verify the engine before enabling the adapters:

```powershell
docker --version
docker run --rm hello-world
docker build -t forgeweb-worker:local -f infrastructure/docker/worker.Dockerfile infrastructure/docker
```

The checked-in Dockerfile builds the trusted Node 22/Debian worker with PostgreSQL
and the reviewed supervisor. It creates `/opt/frontend/node_modules/.tmp` as a
symlink to `/tmp`, so TypeScript's build-information cache stays in the permitted
tmpfs even though dependencies and the container root are read-only. No separately
patched `forgeweb-worker:local-configured` image is required. This filesystem setup
is reproducible from the Dockerfile; base tags and dependency version ranges are
not a claim of bit-for-bit reproducible image builds.

Set server-side environment variables before `pnpm dev` or `pnpm dev:api`:

```powershell
$env:FORGEWEB_DOCKER_ENABLED="true"
$env:FORGEWEB_DOCKER_WORKER_IMAGE="forgeweb-worker:local"
# Optional aggregate validation execution window (1000-300000 ms):
$env:FORGEWEB_DOCKER_VALIDATION_EXECUTION_MS="180000"
# Optional full path if docker.exe is not on PATH:
# $env:FORGEWEB_DOCKER_EXECUTABLE="C:\Program Files\Docker\Docker\resources\bin\docker.exe"
```

Run the authenticated end-to-end diagnostic with
`node --experimental-strip-types scripts/docker-pipeline-smoke.ts`. It creates
and deletes an empty temporary ForgeWeb store, uses real configured adapters,
and never substitutes mock execution evidence or prints provider secrets. It
exits nonzero when validation, acceptance or preview cannot complete.

For preview, separately configure `FORGEWEB_PREVIEW_TLS_CERT` and
`FORGEWEB_PREVIEW_TLS_KEY` to an operator-provisioned localhost certificate and
private key supplied by the developer/operator. These variables contain host-side
file paths, not certificate/key contents. The certificate must be trusted by the
browser. No self-signed certificate is silently trusted; no HTTP fallback exists.
Both certificates and private keys must remain outside Git: the current
`.gitignore` does not generally exclude certificate/key extensions. Neither is
mounted in a worker. TLS absence leaves preview
unavailable without changing acceptance rules.

## Isolation and evidence

- Only sanitized, allowlisted registry package specifications enter dependency
  acquisition; hooks, overrides and candidate source do not. Lifecycle scripts
  are disabled. The trusted Prisma tool downloads its engine before isolation;
  Prisma client generation runs with build networking disabled. Custom schema
  generators are rejected. Generated Dockerfiles and npm scripts are not used.
  Only the reviewed `@prisma/engines` download hook is explicitly invoked;
  provider keys and `NODE_OPTIONS` are not inherited by Docker subprocesses.
- Each check uses a fresh, unprivileged container with no network, no host mounts,
  no capabilities, no writable root, bounded memory/processes/CPU/time and a
  writable `/tmp` only. Candidate source remains read-only in `/workspace`;
  compilation copies it into `/tmp`. Generated-app containers publish no ports.
  Docker flags follow the official
  [Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/).
- Command exit codes, not generated console output, determine results. Evidence
  includes the actual immutable image ID and candidate snapshot/policy identity.
  A timed-out or unavailable worker never produces passing evidence.
- PostgreSQL is installed in the trusted image and booted freshly on container
  loopback with random per-instance credentials and ephemeral storage. It has
  no published port and cannot reach user or control-plane databases. Prisma
  validates the schema, applies versioned migrations if present, otherwise
  explicitly bootstraps the empty schema, and checks live database drift.
  Bootstrap evidence is not a claim of versioned migration coverage.
- Backend startup must report database `up` and status `ok`, not merely HTTP 200.
  Generated tests run without `passWithNoTests`. Frontend typecheck/build run;
  the current generated frontend has no dedicated test suite, so backend tests
  do not constitute frontend behavioral coverage.
- Generated unit fixtures are checked against the generated entity/create DTO
  types, including enums. Protected-route integration tests assert rejection of
  missing/invalid tokens and use real register/login before expecting successful
  access. No authentication guard is removed, and missing sign-in capability is
  an explicit test failure rather than skipped access coverage.
- Only a candidate with all required passing static, isolated-code and disposable
  PostgreSQL evidence can reach owner-authorized CAS acceptance. Acceptance
  creates a linked immutable ProjectVersion; unavailable/failed checks do not.
  Preview availability is evaluated afterward and is not acceptance evidence.
- Validation tracks and cleans its own containers/images on success, failure and
  timeout; graceful service shutdown also disposes tracked resources. Cleanup
  failure prevents successful validation evidence. Abrupt termination can require
  operator inspection of leftover disposable resources; never prune unrelated
  Docker resources. The diagnostic deletes its disposable control-plane store.
  Build caches remain Docker-managed tooling caches; operators should maintain
  their normal cache-retention policy. Dependency resolution currently uses
  generated version ranges; image identity records the actual installed result,
  but reproducible lockfile provisioning is still an operational requirement.
  The verified tooling image ID is assigned a unique local build tag because
  BuildKit cannot reliably use a bare image ID in `FROM`; see the upstream
  [BuildKit issue](https://github.com/moby/buildkit/issues/2204).

## Preview boundary

Only an accepted immutable snapshot reaches the runtime adapter. A fresh
container hosts the application and disposable PostgreSQL. A separate trusted
HTTPS loopback gateway forwards requests through `docker exec`, not container
networking. No generated application code executes in the API process.
The gateway uses a random capability exchanged for a Secure/HttpOnly/SameSite=Strict
cookie, bounds requests and responses, strips control-plane cookies and headers,
and restricts browser resource connections to the preview origin. The URL is
separate from the ForgeWeb UI/API origin. The runtime is ephemeral, not production
deployment; preview data is discarded on cleanup.

Validation's aggregate execution window defaults to 180 seconds and is configured
by `FORGEWEB_DOCKER_VALIDATION_EXECUTION_MS`, bounded to 1-300 seconds. The existing
executor reads this window from `policy.resources.cpuMillis`; it is a wall-clock
deadline, not a measurement of aggregate CPU use. Locally measured typecheck,
build, tests and startup-health total approximately 96 seconds, so the previous
60-second window expired despite each check passing independently. Preparation
and checks remain within the existing 600-second outer deadline. Every container
still has one CPU and the unchanged 60-second per-process CPU ulimit. Exhaustion
continues to fail closed, with no acceptance. PostgreSQL and preview budgets are
unchanged: preview closes no later than 60 seconds after container launch.

Accepted safe-generation versions now expose Open Preview in the workspace. The
UI calls authenticated
`POST /api/safe/projects/:projectId/versions/:versionId/preview`, which uses the
existing `AcceptedRuntimePreviewService` and `DockerRuntimePreviewExecutor` to
start the HTTPS gateway. The backend remains authoritative for authentication,
owner authorization, accepted immutable ProjectVersion linkage and preview
capability/session creation. The returned URL has the form
`https://localhost:<random-loopback-port>/session/<capability>`; capability exchange
establishes the secure browser session that reaches the generated application.

The UI opens the HTTPS URL in a detached new browser tab, never an iframe for
safe-generation preview. Capabilities are not persisted. Preview starting, ready,
unavailable, failed and unauthorized states are handled. Legacy/non-safe-generation
projects retain their existing iframe preview. This UI handoff reuses the verified
runtime service; it introduced no second preview implementation and did not change
Docker/TLS internals, validation or CAS acceptance.

## Verification status

Docker/WSL and Groq availability have been verified locally, including a minimal
real Groq request through the existing abstraction. The authenticated task-app
diagnostic uses the task prompt plus the required planning answers (Admin/User,
email/password sign-in, no payments or external integrations), then approves the
exact plan normally. It generates 59 backend and 68 frontend files, assembles the
candidate and engineering graph, and has passed real Docker typecheck, build,
generated tests, startup-health and disposable PostgreSQL validation. CAS
acceptance created ProjectVersion 1 in the disposable test store, which was
removed during cleanup. These are bounded local-development results, not
production qualification or verification of every possible generated design.

On 2026-10-07, an uncached build from the checked-in Dockerfile produced
`forgeweb-worker:repro-audit-20261007`, without using the locally patched image.
Under the existing isolation flags, its cache symlink was writable through `/tmp`,
the root remained read-only, and the worker ran as UID 1000. The authenticated
diagnostic using that fresh image passed all required static, Docker and
PostgreSQL checks and CAS acceptance created ProjectVersion 1. Temporary services
and the disposable store were removed afterward. The ForgeWeb suite passed
159/159 tests; typecheck and client/server builds passed. Command-seam tests verify
orchestration/failure handling and are not substituted for this real Docker
evidence.

Independent HTTPS runtime verification passed 24 live security assertions. The
operator-provided mkcert certificate and private key loaded successfully; system
trust and hostname verification passed, and an incorrect hostname was rejected.
Capability exchange and the Secure/HttpOnly/SameSite=Strict cookie were verified.
Forged, missing and invalid capabilities, anonymous/wrong-owner/wrong-subject
access, and stale/missing/tampered ProjectVersion linkage were rejected.

The runtime retained Docker network none, no published ports, no host mounts, a
read-only root filesystem and UID 1000. PostgreSQL health and cleanup were
verified. No TLS private-key material or provider secrets were exposed, and no
HTTPS bypass was used. Certificates and private keys remain developer/operator
supplied and outside Git.

Focused runtime tests passed 17/17. The latest safe-preview focused tests passed
29/29, the latest full ForgeWeb suite passed 170/170, and typecheck, client/server
builds and `git diff --check` passed. The workspace Open Preview handoff is now
implemented and covered by API/client regression tests, separately from the live
runtime verification above. Legacy iframe preview remains intact. These results
remain bounded local-development evidence, not production qualification.

The diagnostic still exits nonzero when preview is unavailable even if validation
and acceptance succeeded; inspect the separate reported stage results.
