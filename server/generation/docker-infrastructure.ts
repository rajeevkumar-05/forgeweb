import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { digest } from "../lib.ts";
import type { SafeGenerationWorkflowOptions } from "./pipeline.ts";
import { CombinedValidationRunner, ForgeWebPostgresValidator } from "./postgres-validation.ts";
import type { DisposablePostgresExecution, DisposablePostgresProvider, DisposablePostgresRequest } from "./postgres-validation.ts";
import { ForgeWebIsolatedRunner, isolatedRunnerPolicy } from "./runner.ts";
import type { IsolatedExecutionRequest, IsolatedRunnerPolicy, SandboxExecutionResult, SandboxExecutor } from "./runner.ts";
import type { AcceptedRuntimePreviewRequest, RuntimePreviewExecution, RuntimePreviewExecutor } from "./runtime-preview.ts";

type SnapshotFile = { readonly path: string; readonly content: string; readonly digest: string };
type CommandResult = { readonly code: number; readonly stdout: string };
export type DockerCommand = (args: readonly string[], timeoutMs: number, input?: string) => Promise<CommandResult>;

const packages = new Set(("@prisma/client bcryptjs jsonwebtoken compression cors dotenv express express-rate-limit helmet swagger-ui-express winston zod morgan @eslint/js @types/bcryptjs @types/compression @types/cors @types/express @types/jest @types/jsonwebtoken @types/morgan @types/node @types/supertest @types/swagger-ui-express eslint jest prisma supertest ts-jest tsx typescript typescript-eslint @hookform/resolvers @tanstack/react-query axios clsx framer-motion lucide-react react react-dom react-hook-form react-router-dom tailwind-merge zustand @tailwindcss/vite @types/react @types/react-dom @vitejs/plugin-react eslint-plugin-react-hooks eslint-plugin-react-refresh globals tailwindcss vite").split(" "));

export function dependencyManifest(content: string): string {
  const input = JSON.parse(content) as Record<string, unknown>;
  const result: Record<string, unknown> = { private: true, type: "module" };
  for (const field of ["dependencies", "devDependencies"]) {
    const dependencies = input[field] ?? {};
    if (typeof dependencies !== "object" || !dependencies || Array.isArray(dependencies)) throw new Error("DOCKER_DEPENDENCY_PROFILE_INVALID");
    for (const [name, version] of Object.entries(dependencies)) {
      if (!packages.has(name) || typeof version !== "string" || !/^\^?\d+\.\d+\.\d+$/.test(version)) throw new Error("DOCKER_DEPENDENCY_PROFILE_UNSUPPORTED");
    }
    result[field] = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
  }
  // Never let candidate lifecycle scripts, overrides, registry URLs or local
  // package references enter the network-enabled dependency acquisition step.
  return JSON.stringify(result);
}

export function validateDockerSnapshot(files: readonly SnapshotFile[]): void {
  if (!files.length || files.length > 512) throw new Error("DOCKER_SNAPSHOT_FILE_BUDGET");
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (!/^(backend|frontend)\/[A-Za-z0-9_.@/-]+$/.test(file.path)
      || file.path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === "node_modules")
      || file.path.split("/").some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part))
      || /(?:^|\/)\.env(?:$|\.(?!example$))/.test(file.path)
      || typeof file.content !== "string" || file.digest !== digest(file.content)) throw new Error("DOCKER_SNAPSHOT_INVALID");
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new Error("DOCKER_SNAPSHOT_COLLISION");
    paths.add(key);
    bytes += Buffer.byteLength(file.content);
  }
  if (bytes > 8_000_000) throw new Error("DOCKER_SNAPSHOT_BYTE_BUDGET");
  const schema = files.find((file) => file.path === "backend/prisma/schema.prisma")?.content;
  if (!schema || !/provider\s*=\s*"postgresql"/.test(schema) || !/url\s*=\s*env\("DATABASE_URL"\)/.test(schema)
    || [...schema.matchAll(/datasource\s+\w+\s*\{/g)].length !== 1
    || [...schema.matchAll(/generator\s+\w+\s*\{/g)].length !== 1
    || [...schema.matchAll(/generator\s+\w+\s*\{([^}]*)\}/g)].some((entry) => !/^\s*provider\s*=\s*"prisma-client-js"\s*$/.test(entry[1]))) throw new Error("DOCKER_SCHEMA_PROFILE_UNSUPPORTED");
}

export function dockerIsolationArguments(policy: IsolatedRunnerPolicy): string[] {
  if (policy.version !== "forgeweb-isolated-runner-v1" || policy.network !== "none" || policy.hostPathAccess !== false
    || policy.userSecretAccess !== false || policy.forgeWebControlPlaneAccess !== false || policy.boundary !== "external-container"
    || policy.mounts.length !== 1 || policy.mounts[0].target !== "/workspace" || policy.mounts[0].mode !== "read-only-snapshot"
    || policy.writablePaths.length !== 1 || policy.writablePaths[0] !== "/tmp"
    || JSON.stringify(policy.environment) !== JSON.stringify({ CI: "true", NODE_ENV: "test" })
    || policy.resources.memoryMb !== 768 || !Number.isSafeInteger(policy.resources.cpuMillis)
    || policy.resources.cpuMillis < 1_000 || policy.resources.cpuMillis > 300_000
    || policy.resources.maxProcesses !== 64) throw new Error("DOCKER_POLICY_UNSUPPORTED");
  return ["--network", "none", "--ipc", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
    "--user", "1000:1000", "--memory", `${policy.resources.memoryMb}m`, "--memory-swap", `${policy.resources.memoryMb}m`,
    "--cpus", "1", "--pids-limit", String(policy.resources.maxProcesses), "--ulimit", "cpu=60:60",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700", "--init", "--log-driver", "none"];
}

export function dockerCommand(executable = "docker"): DockerCommand {
  return (args, timeoutMs, input) => new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = execFile(executable, [...args], { env, timeout: timeoutMs, maxBuffer: 4_000_000, windowsHide: true }, (error, stdout) => {
      if (error && (typeof error.code !== "number" || error.killed)) reject(new Error("DOCKER_UNAVAILABLE_OR_TIMEOUT"));
      else resolvePromise({ code: error ? Number(error.code) : 0, stdout: String(stdout) });
    });
    child.stdin?.end(input);
  });
}

type PreparedImage = { id: string; tag: string };
export class DockerInfrastructure {
  readonly command: DockerCommand;
  private readonly baseImage: string;
  private readonly resources = new Set<string>();
  private readonly images = new Set<string>();
  private readonly gateways = new Set<Server>();
  private readonly removals = new Map<string, Promise<void>>();
  private closed = false;

  constructor(baseImage = "forgeweb-worker:local", command: DockerCommand = dockerCommand()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(baseImage)) throw new Error("DOCKER_IMAGE_INVALID");
    this.baseImage = baseImage;
    this.command = command;
  }

  async ready(): Promise<string> {
    if (this.closed) throw new Error("DOCKER_INFRASTRUCTURE_CLOSED");
    const context = await this.command(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], 5_000);
    if (context.code || !/^(npipe:\/\/|unix:\/\/)/.test(context.stdout.trim())) throw new Error("LOCAL_DOCKER_ENGINE_REQUIRED");
    const info = await this.command(["info", "--format", "{{.OSType}} {{json .SecurityOptions}}"], 5_000);
    if (info.code || !info.stdout.startsWith("linux ") || !info.stdout.includes("seccomp")) throw new Error("DOCKER_LINUX_SECCOMP_REQUIRED");
    const contract = await this.command(["image", "inspect", "--format", '{{index .Config.Labels "forgeweb.worker.contract"}}', this.baseImage], 5_000);
    if (contract.code || contract.stdout.trim() !== "forgeweb-docker-worker-v1") throw new Error("DOCKER_WORKER_CONTRACT_REQUIRED");
    const image = await this.command(["image", "inspect", "--format", "{{.Id}}", this.baseImage], 5_000);
    if (image.code || !/^sha256:[a-f0-9]{64}$/.test(image.stdout.trim())) throw new Error("DOCKER_WORKER_IMAGE_UNAVAILABLE");
    return image.stdout.trim();
  }

  async prepare(files: readonly SnapshotFile[], deadline: number): Promise<PreparedImage> {
    validateDockerSnapshot(files);
    const base = await this.ready();
    const directory = await mkdtemp(join(tmpdir(), "forgeweb-docker-"));
    const tag = `forgeweb-snapshot:${randomUUID()}`;
    const toolingTag = `forgeweb-tooling:${randomUUID()}`;
    this.images.add(tag);
    this.images.add(toolingTag);
    try {
      // BuildKit does not reliably accept a bare image ID in FROM. Give the
      // verified local ID a private per-build tag instead of a mutable base tag.
      const tagged = await this.command(["image", "tag", base, toolingTag], this.remaining(deadline));
      if (tagged.code) throw new Error("DOCKER_TOOLING_IMAGE_UNAVAILABLE");
      const backend = files.find((file) => file.path === "backend/package.json")?.content ?? '{"dependencies":{"prisma":"6.8.0","@prisma/client":"6.8.0"}}';
      const frontend = files.find((file) => file.path === "frontend/package.json")?.content ?? '{}';
      await mkdir(join(directory, "packages", "backend"), { recursive: true });
      await mkdir(join(directory, "packages", "frontend"), { recursive: true });
      await writeFile(join(directory, "packages", "backend", "package.json"), dependencyManifest(backend));
      await writeFile(join(directory, "packages", "frontend", "package.json"), dependencyManifest(frontend));
      const schema = files.find((file) => file.path === "backend/prisma/schema.prisma")!;
      await writeFile(join(directory, "schema.prisma"), schema.content);
      for (const file of files) {
        const destination = join(directory, "snapshot", ...file.path.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.content);
      }
      await writeFile(join(directory, "Dockerfile"), [
        `FROM ${toolingTag}`,
        "USER root",
        "COPY packages/backend /opt/backend",
        "COPY packages/frontend /opt/frontend",
        "RUN cd /opt/backend && npm install --ignore-scripts --no-audit --no-fund && cd /opt/frontend && npm install --ignore-scripts --no-audit --no-fund",
        "RUN node /opt/backend/node_modules/@prisma/engines/scripts/postinstall.js",
        "COPY schema.prisma /opt/backend/prisma/schema.prisma",
        'RUN --network=none DATABASE_URL="postgresql://USER:PASSWORD@127.0.0.1:5432/forgeweb" node /opt/backend/node_modules/prisma/build/index.js generate --schema=/opt/backend/prisma/schema.prisma',
        "COPY snapshot /workspace",
        "USER 1000:1000", "",
      ].join("\n"));
      const built = await this.command(["build", "--quiet", "--tag", tag, directory], this.remaining(deadline));
      if (built.code !== 0) throw new Error("DOCKER_DEPENDENCY_OR_PRISMA_BUILD_FAILED");
      const image = await this.command(["image", "inspect", "--format", "{{.Id}}", tag], this.remaining(deadline));
      if (image.code || !/^sha256:[a-f0-9]{64}$/.test(image.stdout.trim())) throw new Error("DOCKER_IMAGE_ATTESTATION_INVALID");
      return { id: image.stdout.trim(), tag };
    } catch (error) {
      await this.removeImage({ id: "", tag });
      throw error;
    } finally {
      // Only this freshly created absolute directory is ever deleted.
      if (resolve(directory).startsWith(resolve(tmpdir()) + "\\") || resolve(directory).startsWith(resolve(tmpdir()) + "/")) await rm(directory, { recursive: true, force: true });
      await this.removeImage({ id: base, tag: toolingTag });
    }
  }

  remaining(deadline: number): number {
    const remaining = deadline - Date.now();
    if (remaining < 1 || this.closed) throw new Error("DOCKER_OPERATION_TIMEOUT");
    return remaining;
  }

  async run(image: PreparedImage, mode: string, policy: IsolatedRunnerPolicy, deadline: number, detached = false): Promise<{ name: string; result: CommandResult }> {
    if (!["typecheck", "build", "tests", "health", "postgres", "runtime"].includes(mode)) throw new Error("DOCKER_OPERATION_UNSUPPORTED");
    const name = `forgeweb-${randomUUID()}`;
    this.resources.add(name);
    try {
      const result = await this.command(["run", ...(detached ? ["--detach"] : []), "--name", name, "--label", "forgeweb.disposable=true",
        ...dockerIsolationArguments(policy), "--entrypoint", "node", image.id, "/opt/forgeweb/worker.mjs", mode], this.remaining(deadline));
      return { name, result };
    } catch (error) {
      await this.removeContainer(name);
      throw error;
    }
  }

  async removeContainer(name: string): Promise<void> {
    await this.removeOnce(`container:${name}`, async () => {
      if (!this.resources.has(name)) return;
      const removed = await this.command(["rm", "--force", "--volumes", name], 10_000).catch(() => ({ code: 1, stdout: "" }));
      if (removed.code === 0) this.resources.delete(name);
      else throw new Error("DOCKER_CONTAINER_CLEANUP_FAILED");
    });
  }

  async removeImage(image: PreparedImage): Promise<void> {
    await this.removeOnce(`image:${image.tag}`, async () => {
      if (!this.images.has(image.tag)) return;
      const removed = await this.command(["image", "rm", "--force", image.tag], 10_000).catch(() => ({ code: 1, stdout: "" }));
      if (removed.code === 0) this.images.delete(image.tag);
      else throw new Error("DOCKER_IMAGE_CLEANUP_FAILED");
    });
  }

  private async removeOnce(key: string, operation: () => Promise<void>): Promise<void> {
    const pending = this.removals.get(key);
    if (pending) return pending;
    const task = operation();
    this.removals.set(key, task);
    try { await task; }
    finally { this.removals.delete(key); }
  }

  registerGateway(server: Server): void { this.gateways.add(server); }
  unregisterGateway(server: Server): void { this.gateways.delete(server); }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const gateway of this.gateways) { gateway.closeAllConnections(); gateway.close(); }
    this.gateways.clear();
    const containers = await Promise.allSettled([...this.resources].map((name) => this.removeContainer(name)));
    const images = await Promise.allSettled([...this.images].map((tag) => this.removeImage({ id: "", tag })));
    const results = [...containers, ...images];
    if (results.some((result) => result.status === "rejected")) throw new Error("DOCKER_CLEANUP_INCOMPLETE");
  }
}

export class DockerSandboxExecutor implements SandboxExecutor {
  private readonly docker: DockerInfrastructure;
  constructor(docker: DockerInfrastructure) { this.docker = docker; }

  async execute(request: IsolatedExecutionRequest): Promise<SandboxExecutionResult> {
    dockerIsolationArguments(request.policy);
    const deadline = Date.now() + request.policy.timeoutMs - 500;
    let image: PreparedImage | undefined;
    const containers: string[] = [];
    try {
      image = await this.docker.prepare(request.files, deadline);
      const executionDeadline = Math.min(deadline, Date.now() + request.policy.resources.cpuMillis);
      const checks: SandboxExecutionResult["checks"][number][] = [];
      for (const [id, mode] of [["typecheck", "typecheck"], ["build", "build"], ["tests", "tests"], ["startup-health", "health"]]) {
        const run = await this.docker.run(image, mode, request.policy, executionDeadline);
        containers.push(run.name);
        checks.push({ id, status: run.result.code === 0 ? "passed" : "failed", required: true,
          evidence: `Docker ${mode} exited ${run.result.code} on immutable image ${image.id}`, subjectPaths: [] });
        await this.docker.removeContainer(run.name);
      }
      return { candidateId: request.candidateId, snapshotDigest: request.snapshotDigest, policyDigest: request.policyDigest,
        sessionId: randomUUID(), imageDigest: image.id, checks, findings: [] };
    } finally {
      for (const name of containers) await this.docker.removeContainer(name);
      if (image) await this.docker.removeImage(image);
    }
  }
}

export class DockerDisposablePostgresProvider implements DisposablePostgresProvider {
  private readonly docker: DockerInfrastructure;
  constructor(docker: DockerInfrastructure) { this.docker = docker; }

  async validate(request: DisposablePostgresRequest): Promise<DisposablePostgresExecution> {
    if (request.target.policyVersion !== "forgeweb-disposable-postgresql-v1" || request.target.network !== "isolated"
      || request.target.userDatabaseAccess !== false || request.target.forgeWebControlPlaneAccess !== false || request.target.destroyAfterValidation !== true) throw new Error("DOCKER_POSTGRES_POLICY_UNSUPPORTED");
    const deadline = Date.now() + 110_000;
    let image: PreparedImage | undefined;
    let name: string | undefined;
    try {
      image = await this.docker.prepare([request.schema, ...request.migrations], deadline);
      const run = await this.docker.run(image, "postgres", isolatedRunnerPolicy(), Math.min(deadline, Date.now() + 60_000));
      name = run.name;
      const status = run.result.code === 0 ? "passed" : "failed";
      return { candidateId: request.candidateId, snapshotDigest: request.snapshotDigest,
        instanceDigest: digest(JSON.stringify([run.name, image.id, request.snapshotDigest])),
        schema: { status, evidence: `Prisma validation and live PostgreSQL schema comparison exited ${run.result.code}` },
        migrations: { status, evidence: `${request.migrations.some((file) => file.path.endsWith("/migration.sql")) ? "Versioned migration deployment" : "Explicit empty-database schema bootstrap"} and drift check exited ${run.result.code} in disposable PostgreSQL` } };
    } finally {
      if (name) await this.docker.removeContainer(name);
      if (image) await this.docker.removeImage(image);
    }
  }
}

// HTTPS gateway runs only trusted forwarding code on the host. All application
// HTTP handling, including static-file access, occurs in a network-none worker.
const bridge = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{try{const q=JSON.parse(input);const r=await fetch('http://127.0.0.1:8080'+q.path,{method:q.method,headers:q.headers,body:['GET','HEAD'].includes(q.method)?undefined:Buffer.from(q.body,'base64'),signal:AbortSignal.timeout(8000),redirect:'manual'});const b=Buffer.from(await r.arrayBuffer());if(b.length>2000000)process.exit(1);console.log(JSON.stringify({status:r.status,type:r.headers.get('content-type'),body:b.toString('base64')}));}catch{process.exit(1)}});`;

export type PreviewTls = { readonly certificatePath: string; readonly keyPath: string; readonly ttlMs?: number };
export function runtimePreviewSessionBudget(tls: PreviewTls, policy: IsolatedRunnerPolicy): number {
  const ttlMs = tls.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) throw new Error("PREVIEW_SESSION_BUDGET_INVALID");
  return Math.min(ttlMs, policy.resources.cpuMillis);
}
export class PreviewRequestGate {
  private active = 0;
  private readonly pending: (() => void)[] = [];

  async acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
    if (signal?.aborted) return undefined;
    if (this.active >= 2) {
      if (this.pending.length >= 8) return undefined;
      const granted = await new Promise<boolean>((done) => {
        const finish = (value: boolean) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          const index = this.pending.indexOf(grant);
          if (index >= 0) this.pending.splice(index, 1);
          done(value);
        };
        const grant = () => { this.active++; finish(true); };
        const abort = () => finish(false);
        const timer = setTimeout(abort, 10_000);
        timer.unref();
        this.pending.push(grant);
        signal?.addEventListener("abort", abort, { once: true });
      });
      if (!granted) return undefined;
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pending.shift()?.();
    };
  }
}
export class DockerRuntimePreviewExecutor implements RuntimePreviewExecutor {
  private readonly docker: DockerInfrastructure;
  private readonly tls: PreviewTls;
  constructor(docker: DockerInfrastructure, tls: PreviewTls) { this.docker = docker; this.tls = tls; }

  async start(request: AcceptedRuntimePreviewRequest): Promise<RuntimePreviewExecution> {
    dockerIsolationArguments(request.policy);
    const sessionBudgetMs = runtimePreviewSessionBudget(this.tls, request.policy);
    const deadline = Date.now() + Math.min(110_000, request.policy.timeoutMs - 500);
    const [cert, key] = await Promise.all([readFile(this.tls.certificatePath), readFile(this.tls.keyPath)]);
    let image: PreparedImage | undefined;
    let container: string | undefined;
    let gateway: Server | undefined;
    let keep = false;
    try {
      image = await this.docker.prepare(request.files, deadline);
      const executionDeadline = Math.min(deadline, Date.now() + request.policy.resources.cpuMillis);
      const run = await this.docker.run(image, "runtime", request.policy, executionDeadline, true);
      container = run.name;
      if (run.result.code !== 0) throw new Error("DOCKER_RUNTIME_START_FAILED");
      let ready = false;
      while (this.docker.remaining(executionDeadline) > 1000) {
        const health = await this.docker.command(["exec", container, "node", "-e", "fetch('http://127.0.0.1:8080').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], Math.min(3000, this.docker.remaining(executionDeadline)));
        if (health.code === 0) { ready = true; break; }
        await new Promise((done) => setTimeout(done, 500));
      }
      if (!ready) throw new Error("DOCKER_RUNTIME_HEALTH_FAILED");
      const token = randomBytes(32).toString("hex");
      const cookieName = `forgeweb_preview_${randomBytes(8).toString("hex")}`;
      const name = container;
      const gate = new PreviewRequestGate();
      gateway = createServer({ cert, key }, async (incoming, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
        if (incoming.method === "GET" && incoming.url === `/session/${token}`) {
          response.writeHead(303, { "Set-Cookie": `${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`, Location: "/" });
          response.end(); return;
        }
        if (!incoming.headers.cookie?.split(";").some((cookie) => cookie.trim() === `${cookieName}=${token}`)) { response.writeHead(401); response.end(); return; }
        if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) { response.writeHead(429); response.end(); return; }
        const cancellation = new AbortController();
        const cancel = () => cancellation.abort();
        response.once("close", cancel);
        const release = await gate.acquire(cancellation.signal);
        response.removeListener("close", cancel);
        if (!release) { if (!response.destroyed) { response.writeHead(429); response.end(); } return; }
        try {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of incoming) {
            bytes += chunk.length;
            if (bytes > 1_000_000) throw new Error("PREVIEW_BODY_BUDGET");
            chunks.push(Buffer.from(chunk));
          }
          const headers: Record<string, string> = {};
          for (const header of ["content-type", "authorization", "accept"]) {
            const value = incoming.headers[header];
            if (typeof value === "string") headers[header] = value;
          }
          const forwarded = await this.docker.command(["exec", "-i", name, "node", "-e", bridge], 10_000,
            JSON.stringify({ path: incoming.url, method: incoming.method, headers, body: Buffer.concat(chunks).toString("base64") }));
          if (forwarded.code) throw new Error("PREVIEW_FORWARD_FAILED");
          const result = JSON.parse(forwarded.stdout) as { status: number; type: string; body: string };
          if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599 || typeof result.body !== "string") throw new Error("PREVIEW_RESPONSE_INVALID");
          response.writeHead(result.status, { "Content-Type": result.type || "application/octet-stream" });
          response.end(Buffer.from(result.body, "base64"));
        } catch { response.writeHead(502); response.end(); }
        finally { release(); }
      });
      gateway.requestTimeout = 15_000;
      gateway.headersTimeout = 10_000;
      await new Promise<void>((done, reject) => { gateway!.once("error", reject); gateway!.listen(0, "127.0.0.1", done); });
      this.docker.registerGateway(gateway);
      const address = gateway.address();
      if (!address || typeof address === "string") throw new Error("PREVIEW_GATEWAY_FAILED");
      const finalImage = image;
      const finalGateway = gateway;
      const expiry = setTimeout(() => {
        finalGateway.closeAllConnections(); finalGateway.close(); this.docker.unregisterGateway(finalGateway);
        void this.docker.removeContainer(name).then(() => this.docker.removeImage(finalImage)).catch(() => undefined);
      // Startup has its own bounded deadline; grant the session its bounded
      // lifetime only after the accepted application and HTTPS gateway are ready.
      }, sessionBudgetMs);
      expiry.unref();
      gateway.once("close", () => clearTimeout(expiry));
      keep = true;
      return { projectId: request.projectId, versionId: request.versionId, candidateId: request.candidateId,
        snapshotDigest: request.snapshotDigest, policyDigest: request.policyDigest,
        sessionId: name, imageDigest: image.id, previewUrl: `https://localhost:${address.port}/session/${token}` };
    } finally {
      if (!keep) {
        gateway?.closeAllConnections(); gateway?.close();
        if (container) await this.docker.removeContainer(container);
        if (image) await this.docker.removeImage(image);
      }
    }
  }
}

export function dockerWorkflowFromEnvironment(environment: NodeJS.ProcessEnv = process.env): { options: SafeGenerationWorkflowOptions; dispose: () => Promise<void> } {
  if (environment.FORGEWEB_DOCKER_ENABLED !== "true") return { options: {}, dispose: async () => undefined };
  const docker = new DockerInfrastructure(environment.FORGEWEB_DOCKER_WORKER_IMAGE, dockerCommand(environment.FORGEWEB_DOCKER_EXECUTABLE));
  // The executor uses this policy budget as the aggregate check wall-clock
  // window; per-process CPU remains limited by the unchanged Docker ulimit.
  const executionBudgetMs = environment.FORGEWEB_DOCKER_VALIDATION_EXECUTION_MS === undefined
    ? 180_000 : Number(environment.FORGEWEB_DOCKER_VALIDATION_EXECUTION_MS);
  const policy = isolatedRunnerPolicy(600_000, executionBudgetMs);
  const options: SafeGenerationWorkflowOptions = {
    validationRunner: new CombinedValidationRunner(new ForgeWebIsolatedRunner(new DockerSandboxExecutor(docker), policy), new ForgeWebPostgresValidator(new DockerDisposablePostgresProvider(docker))),
    ...(environment.FORGEWEB_PREVIEW_TLS_CERT && environment.FORGEWEB_PREVIEW_TLS_KEY ? {
      runtimeExecutor: new DockerRuntimePreviewExecutor(docker, { certificatePath: environment.FORGEWEB_PREVIEW_TLS_CERT, keyPath: environment.FORGEWEB_PREVIEW_TLS_KEY }),
    } : {}),
  };
  return { options, dispose: () => docker.dispose() };
}
