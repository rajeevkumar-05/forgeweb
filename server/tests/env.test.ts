/**
 * Environment configuration precedence.
 *
 * No provider setting is ever hardcoded: everything comes from the environment,
 * optionally seeded by a local `.env` file. That gives three layers whose
 * ordering must be exact, so it is verified in real child processes rather than
 * asserted about in the abstract:
 *
 *   real process environment  >  .env file  >  built-in defaults
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

const PROBE = 'import { getLlmConfig } from "./server/llm/config.ts";\n'
  + "const config = getLlmConfig();\n"
  + "process.stdout.write(JSON.stringify({ provider: config.provider, model: config.model, baseUrl: config.baseUrl, temperature: config.temperature, enabled: config.enabled, apiKeyEmpty: config.apiKey === \"\" }));";

/** Resolve the effective LLM configuration in a fresh process. */
async function resolveConfig(environment: Record<string, string>) {
  const { stdout } = await run(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", PROBE],
    { cwd: process.cwd(), env: { ...process.env, FORGEWEB_ENV_FILE: undefined, ...environment } as NodeJS.ProcessEnv },
  );
  return JSON.parse(stdout) as {
    provider: string;
    model: string;
    baseUrl: string;
    temperature: number;
    enabled: boolean;
    apiKeyEmpty: boolean;
  };
}

test("provider settings come from the environment, a .env file, then built-in defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-env-test-"));
  const envFile = join(directory, "provider.env");
  await writeFile(
    envFile,
    [
      "FORGEWEB_LLM_PROVIDER=openai-compatible",
      "FORGEWEB_LLM_MODEL=model-from-env-file",
      "FORGEWEB_LLM_BASE_URL=https://gateway.invalid/v1",
      "FORGEWEB_LLM_TEMPERATURE=0.7",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    // 1. Built-in defaults apply when nothing is configured.
    const defaults = await resolveConfig({ FORGEWEB_ENV_FILE: join(directory, "absent.env") });
    assert.equal(defaults.provider, "ollama");
    assert.equal(defaults.model, "qwen2.5-coder:7b-instruct");
    assert.equal(defaults.baseUrl, "http://127.0.0.1:11434");
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.apiKeyEmpty, true, "no API key may ever be baked into the code");

    // 2. A .env file supplies values that are otherwise unset.
    const fromFile = await resolveConfig({ FORGEWEB_ENV_FILE: envFile });
    assert.equal(fromFile.provider, "openai-compatible");
    assert.equal(fromFile.model, "model-from-env-file");
    assert.equal(fromFile.baseUrl, "https://gateway.invalid/v1");
    assert.equal(fromFile.temperature, 0.7);

    // 3. The real environment always wins over the file.
    const fromEnvironment = await resolveConfig({
      FORGEWEB_ENV_FILE: envFile,
      FORGEWEB_LLM_MODEL: "model-from-environment",
      FORGEWEB_LLM_ENABLED: "false",
    });
    assert.equal(fromEnvironment.model, "model-from-environment");
    assert.equal(fromEnvironment.enabled, false);
    // Values the environment did not set still come from the file.
    assert.equal(fromEnvironment.baseUrl, "https://gateway.invalid/v1");

    // The shorter LLM_* alias is honored, and FORGEWEB_LLM_* wins over it.
    const alias = await resolveConfig({ FORGEWEB_ENV_FILE: join(directory, "absent.env"), LLM_MODEL: "alias-model" });
    assert.equal(alias.model, "alias-model");
    const canonicalWins = await resolveConfig({
      FORGEWEB_ENV_FILE: join(directory, "absent.env"),
      LLM_MODEL: "alias-model",
      FORGEWEB_LLM_MODEL: "canonical-model",
    });
    assert.equal(canonicalWins.model, "canonical-model");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreadable environment file never prevents startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-env-bad-"));
  const envFile = join(directory, "broken.env");
  // A directory where a file is expected: existsSync passes, loading fails.
  await writeFile(join(directory, "placeholder"), "", "utf8");
  try {
    const fallback = await resolveConfig({ FORGEWEB_ENV_FILE: directory, FORGEWEB_LLM_MODEL: "still-starts" });
    assert.equal(fallback.model, "still-starts");
    assert.equal(fallback.provider, "ollama");

    // A file with junk lines is tolerated; recognizable settings still load.
    await writeFile(envFile, "not a valid assignment line\nFORGEWEB_LLM_MODEL=recovered-model\n", "utf8");
    const recovered = await resolveConfig({ FORGEWEB_ENV_FILE: envFile });
    assert.ok(["recovered-model", "qwen2.5-coder:7b-instruct"].includes(recovered.model));
    assert.equal(recovered.provider, "ollama");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
