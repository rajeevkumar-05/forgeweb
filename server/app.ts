import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { URL } from "node:url";
import { ApiError } from "./lib.ts";
import { BuildWorkflow } from "./workflow.ts";
import { getLlmStatus } from "./llm/index.ts";
import { SafeGenerationActivationService } from "./generation/activation.ts";

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
  return async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    try {
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
        send(response, 200, safeGeneration?.status(request) ?? {
          enabled: false,
          authenticated: false,
          target: "forgeweb-postgresql-v1",
          isolatedValidation: "unavailable",
          disposablePostgresql: "unavailable",
          trustedRuntime: "unavailable",
        });
        return;
      }
      if (method === "POST" && requestUrl.pathname === "/api/safe/session") {
        if (!safeGeneration) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
        const payload = await body(request) as { token?: unknown };
        const session = safeGeneration.authenticate(payload.token);
        send(response, 200, { authenticated: true }, { "set-cookie": session.cookie });
        return;
      }
      if (method === "POST" && requestUrl.pathname === "/api/safe/builds") {
        if (!safeGeneration) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
        const actor = safeGeneration.requireActor(request);
        const payload = await body(request) as { prompt?: unknown };
        const build = await safeGeneration.create(payload.prompt, actor);
        send(response, 202, { build });
        return;
      }
      const safeConfirmationMatch = requestUrl.pathname.match(/^\/api\/safe\/builds\/([^/]+)\/confirm$/);
      if (method === "POST" && safeConfirmationMatch) {
        if (!safeGeneration) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
        const actor = safeGeneration.requireActor(request);
        const result = await safeGeneration.confirm(decodeURIComponent(safeConfirmationMatch[1]), actor);
        send(response, 202, result);
        return;
      }
      const safePreviewMatch = requestUrl.pathname.match(/^\/api\/safe\/projects\/([^/]+)\/versions\/([^/]+)\/preview$/);
      if (method === "POST" && safePreviewMatch) {
        if (!safeGeneration) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
        const actor = safeGeneration.requireActor(request);
        const preview = await safeGeneration.previewAccepted(decodeURIComponent(safePreviewMatch[1]), decodeURIComponent(safePreviewMatch[2]), actor);
        send(response, 200, { preview });
        return;
      }
      if (method === "GET" && requestUrl.pathname === "/api/projects") {
        const projects = workflow.listProjects();
        send(response, 200, { projects: safeGeneration?.visibleProjects(request, projects) ?? projects });
        return;
      }
      if (method === "POST" && requestUrl.pathname === "/api/builds") {
        const payload = await body(request) as { prompt?: unknown };
        const build = await workflow.create(payload.prompt);
        send(response, 202, { build });
        return;
      }
      const buildEventsMatch = requestUrl.pathname.match(/^\/api\/builds\/([^/]+)\/events$/);
      if (method === "GET" && buildEventsMatch) {
        const buildId = decodeURIComponent(buildEventsMatch[1]);
        const build = workflow.get(buildId);
        safeGeneration?.requireBuildAccess(request, build);
        streamBuildEvents(request, response, workflow, buildId);
        return;
      }
      const buildConfirmationMatch = requestUrl.pathname.match(/^\/api\/builds\/([^/]+)\/confirm$/);
      if (method === "POST" && buildConfirmationMatch) {
        const buildId = decodeURIComponent(buildConfirmationMatch[1]);
        const current = workflow.get(buildId);
        safeGeneration?.requireBuildAccess(request, current);
        const build = await workflow.confirm(buildId);
        send(response, 202, { build });
        return;
      }
      const buildReviseMatch = requestUrl.pathname.match(/^\/api\/builds\/([^/]+)\/revise$/);
      if (method === "POST" && buildReviseMatch) {
        const payload = await body(request) as { prompt?: unknown };
        const buildId = decodeURIComponent(buildReviseMatch[1]);
        const current = workflow.get(buildId);
        safeGeneration?.requireBuildAccess(request, current);
        const build = await workflow.revise(buildId, payload.prompt);
        send(response, 202, { build });
        return;
      }
      const workspaceMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/workspace$/);
      if (method === "GET" && workspaceMatch) {
        const projectId = decodeURIComponent(workspaceMatch[1]);
        safeGeneration?.requireProjectAccess(request, workflow.getProject(projectId).project);
        send(response, 200, { workspace: await workflow.workspace.getReady(projectId) });
        return;
      }
      const previewMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/preview$/);
      if (method === "GET" && previewMatch) {
        const projectId = decodeURIComponent(previewMatch[1]);
        const project = workflow.getProject(projectId).project;
        safeGeneration?.requireProjectAccess(request, project);
        if (project.currentBuildId && safeGeneration?.isSafeBuild(workflow.get(project.currentBuildId))) {
          throw new ApiError(409, "TRUSTED_RUNTIME_PREVIEW_REQUIRED", "Verified generated applications can only be previewed through the trusted runtime boundary.");
        }
        const preview = await workflow.workspace.getPreview(projectId);
        sendPreview(response, preview.html, preview.versionId);
        return;
      }
      const editMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/edits$/);
      if (method === "POST" && editMatch) {
        const payload = await body(request) as { prompt?: unknown };
        const projectId = decodeURIComponent(editMatch[1]);
        safeGeneration?.requireProjectAccess(request, workflow.getProject(projectId).project);
        const result = await workflow.workspace.edit(projectId, payload.prompt);
        send(response, 201, result);
        return;
      }
      const restoreMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/versions\/([^/]+)\/restore$/);
      if (method === "POST" && restoreMatch) {
        const projectId = decodeURIComponent(restoreMatch[1]);
        safeGeneration?.requireProjectAccess(request, workflow.getProject(projectId).project);
        const workspace = await workflow.workspace.restore(projectId, decodeURIComponent(restoreMatch[2]));
        send(response, 200, { workspace });
        return;
      }
      const exportValidationMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/export\/validate$/);
      if (method === "POST" && exportValidationMatch) {
        const projectId = decodeURIComponent(exportValidationMatch[1]);
        safeGeneration?.requireProjectAccess(request, workflow.getProject(projectId).project);
        const summary = await workflow.workspace.validateExport(projectId);
        send(response, summary.validation === "passed" ? 200 : 422, { summary });
        return;
      }
      const exportMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
      if (method === "POST" && exportMatch) {
        const projectId = decodeURIComponent(exportMatch[1]);
        safeGeneration?.requireProjectAccess(request, workflow.getProject(projectId).project);
        const result = await workflow.workspace.export(projectId);
        sendArchive(response, result.archive, result.filename);
        return;
      }
      const buildMatch = requestUrl.pathname.match(/^\/api\/builds\/([^/]+)$/);
      if (method === "GET" && buildMatch) {
        const build = workflow.get(decodeURIComponent(buildMatch[1]));
        safeGeneration?.requireBuildAccess(request, build);
        send(response, 200, { build });
        return;
      }
      const projectMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (method === "GET" && projectMatch) {
        const result = workflow.getProject(decodeURIComponent(projectMatch[1]));
        safeGeneration?.requireProjectAccess(request, result.project);
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
