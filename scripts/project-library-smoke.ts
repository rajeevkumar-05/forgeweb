import "../server/env.ts";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "vite";

// Real UI/API/Docker regression against a disposable copy, never the user's store.
const primary = resolve(".forgeweb-data/forgeweb.json");
const original = await readFile(primary);
const directory = await mkdtemp(join(tmpdir(), "forgeweb-library-ui-"));
await copyFile(primary, join(directory, "forgeweb.json"));
process.env.FORGEWEB_DATA_DIR = directory;
// A diagnostic-only token for this disposable API, not the operator's token.
process.env.FORGEWEB_SAFE_GENERATION_TOKEN = "test-only-sidebar-activation-token-00000000000000";
const server = await createServer({ server: { host: "127.0.0.1", port: 5188, strictPort: true } });
const input = createInterface({ input: process.stdin });
try {
  await server.listen();
  console.log("Project library smoke UI: http://127.0.0.1:5188/");
  for await (const line of input) if (line === "finish") break;
} finally {
  input.close();
  await server.close();
  assert.deepEqual(await readFile(primary), original, "Primary project store must remain unchanged");
  await rm(directory, { recursive: true, force: true });
  console.log("Disposable UI store and infrastructure cleaned; primary store unchanged.");
}
