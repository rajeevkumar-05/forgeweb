import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { URL } from "node:url";
import { ApiError } from "./lib.ts";
import { BuildWorkflow } from "./workflow.ts";
import { getLlmStatus } from "./llm/index.ts";
import { SafeGenerationActivationService } from "./generation/activation.ts";
import { ForgeWebAuthentication } from "./auth.ts";
import { OwnedProjects } from "./projects.ts";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...jsonHeaders, ...headers });
  response.end(JSON.stringify(body));
}

function sendPreview(response: ServerResponse, html: string, versionId: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    "x-content-type-options": "nosniff",
    "x-forgeweb-version": versionId,
  });
  response.end(html);
}

function sendArchive(response: ServerResponse, archive: Buffer, filename: string): void {
  response.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${filename}"`,
    "content-length": archive.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(archive);
}

function streamBuildEvents(request: IncomingMessage, response: ServerResponse, workflow: BuildWorkflow, buildId: string): void {
  workflow.get(buildId);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  let sent = 0;
  let timer: NodeJS.Timeout | undefined;
  const publish = () => {
    const build = workflow.get(buildId);
    for (const event of build.events.slice(sent)) {
      response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    sent = build.events.length;
    if (["awaiting_confirmation", "completed", "failed", "needs_context"].includes(build.status)) {
      if (timer) clearInterval(timer);
      response.end();
    }
  };
  publish();
  if (!response.writableEnded) timer = setInterval(publish, 150);
  request.on("close", () => {
    if (timer) clearInterval(timer);
  });
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new ApiError(413, "BODY_TOO_LARGE", "Request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

export type ForgeWebRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export function createForgeWebRequestHandler(workflow: BuildWorkflow, safeGeneration?: SafeGenerationActivationService): ForgeWebRequestHandler {
  const authentication = new ForgeWebAuthentication(workflow.store);
  const projects = new OwnedProjects(workflow, safeGeneration);
  return async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    try {
      authentication.checkRequest(request);
      if (method === "GET" && requestUrl.pathname === "/api/auth/session") {
        const user = authentication.optionalUser(request);
        send(response, 200, { user: user ?? null, migration: user ? projects.eligible(user) : { standard: 0, verified: 0 } });
        return;
      }
      if (method === "POST" && ["/api/auth/login", "/api/auth/register"].includes(requestUrl.pathname)) {
        authentication.limit(request);
        const payload = await body(request) as { username?: unknown; password?: unknown };
        const result = await authentication.login(payload.username, payload.password, requestUrl.pathname.endsWith("register"), request);
        safeGeneration?.logout(request);
        send(response, 200, { user: result.user }, { "set-cookie": result.cookie });
        return;
      }
      if (method === "POST" && requestUrl.pathname === "/api/auth/logout") {
        safeGeneration?.logout(request);
        send(response, 200, { user: null }, { "set-cookie": await authentication.logout(request) });
        return;
      }
      if (method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/api")) {
        send(response, 200, {
          service: "forgeweb-control-plane",
          message: "API is running. Open the frontend at http://127.0.0.1:5175/.",
          endpoints: ["/api/health", "/api/llm/status", "/api/projects", "/api/builds"],
        });
        return;
      }
      if (method === "GET" && requestUrl.pathname === "/api/health") {
        send(response, 200, { status: "ok", service: "forgeweb-control-plane", time: new Date().toISOString() });
        return;
      }
      if (method === "GET" && requestUrl.pathname === "/api/llm/status") {
        const status = await getLlmStatus();
        send(response, 200, { llm: status });
        return;
      }
      if (method === "GET" && requestUrl.pathname === "/api/safe/status") {
        send(response, 200, safeGeneration?.status(request, authentication.optionalUser(request)?.id) ?? {
          enabled: false,
          authenticated: false,
          target: "forgeweb-postgresql-v1",
          isolatedValidation: "unavailable",
          disposablePostgresql: "unavailable",
          trustedRuntime: "unavailable",
        });
        return;
      }
      const user = authentication.requireUser(request);
      if (method === "POST" && requestUrl.pathname === "/api/projects/claim") {
        const payload = await body(request) as { confirmed?: unknown; includeVerified?: unknown };
        const result = await projects.claim(user, payload.confirmed, payload.includeVerified === true && Boolean(safeGeneration));
        send(response, 200, result);
        return;
      }
      const ownedProjectMatch = requestUrl.pathname.match(/^\/api\/(?:safe\/)?projects\/([^/]+)/);
      if (ownedProjectMatch) projects.requireOwner(decodeURIComponent(ownedProjectMatch[1]), user);
      const ownedBuildMatch = requestUrl.pathname.match(/^\/api\/(?:safe\/)?builds\/([^/]+)/);
      if (ownedBuildMatch) projects.requireOwner(workflow.get(decodeURIComponent(ownedBuildMatch[1])).projectId, user);
      if (method === "POST" && requestUrl.pathname === "/api/safe/session") {
        if (!safeGeneration) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
        const payload = await body(request) as { token?: unknown };
        const session = safeGeneration.authenticate(payload.token, user.id);
        send(response, 200, { authenticated: true }, { "set-cookie": session.cookie });
        return;
      }
      if (method === "POST" && requestUrl.pathname === "/api/safe/builds") {
        if (!safeGeneration) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
        const actor = safeGeneration.requireActor(request, user.id);
        const payload = await body(request) as { prompt?: unknown };
        const build = await safeGeneration.create(payload.prompt, actor);
        send(response, 202, { build });
        return;
      }
      const safeConfirmationMatch = requestUrl.pathname.match(/^\/api\/safe\/builds\/([^/]+)\/confirm$/);
      if (method === "POST" && safeConfirmationMatch) {
        if (!safeGeneration) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
        const actor = safeGeneration.requireActor(request, user.id);
        const buildId = decodeURIComponent(safeConfirmationMatch[1]);
        const result = await projects.run(workflow.get(buildId).projectId, user, () => safeGeneration.confirm(buildId, safeGeneration.actorForBuild(buildId, actor)));
        send(response, 202, result);
        return;
      }
      const safePreviewMatch = requestUrl.pathname.match(/^\/api\/safe\/projects\/([^/]+)\/versions\/([^/]+)\/preview$/);
      if (method === "POST" && safePreviewMatch) {
        if (!safeGeneration) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
        const projectId = decodeURIComponent(safePreviewMatch[1]);
        const preview = await projects.run(projectId, user, () => safeGeneration.previewForOwner(projectId, decodeURIComponent(safePreviewMatch[2]), user.id));
        send(response, 200, { preview });
        return;
      }
      if (method === "GET" && requestUrl.pathname === "/api/projects") {
        send(response, 200, { projects: projects.list(user) });
        return;
      }
      if (method === "POST" && requestUrl.pathname === "/api/builds") {
        const payload = await body(request) as { prompt?: unknown };
        const build = await workflow.create(payload.prompt, user.id);
        send(response, 202, { build });
        return;
      }
      const buildEventsMatch = requestUrl.pathname.match(/^\/api\/builds\/([^/]+)\/events$/);
      if (method === "GET" && buildEventsMatch) {
        const buildId = decodeURIComponent(buildEventsMatch[1]);
        const build = workflow.get(buildId);
        streamBuildEvents(request, response, workflow, buildId);
        return;
      }
      const buildConfirmationMatch = requestUrl.pathname.match(/^\/api\/builds\/([^/]+)\/confirm$/);
      if (method === "POST" && buildConfirmationMatch) {
        const buildId = decodeURIComponent(buildConfirmationMatch[1]);
        const current = workflow.get(buildId);
        const build = await projects.run(current.projectId, user, () => workflow.confirm(buildId));
        send(response, 202, { build });
        return;
      }
      const buildReviseMatch = requestUrl.pathname.match(/^\/api\/builds\/([^/]+)\/revise$/);
      if (method === "POST" && buildReviseMatch) {
        const payload = await body(request) as { prompt?: unknown };
        const buildId = decodeURIComponent(buildReviseMatch[1]);
        const current = workflow.get(buildId);
        const build = await projects.run(current.projectId, user, () => workflow.revise(buildId, payload.prompt));
        send(response, 202, { build });
        return;
      }
      const workspaceMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/workspace$/);
      if (method === "GET" && workspaceMatch) {
        const projectId = decodeURIComponent(workspaceMatch[1]);
        send(response, 200, { workspace: await projects.run(projectId, user, () => workflow.workspace.getReady(projectId)) });
        return;
      }
      const previewMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/preview$/);
      if (method === "GET" && previewMatch) {
        const projectId = decodeURIComponent(previewMatch[1]);
        const project = workflow.getProject(projectId).project;
        if (project.currentBuildId && safeGeneration?.isSafeBuild(workflow.get(project.currentBuildId))) {
          throw new ApiError(409, "TRUSTED_RUNTIME_PREVIEW_REQUIRED", "Verified generated applications can only be previewed through the trusted runtime boundary.");
        }
        const preview = await projects.run(projectId, user, () => workflow.workspace.getPreview(projectId));
        sendPreview(response, preview.html, preview.versionId);
        return;
      }
      const editMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/edits$/);
      if (method === "POST" && editMatch) {
        const payload = await body(request) as { prompt?: unknown };
        const projectId = decodeURIComponent(editMatch[1]);
        const result = await projects.run(projectId, user, () => workflow.workspace.edit(projectId, payload.prompt));
        send(response, 201, result);
        return;
      }
      const restoreMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/versions\/([^/]+)\/restore$/);
      if (method === "POST" && restoreMatch) {
        const projectId = decodeURIComponent(restoreMatch[1]);
        const workspace = await projects.run(projectId, user, () => workflow.workspace.restore(projectId, decodeURIComponent(restoreMatch[2])));
        send(response, 200, { workspace });
        return;
      }
      const exportValidationMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/export\/validate$/);
      if (method === "POST" && exportValidationMatch) {
        const projectId = decodeURIComponent(exportValidationMatch[1]);
        const summary = await projects.run(projectId, user, () => workflow.workspace.validateExport(projectId));
        send(response, summary.validation === "passed" ? 200 : 422, { summary });
        return;
      }
      const exportMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
      if (method === "POST" && exportMatch) {
        const projectId = decodeURIComponent(exportMatch[1]);
        const result = await projects.run(projectId, user, () => workflow.workspace.export(projectId));
        sendArchive(response, result.archive, result.filename);
        return;
      }
      const buildMatch = requestUrl.pathname.match(/^\/api\/builds\/([^/]+)$/);
      if (method === "GET" && buildMatch) {
        const build = workflow.get(decodeURIComponent(buildMatch[1]));
        send(response, 200, { build });
        return;
      }
      const projectMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (method === "DELETE" && projectMatch) {
        const payload = await body(request) as { confirmed?: unknown };
        await projects.delete(decodeURIComponent(projectMatch[1]), user, payload.confirmed);
        send(response, 200, { deleted: true });
        return;
      }
      if (method === "GET" && projectMatch) {
        const result = workflow.getProject(decodeURIComponent(projectMatch[1]));
        send(response, 200, result);
        return;
      }
      send(response, 404, { error: { code: "NOT_FOUND", message: "API route was not found." } });
    } catch (error) {
      if (error instanceof ApiError) {
        send(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      console.error(error);
      send(response, 500, { error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } });
    }
  };
}

export function createForgeWebServer(workflow: BuildWorkflow, safeGeneration?: SafeGenerationActivationService): Server {
  const handler = createForgeWebRequestHandler(workflow, safeGeneration);
  return createServer((request, response) => {
    void handler(request, response);
  });
}
