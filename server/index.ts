import { resolve } from "node:path";
import "./env.ts";
import { createForgeWebServer } from "./app.ts";
import { JsonStore } from "./store.ts";
import { BuildWorkflow } from "./workflow.ts";
import { SafeGenerationActivationService, safeGenerationConfigFromEnvironment } from "./generation/activation.ts";
import { dockerWorkflowFromEnvironment } from "./generation/docker-infrastructure.ts";

const port = Number.parseInt(process.env.FORGEWEB_API_PORT ?? "8787", 10);
const dataDirectory = resolve(process.env.FORGEWEB_DATA_DIR ?? ".forgeweb-data");
const store = new JsonStore(dataDirectory);
await store.initialize();
const workflow = new BuildWorkflow(store);
const infrastructure = dockerWorkflowFromEnvironment();
const safeGeneration = new SafeGenerationActivationService(store, safeGenerationConfigFromEnvironment(), infrastructure.options);
const server = createForgeWebServer(workflow, safeGeneration);

server.listen(port, "127.0.0.1", () => {
  console.log(`ForgeWeb control plane listening on http://127.0.0.1:${port}`);
  console.log(`Persistent data: ${dataDirectory}`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void infrastructure.dispose().then(
    () => server.close(() => process.exit(0)),
    () => {
      console.error("Disposable Docker cleanup was incomplete; inspect forgeweb.disposable resources.");
      server.close(() => process.exit(1));
    },
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
