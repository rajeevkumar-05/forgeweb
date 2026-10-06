import { resolve } from "node:path";
import "./env.ts";
import { createForgeWebServer } from "./app.ts";
import { JsonStore } from "./store.ts";
import { BuildWorkflow } from "./workflow.ts";
import { SafeGenerationActivationService, safeGenerationConfigFromEnvironment } from "./generation/activation.ts";

const port = Number.parseInt(process.env.FORGEWEB_API_PORT ?? "8787", 10);
const dataDirectory = resolve(process.env.FORGEWEB_DATA_DIR ?? ".forgeweb-data");
const store = new JsonStore(dataDirectory);
await store.initialize();
const workflow = new BuildWorkflow(store);
const safeGeneration = new SafeGenerationActivationService(store, safeGenerationConfigFromEnvironment());
const server = createForgeWebServer(workflow, safeGeneration);

server.listen(port, "127.0.0.1", () => {
  console.log(`ForgeWeb control plane listening on http://127.0.0.1:${port}`);
  console.log(`Persistent data: ${dataDirectory}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
