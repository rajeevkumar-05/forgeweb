import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { DockerDisposablePostgresProvider, DockerInfrastructure, DockerRuntimePreviewExecutor, DockerSandboxExecutor, PreviewRequestGate, dependencyManifest, dockerCommand, dockerIsolationArguments, dockerWorkflowFromEnvironment, previewSessionBootstrap, runtimePreviewSessionBudget, validateDockerSnapshot } from "../generation/docker-infrastructure.ts";
import type { DockerCommand } from "../generation/docker-infrastructure.ts";
import { ForgeWebIsolatedRunner, isolatedExecutionRequest, isolatedRunnerPolicy } from "../generation/runner.ts";
import { disposablePostgresRequest } from "../generation/postgres-validation.ts";
import type { AssembledCandidateArtifacts } from "../generation/candidate.ts";
import { ForgeWebSafeGenerationWorkflow } from "../generation/pipeline.ts";
import { digest } from "../lib.ts";
import { integrationActor, integrationFixture, integrationOwnerVerifier } from "./generation-integration-fixture.ts";

const imageId = `sha256:${"a".repeat(64)}`;
const schema = 'generator client {\n provider = "prisma-client-js"\n}\ndatasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}\nmodel Task {\n id String @id @default(uuid()) @db.Uuid\n}\n';
function files() {
  return [
    ["backend/prisma/schema.prisma", schema],
    ["backend/package.json", '{"dependencies":{"prisma":"6.8.0","@prisma/client":"6.8.0"}}'],
    ["frontend/package.json", '{"dependencies":{"react":"19.1.0"}}'],
  ].map(([path, content]) => ({ path, content, digest: digest(content) }));
}
function candidate(): AssembledCandidateArtifacts {
  return { id: "candidate-docker", manifestDigest: digest("docker-manifest"), files: files() } as unknown as AssembledCandidateArtifacts;
}

// These command-seam tests assert orchestration, not actual Docker attestation.
function commandFixture(options: { exitCode?: number; timeout?: boolean; cleanupFails?: boolean; remote?: boolean } = {}) {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const command: DockerCommand = async (args) => {
    mutableCalls.push([...args]);
    if (args[0] === "context") return { code: 0, stdout: options.remote ? "tcp://remote:2375" : "npipe:////./pipe/docker_engine" };
    if (args[0] === "info") return { code: 0, stdout: 'linux ["name=seccomp,profile=builtin"]' };
    if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: args.includes('{{index .Config.Labels "forgeweb.worker.contract"}}') ? "forgeweb-docker-worker-v1" : imageId };
    if (args[0] === "build") {
      const directory = args.at(-1)!;
      const dockerfile = await readFile(join(directory, "Dockerfile"), "utf8");
      assert.ok(dockerfile.includes("--ignore-scripts"));
      assert.ok(dockerfile.includes("RUN --network=none"));
      assert.ok(dockerfile.indexOf("npm install") < dockerfile.indexOf("COPY snapshot"));
      assert.ok(!dockerfile.includes("LLM_API_KEY"));
      return { code: 0, stdout: imageId };
    }
    if (args[0] === "run") {
      if (options.timeout) throw new Error("DOCKER_UNAVAILABLE_OR_TIMEOUT");
      return { code: options.exitCode ?? 0, stdout: "untrusted output must not become evidence" };
    }
    if (args[0] === "rm" && options.cleanupFails) return { code: 1, stdout: "" };
    return { code: 0, stdout: "" };
  };
  return { calls: mutableCalls, command };
}

test("Docker activation is opt-in, and TLS absence leaves preview unavailable", async () => {
  const disabled = dockerWorkflowFromEnvironment({});
  assert.deepEqual(disabled.options, {});
  const enabled = dockerWorkflowFromEnvironment({ FORGEWEB_DOCKER_ENABLED: "true" });
  assert.ok(enabled.options.validationRunner);
  assert.equal(enabled.options.runtimeExecutor, undefined);
  await enabled.dispose();
});

test("Docker isolation denies networking, writable root, host mounts and privileges", () => {
  const args = dockerIsolationArguments(isolatedRunnerPolicy());
  assert.ok(args.includes("--read-only"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "64");
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.ok(!args.includes("--privileged") && !args.includes("--volume") && !args.includes("--publish"));
  assert.throws(() => dockerIsolationArguments({ ...isolatedRunnerPolicy(), network: "host" } as never));
  assert.throws(() => dockerIsolationArguments({ ...isolatedRunnerPolicy(), userSecretAccess: true } as never));
});

test("validation timing configuration is bounded and does not change container isolation", async () => {
  assert.deepEqual(dockerIsolationArguments(isolatedRunnerPolicy(600_000, 180_000)), dockerIsolationArguments(isolatedRunnerPolicy()));
  for (const value of ["", "NaN", "Infinity", "999", "300001", "180000.5"]) {
    assert.throws(() => dockerWorkflowFromEnvironment({ FORGEWEB_DOCKER_ENABLED: "true", FORGEWEB_DOCKER_VALIDATION_EXECUTION_MS: value }), /execution budget/);
  }
  for (const value of ["1000", "180000", "300000"]) {
    const infrastructure = dockerWorkflowFromEnvironment({ FORGEWEB_DOCKER_ENABLED: "true", FORGEWEB_DOCKER_VALIDATION_EXECUTION_MS: value });
    assert.ok(infrastructure.options.validationRunner);
    await infrastructure.dispose();
  }
  assert.throws(() => dockerIsolationArguments({ ...isolatedRunnerPolicy(), resources: { memoryMb: 768, cpuMillis: 300_001, maxProcesses: 64 } }), /DOCKER_POLICY_UNSUPPORTED/);
  assert.notEqual(isolatedExecutionRequest(candidate()).policyDigest, isolatedExecutionRequest(candidate(), isolatedRunnerPolicy(600_000, 180_000)).policyDigest);
});

test("a bounded aggregate window permits all checks beyond 60 seconds and still fails closed on exhaustion", async (t) => {
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  for (const budget of [60_000, 180_000]) {
    clock = 0;
    const fixture = commandFixture();
    const docker = new DockerInfrastructure("forgeweb-worker:local", async (args, timeout, input) => {
      const result = await fixture.command(args, timeout, input);
      if (args[0] === "run") clock += 30_000;
      return result;
    });
    try {
      const request = isolatedExecutionRequest(candidate(), isolatedRunnerPolicy(600_000, budget));
      if (budget === 60_000) {
        await assert.rejects(() => new DockerSandboxExecutor(docker).execute(request), /DOCKER_OPERATION_TIMEOUT/);
        assert.equal(fixture.calls.filter((args) => args[0] === "run").length, 2);
      } else {
        const result = await new DockerSandboxExecutor(docker).execute(request);
        assert.deepEqual(result.checks.map((check) => check.id), ["typecheck", "build", "tests", "startup-health"]);
        assert.ok(result.checks.every((check) => check.status === "passed"));
        assert.equal(result.policyDigest, request.policyDigest);
      }
      assert.equal(fixture.calls.filter((args) => args[0] === "rm").length, budget === 60_000 ? 3 : 4);
      assert.ok(fixture.calls.some((args) => args[0] === "image" && args[1] === "rm"));
    } finally {
      await docker.dispose();
    }
  }
});

test("trusted Docker subprocesses do not inherit server-side provider keys or Node injection options", async () => {
  const before = process.env.FORGEWEB_DOCKER_TEST_SECRET;
  process.env.FORGEWEB_DOCKER_TEST_SECRET = "test-only-not-a-real-secret";
  try {
    const result = await dockerCommand(process.execPath)(["-e", "process.stdout.write(JSON.stringify({extra:!!process.env.FORGEWEB_DOCKER_TEST_SECRET,llm:!!process.env.LLM_API_KEY,canonical:!!process.env.FORGEWEB_LLM_API_KEY,nodeOptions:!!process.env.NODE_OPTIONS}))"], 5000);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { extra: false, llm: false, canonical: false, nodeOptions: false });
  } finally {
    if (before === undefined) delete process.env.FORGEWEB_DOCKER_TEST_SECRET;
    else process.env.FORGEWEB_DOCKER_TEST_SECRET = before;
  }
});

test("network-enabled package acquisition excludes candidate hooks, URLs and unknown packages", () => {
  const result = JSON.parse(dependencyManifest('{"scripts":{"postinstall":"steal-secrets"},"dependencies":{"react":"19.1.0"},"overrides":{"react":"https://example.invalid"}}'));
  assert.equal(result.scripts, undefined);
  assert.equal(result.overrides, undefined);
  assert.throws(() => dependencyManifest('{"dependencies":{"react":"https://example.invalid/pkg.tgz"}}'));
  assert.throws(() => dependencyManifest('{"dependencies":{"unreviewed-plugin":"1.0.0"}}'));
});

test("Docker snapshots enforce digest, paths, credentials-file, collision and budget checks", () => {
  validateDockerSnapshot(files());
  for (const path of ["backend/../.env", "backend/.env", "backend/.env.local", "backend/node_modules/a.js", "backend/CON", "backend//x", "C:/key", "backend/x."]) {
    assert.throws(() => validateDockerSnapshot([...files(), { path, content: "x", digest: digest("x") }]));
  }
  assert.throws(() => validateDockerSnapshot([...files(), { ...files()[0], digest: "bad" }]));
  assert.throws(() => validateDockerSnapshot([...files(), { ...files()[0], path: files()[0].path.toUpperCase() }]));
  assert.throws(() => validateDockerSnapshot(Array.from({ length: 513 }, () => files()[0])));
  assert.throws(() => validateDockerSnapshot([...files(), { path: "backend/big.txt", content: "x".repeat(8_000_001), digest: digest("x".repeat(8_000_001)) }]));
  const unsafe = schema.replace('"prisma-client-js"', '"custom-generator"');
  assert.throws(() => validateDockerSnapshot([{ path: "backend/prisma/schema.prisma", content: unsafe, digest: digest(unsafe) }]));
});

test("Docker executor binds real command exit codes to snapshot and image, and cleans every check container", async () => {
  const fixture = commandFixture({ exitCode: 1 });
  const docker = new DockerInfrastructure("forgeweb-worker:local", fixture.command);
  const request = isolatedExecutionRequest(candidate());
  const result = await new DockerSandboxExecutor(docker).execute(request);
  assert.equal(result.snapshotDigest, request.snapshotDigest);
  assert.equal(result.policyDigest, request.policyDigest);
  assert.equal(result.imageDigest, imageId);
  assert.equal(result.checks.length, 4);
  assert.ok(result.checks.every((check) => check.status === "failed" && !check.evidence.includes("untrusted output")));
  assert.equal(fixture.calls.filter((args) => args[0] === "run").length, 4);
  assert.equal(fixture.calls.filter((args) => args[0] === "rm").length, 4);
  assert.ok(fixture.calls.some((args) => args[0] === "image" && args[1] === "rm"));
  await docker.dispose();
});

test("timeout kills its own named container and cannot yield successful evidence", async () => {
  const fixture = commandFixture({ timeout: true });
  const docker = new DockerInfrastructure("forgeweb-worker:local", fixture.command);
  const result = await new ForgeWebIsolatedRunner(new DockerSandboxExecutor(docker)).validate(candidate());
  assert.equal(result.ok, false);
  assert.ok(fixture.calls.some((args) => args[0] === "rm" && args.includes("--force")));
  await docker.dispose();
});

test("remote Docker endpoints are rejected before images or generated code are touched", async () => {
  const fixture = commandFixture({ remote: true });
  const docker = new DockerInfrastructure("forgeweb-worker:local", fixture.command);
  await assert.rejects(() => docker.ready(), /LOCAL_DOCKER_ENGINE_REQUIRED/);
  assert.equal(fixture.calls.length, 1);
});

test("missing Docker is unavailable and never successful", async () => {
  const command: DockerCommand = async () => { throw new Error("DOCKER_UNAVAILABLE_OR_TIMEOUT"); };
  const docker = new DockerInfrastructure("forgeweb-worker:local", command);
  const result = await new ForgeWebIsolatedRunner(new DockerSandboxExecutor(docker)).validate(candidate());
  assert.equal(result.ok, false);
  const pg = new DockerDisposablePostgresProvider(docker);
  await assert.rejects(() => pg.validate(disposablePostgresRequest(candidate())), /DOCKER_UNAVAILABLE_OR_TIMEOUT/);
});

test("disposable PostgreSQL uses a fresh isolated instance, reports failed real commands and cleans it", async () => {
  const fixture = commandFixture({ exitCode: 1 });
  const docker = new DockerInfrastructure("forgeweb-worker:local", fixture.command);
  const result = await new DockerDisposablePostgresProvider(docker).validate(disposablePostgresRequest(candidate()));
  assert.equal(result.schema.status, "failed");
  assert.equal(result.migrations.status, "failed");
  assert.match(result.migrations.evidence, /schema bootstrap/);
  assert.equal(result.snapshotDigest, candidate().manifestDigest);
  assert.ok(result.instanceDigest);
  assert.equal(fixture.calls.filter((args) => args[0] === "rm").length, 1);
  assert.ok(!JSON.stringify(fixture.calls).includes("DATABASE_URL="));
  await docker.dispose();
});

test("cleanup failure cannot be attested as successful database validation", async () => {
  const fixture = commandFixture({ cleanupFails: true });
  const docker = new DockerInfrastructure("forgeweb-worker:local", fixture.command);
  await assert.rejects(() => new DockerDisposablePostgresProvider(docker).validate(disposablePostgresRequest(candidate())), /DOCKER_CONTAINER_CLEANUP_FAILED/);
  await assert.rejects(() => docker.dispose(), /DOCKER_CLEANUP_INCOMPLETE/);
});

test("runtime expiry and disposal share in-flight container and image cleanup", async () => {
  const fixture = commandFixture();
  const docker = new DockerInfrastructure("forgeweb-worker:local", fixture.command);
  const image = await docker.prepare(files(), Date.now() + 10_000);
  const container = await docker.run(image, "runtime", isolatedRunnerPolicy(), Date.now() + 10_000, true);
  await Promise.all([
    docker.removeContainer(container.name).then(() => docker.removeImage(image)),
    docker.removeContainer(container.name).then(() => docker.removeImage(image)),
    docker.dispose(),
  ]);
  assert.equal(fixture.calls.filter(args => args[0] === "rm").length, 1);
  assert.equal(fixture.calls.filter(args => args[0] === "image" && args[1] === "rm" && args.includes(image.tag)).length, 1);
});

test("preview requires actual TLS files, never an HTTP fallback", async () => {
  const fixture = commandFixture();
  const docker = new DockerInfrastructure("forgeweb-worker:local", fixture.command);
  const executor = new DockerRuntimePreviewExecutor(docker, { certificatePath: "missing-forgeweb-test-cert", keyPath: "missing-forgeweb-test-key" });
  await assert.rejects(() => executor.start({ policy: isolatedRunnerPolicy() } as never));
  assert.equal(fixture.calls.length, 0);
});

test("ready preview sessions retain a bounded lifetime independent of startup time", () => {
  const tls = { certificatePath: "operator-cert", keyPath: "operator-key" };
  const policy = isolatedRunnerPolicy();
  assert.equal(runtimePreviewSessionBudget(tls, policy), 60_000);
  assert.equal(runtimePreviewSessionBudget({ ...tls, ttlMs: 10_000 }, policy), 10_000);
  assert.equal(runtimePreviewSessionBudget({ ...tls, ttlMs: 300_000 }, policy), 60_000);
  assert.equal(runtimePreviewSessionBudget(tls, isolatedRunnerPolicy(120_000, 5_000)), 5_000);
  for (const ttlMs of [0, -1, 999, 300_001, NaN, Infinity, 1000.5]) {
    assert.throws(() => runtimePreviewSessionBudget({ ...tls, ttlMs }, policy), /PREVIEW_SESSION_BUDGET_INVALID/);
  }
  assert.ok(dockerIsolationArguments(policy).includes("cpu=60:60"));
});

test("capability bootstrap commits a document before replacing the capability URL with the same-origin root", () => {
  const bootstrap = previewSessionBootstrap();
  const script = bootstrap.html.match(/<script nonce="([a-f0-9]{32})">([^<]+)<\/script>/);
  assert.ok(script);
  const destinations: string[] = [];
  runInNewContext(script[2], { window: { location: { replace(path: string) { destinations.push(path); } } } });
  assert.deepEqual(destinations, ["/"]);
  assert.ok(bootstrap.html.includes('<a href="/">Continue to preview</a>'));
  assert.equal(bootstrap.contentSecurityPolicy, `default-src 'none'; script-src 'nonce-${script[1]}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
});

test("capability bootstrap uses a fresh CSP nonce without credentials or persistent storage", () => {
  const first = previewSessionBootstrap();
  const second = previewSessionBootstrap();
  assert.notEqual(first.contentSecurityPolicy, second.contentSecurityPolicy);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(first.contentSecurityPolicy));
  assert.ok(!/\/session\/|document\.cookie|localStorage|sessionStorage|fetch\(/.test(first.html));
});

test("preview asset bursts queue without exceeding two active forwards", async () => {
  const gate = new PreviewRequestGate();
  const first = (await gate.acquire())!;
  const second = (await gate.acquire())!;
  let granted = false;
  const waiting = gate.acquire().then(release => { granted = true; return release!; });
  await Promise.resolve();
  assert.equal(granted, false);
  first();
  const third = await waiting;
  assert.equal(granted, true);
  second(); third();
});

test("preview queue denies overflow and releases cancelled requests", async () => {
  const gate = new PreviewRequestGate();
  const first = (await gate.acquire())!;
  const second = (await gate.acquire())!;
  const cancellation = new AbortController();
  const pending = Array.from({ length: 8 }, () => gate.acquire(cancellation.signal));
  assert.equal(await gate.acquire(), undefined);
  cancellation.abort();
  assert.ok((await Promise.all(pending)).every(release => release === undefined));
  first(); first(); second();
  const release = await gate.acquire();
  assert.ok(release);
  release();
});

test("preview queue wait expires without forwarding when its bound is exhausted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = new PreviewRequestGate();
  const first = (await gate.acquire())!;
  const second = (await gate.acquire())!;
  const waiting = gate.acquire();
  t.mock.timers.tick(10_000);
  assert.equal(await waiting, undefined);
  first(); second();
});

test("real unavailable Docker configuration blocks acceptance and workspace/version mutation", async () => {
  const fixture = await integrationFixture();
  const infrastructure = dockerWorkflowFromEnvironment({ FORGEWEB_DOCKER_ENABLED: "true", FORGEWEB_DOCKER_EXECUTABLE: "forgeweb-test-missing-docker" });
  try {
    const before = structuredClone(fixture.store.read().versions);
    const result = await new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, infrastructure.options).runApproved(fixture.request, integrationActor);
    assert.equal(result.status, "validation_unavailable");
    assert.equal(result.stage, "validation");
    assert.ok(result.graph);
    assert.equal(result.acceptance, undefined);
    assert.equal(result.preview, undefined);
    assert.deepEqual(fixture.store.read().versions, before);
    assert.equal(fixture.store.read().projects["project-integration"].currentVersionId, undefined);
  } finally {
    await infrastructure.dispose();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
