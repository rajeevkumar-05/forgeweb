import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createForgeWebRequestHandler, type ForgeWebRequestHandler } from "./server/app.ts";
import { JsonStore } from "./server/store.ts";
import { BuildWorkflow } from "./server/workflow.ts";
import { resetLlmConfig, resetLlmProvider } from "./server/llm/index.ts";
import { SafeGenerationActivationService, safeGenerationConfigFromEnvironment } from "./server/generation/activation.ts";
import { dockerWorkflowFromEnvironment } from "./server/generation/docker-infrastructure.ts";

function forgeWebDevApi(): Plugin {
  let handler: Promise<ForgeWebRequestHandler> | undefined;
  return {
    name: "forgeweb-dev-api",
    configureServer(server) {
      // Reset LLM singletons so .env changes are picked up on Vite restart.
      resetLlmConfig();
      resetLlmProvider();
      const infrastructure = dockerWorkflowFromEnvironment();
      server.httpServer?.once("close", () => {
        void infrastructure.dispose().catch(() => console.error("Disposable Docker cleanup was incomplete; inspect forgeweb.disposable resources."));
      });
      handler = (async () => {
        const store = new JsonStore(resolve(process.cwd(), ".forgeweb-data"));
        await store.initialize();
        return createForgeWebRequestHandler(
          new BuildWorkflow(store),
          new SafeGenerationActivationService(store, safeGenerationConfigFromEnvironment(), infrastructure.options),
        );
      })();
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api")) {
          next();
          return;
        }
        void handler!.then((api) => api(request, response)).catch(next);
      });
    },
  };
}

export default defineConfig({
  plugins: [forgeWebDevApi(), react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 550,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](react|react-dom)[\\/]/,
              priority: 3,
              includeDependenciesRecursively: false,
            },
            {
              name: "motion-vendor",
              test: /node_modules[\\/](animejs|gsap|motion)[\\/]/,
              priority: 2,
              includeDependenciesRecursively: false,
            },
            {
              name: "icons-vendor",
              test: /node_modules[\\/]lucide-react[\\/]/,
              priority: 1,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
});
