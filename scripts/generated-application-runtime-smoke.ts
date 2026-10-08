import '../server/env.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { createForgeWebServer } from '../server/app.ts';
import { JsonStore } from '../server/store.ts';
import { BuildWorkflow } from '../server/workflow.ts';
import { candidateManifestDigest, fileManifestDigest } from '../server/generation/contract.ts';
import { candidateOutputDigest } from '../server/generation/candidate.ts';
import { SafeGenerationActivationService, safeGenerationConfigFromEnvironment } from '../server/generation/activation.ts';
import { dockerWorkflowFromEnvironment } from '../server/generation/docker-infrastructure.ts';
import type { RuntimePreviewExecution } from '../server/generation/runtime-preview.ts';

// Live diagnostic only: normal authenticated HTTP flow, no generator calls,
// no fabricated validation, and no generated source execution on the host.
type Expectations = {
  prompt: string; entity: string; table: string; path: string;
  fields: Record<string, string>; updated: Record<string, string>; persisted?: Record<string, string>;
  supported: string[]; unsupported: string[]; exclusions: string[];
};
const expected = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8')) as Expectations;
assert.ok(expected.prompt && /^[A-Za-z][A-Za-z0-9_]*$/.test(expected.entity));
assert.ok(/^[a-z][a-z0-9_]*$/.test(expected.table) && /^\/api\/v1\/[a-z][a-z0-9-]*$/.test(expected.path));
assert.ok(Object.entries(expected.fields).every(([field, column]) => /^[A-Za-z][A-Za-z0-9]*$/.test(field) && /^[a-z][a-z0-9_]*$/.test(column)));
assert.ok(Object.keys(expected.updated).every(field => Object.hasOwn(expected.fields, field)));
const PROMPT = expected.prompt;
const root = resolve('.forgeweb-data');
await mkdir(root, { recursive: true });
const primaryStore = join(root, 'forgeweb.json');
const originalStore = await readFile(primaryStore).catch(() => undefined);
const savedDirectory = process.argv[3] && process.argv[3] !== 'new' ? process.argv[3] : undefined;
const directory = savedDirectory ? resolve(savedDirectory) : await mkdtemp(join(root, 'generated-runtime-verification-'));
assert.ok(directory.startsWith(root + '\\generated-runtime-verification-') || directory.startsWith(root + '\\recipe-runtime-verification-'), 'VERIFICATION_STORE_REQUIRED');
const handoff = join(root, 'generated-runtime-handoff.json');
const store = new JsonStore(directory);
await store.initialize();
const config = safeGenerationConfigFromEnvironment();
assert.ok(config.enabled && config.token.length >= 32 && config.ownerId && config.subjectId, 'SAFE_CONFIGURATION_REQUIRED');
const infrastructure = dockerWorkflowFromEnvironment({ ...process.env, FORGEWEB_DOCKER_ENABLED: 'true' });
assert.ok(infrastructure.options.validationRunner && infrastructure.options.runtimeExecutor, 'DOCKER_AND_TLS_CONFIGURATION_REQUIRED');
let runtime: RuntimePreviewExecution | undefined;
const executor = infrastructure.options.runtimeExecutor;
const activation = new SafeGenerationActivationService(store, config, {
  ...infrastructure.options,
  runtimeExecutor: { async start(request) { runtime = await executor.start(request); return runtime; } },
});
const server = createForgeWebServer(new BuildWorkflow(store), activation);
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const execute = promisify(execFile);
let cookie = '';
let projectId = '';
let versionId = '';
const report: Record<string, unknown> = { prompt: PROMPT, store: directory };

async function api(path: string, payload?: unknown, authenticated = true) {
  const response = await fetch(origin + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated && cookie ? { cookie } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`CONTROL_API_${response.status}_${value.error?.code ?? 'FAILED'}`);
  return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function request(url: URL, method = 'GET', body?: unknown, headers: Record<string, string> = {}, servername?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((done, reject) => {
    const outgoing = https.request(url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(servername ? { servername } : {}), timeout: 8000 }, incoming => {
      let text = '';
      incoming.on('data', chunk => { text += chunk; });
      incoming.on('end', () => done({ status: incoming.statusCode!, headers: incoming.headers, text }));
    });
    outgoing.on('error', reject);
    outgoing.on('timeout', () => outgoing.destroy(new Error('HTTPS_REQUEST_TIMEOUT')));
    outgoing.end(body ? JSON.stringify(body) : undefined);
  });
}

async function inspectRuntime() {
  assert.ok(runtime);
  const { stdout } = await execute('docker', ['inspect', runtime.sessionId]);
  const container = JSON.parse(stdout)[0];
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.Config.User, '1000:1000');
  assert.equal(container.Mounts.length, 0);
  assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0);
  assert.ok(container.HostConfig.Memory > 0 && container.HostConfig.NanoCpus > 0 && container.HostConfig.PidsLimit > 0);
  const candidate = store.read().generationCandidates[runtime.candidateId].candidate;
  const paths = candidate.files.map(file => file.path);
  const check = `const fs=require('node:fs'),crypto=require('node:crypto');const paths=${JSON.stringify(paths)};console.log(JSON.stringify(paths.map(path=>[path,'sha256:'+crypto.createHash('sha256').update(fs.readFileSync('/workspace/'+path)).digest('hex')])));`;
  const copied = await execute('docker', ['exec', runtime.sessionId, 'node', '-e', check]);
  const actual = new Map<string, string>(JSON.parse(copied.stdout));
  assert.ok(candidate.files.every(file => actual.get(file.path) === file.digest));
  report.runtimeSnapshot = 'passed';
  report.dockerIsolation = 'passed';
}

async function publishHandoff() {
  assert.ok(runtime);
  assert.match(runtime.previewUrl, /^https:\/\/localhost:\d+\/session\/[a-f0-9]+$/);
  // Short-lived private browser handoff; never part of a generated snapshot.
  await writeFile(handoff, JSON.stringify({ previewUrl: runtime.previewUrl, directory }), { mode: 0o600 });
  console.log(JSON.stringify({ browserReady: true, projectId, versionId, urlShape: 'https://localhost:<port>/session/<redacted>' }));
}

async function probe() {
  assert.ok(runtime);
  report.probeStage = 'capability';
  const origin = new URL(runtime.previewUrl).origin;
  assert.equal((await request(new URL('/', origin))).status, 401);
  assert.equal((await request(new URL('/session/forged', origin))).status, 401);
  const exchange = await request(new URL(runtime.previewUrl));
  assert.equal(exchange.status, 200);
  assert.equal(exchange.headers.location, undefined);
  assert.match(exchange.text, /window\.location\.replace\("\/"\)/);
  assert.match(exchange.headers['content-security-policy'] ?? '', /script-src 'nonce-[a-f0-9]{32}'/);
  const setCookie = exchange.headers['set-cookie']![0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const sessionCookie = setCookie.split(';')[0];
  let wrongHostname = false;
  try { await request(new URL('/', origin), 'GET', undefined, { cookie: sessionCookie }, 'wrong-host.invalid'); }
  catch (error) { wrongHostname = (error as NodeJS.ErrnoException).code === 'ERR_TLS_CERT_ALTNAME_INVALID'; }
  assert.ok(wrongHostname, 'WRONG_HOSTNAME_MUST_BE_REJECTED');
  report.probeStage = 'health';
  const health = await request(new URL('/api/v1/health', origin), 'GET', undefined, { cookie: sessionCookie });
  assert.equal(JSON.parse(health.text).data.checks.database, 'up');
  assert.equal((await request(new URL(expected.path, origin), 'GET', undefined, { cookie: sessionCookie })).status, 401);
  report.probeStage = 'generated-authentication';
  const account = { name: 'HTTP Verification', email: `probe-${randomBytes(8).toString('hex')}@example.test`, password: randomBytes(24).toString('hex') };
  const register = await request(new URL('/api/v1/auth/register', origin), 'POST', account, { cookie: sessionCookie });
  assert.equal(register.status, 201);
  const bearer = JSON.parse(register.text).data.accessToken;
  assert.ok(typeof bearer === 'string' && bearer.length);
  const headers = { cookie: sessionCookie, authorization: `Bearer ${bearer}` };
  report.probeStage = 'entity-read';
  const list = await request(new URL(expected.path, origin), 'GET', undefined, headers);
  assert.equal(list.status, 200);
  const [selector, value] = Object.entries(expected.updated)[0];
  const record = JSON.parse(list.text).data.find((item: Record<string, unknown>) => item[selector] === value);
  assert.ok(record, 'BROWSER_CREATED_AND_UPDATED_RECORD_REQUIRED');
  for (const [field, value] of Object.entries(expected.updated)) assert.equal(record[field], value);
  const get = await request(new URL(`${expected.path}/${record.id}`, origin), 'GET', undefined, headers);
  assert.equal(get.status, 200);
  for (const [field, value] of Object.entries(expected.updated)) assert.equal(JSON.parse(get.text).data[field], value);
  assert.equal((await request(new URL(`${expected.path}/${record.id}`, origin), 'DELETE', undefined, headers)).status, 404);
  // Query PostgreSQL inside the existing isolated container. Password material
  // stays inside the container and only non-sensitive test values leave it.
  report.probeStage = 'postgresql-persistence';
  const columns = Object.entries(expected.fields).map(([field, column]) => `${column} AS "${field}"`).join(', ');
  const sql = `SELECT row_to_json(r) FROM (SELECT ${columns} FROM ${expected.table} WHERE ${expected.fields[selector]} = '${value.replace(/'/g, "''")}') r;`;
  const query = `const fs=require('node:fs'),cp=require('node:child_process');const version=fs.readdirSync('/usr/lib/postgresql').sort().at(-1);const result=cp.spawnSync('/usr/lib/postgresql/'+version+'/bin/psql',['-h','127.0.0.1','-U','forgeweb','-d','forgeweb','-At','-c',${JSON.stringify(sql)}],{env:{...process.env,PGPASSWORD:fs.readFileSync('/tmp/pg-password','utf8')},encoding:'utf8'});if(result.status)process.exit(1);console.log(result.stdout.trim());`;
  const persisted = await execute('docker', ['exec', runtime.sessionId, 'node', '-e', query]);
  const row = JSON.parse(persisted.stdout);
  for (const [field, value] of Object.entries(expected.persisted ?? expected.updated)) assert.equal(row[field], value);
  Object.assign(report, { tls: 'passed', wrongHostname: 'rejected', capabilities: 'passed', authentication: 'passed', health: 'passed', create: 'passed', read: 'passed', update: 'passed', deleteAbsent: 'passed', postgresqlPersistence: 'passed' });
  console.log(JSON.stringify({ applicationProbe: 'passed', browserRecordPersisted: true, tls: 'passed', capabilitySecurity: 'passed' }));
}

const input = createInterface({ input: process.stdin });
try {
  cookie = (await api('/api/safe/session', { token: config.token }, false)).cookie!;
  assert.ok(cookie);
  let candidateId: string;
  if (savedDirectory) {
    const saved = Object.values(store.read().generationCandidates);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, 'accepted');
    candidateId = saved[0].id;
    projectId = saved[0].projectId;
    versionId = saved[0].acceptedVersionId!;
  } else {
    const created = await api('/api/safe/builds', { prompt: PROMPT });
    assert.equal(created.value.build.status, 'awaiting_confirmation');
    projectId = created.value.build.projectId;
    console.log(JSON.stringify({ planning: 'passed', approvalRequired: true, projectId, buildId: created.value.build.id }));
    const confirmed = await api(`/api/safe/builds/${created.value.build.id}/confirm`, {});
    if (confirmed.value.generation.status !== 'accepted') {
      report.generation = confirmed.value.generation;
      report.validationChecks = Object.values(store.read().generationCandidates).map(record => record.validation?.checks);
    }
    assert.equal(confirmed.value.generation.status, 'accepted');
    assert.equal(confirmed.value.generation.validation, 'passed');
    candidateId = confirmed.value.generation.candidateId;
  }
  const database = store.read();
  const record = database.generationCandidates[candidateId];
  versionId = record.acceptedVersionId!;
  const version = database.versions[versionId];
  const files = database.versionFiles[versionId];
  assert.equal(record.status, 'accepted');
  assert.equal(record.candidateDigest, candidateOutputDigest(record.candidate));
  assert.equal(database.projects[projectId].currentVersionId, versionId);
  assert.equal(version.candidateId, record.id);
  assert.equal(version.candidateDigest, record.candidateDigest);
  assert.equal(candidateManifestDigest(record.candidate), record.manifestDigest);
  assert.equal(version.candidateManifestDigest, record.manifestDigest);
  assert.equal(fileManifestDigest(files), fileManifestDigest(record.candidate.files));
  assert.deepEqual(files.map(({ path, content, digest }) => ({ path, content, digest })), record.candidate.files.map(({ path, content, digest }) => ({ path, content, digest })));
  assert.equal(record.ownerId, config.ownerId);
  assert.equal(record.subjectId, config.subjectId);
  assert.equal(version.editPrompt, PROMPT);
  const requirements = JSON.parse(record.candidate.artifacts.find(artifact => artifact.kind === 'requirements')!.content);
  const entity = requirements.semantics.design.entities.find((entity: { name: string }) => entity.name === expected.entity);
  assert.ok(entity, 'EXPECTED_SEMANTIC_ENTITY_REQUIRED');
  assert.deepEqual(entity.fields.map((field: { name: string }) => field.name).sort(), Object.keys(expected.fields).sort());
  const routes = record.candidate.assembly.capabilities.backendRoutes.filter(route => route.entity === expected.entity);
  const actions = new Set(routes.filter(route => route.status === 'implemented').map(route => route.method === 'GET' ? 'read' : route.method === 'POST' ? 'create' : route.method === 'DELETE' ? 'delete' : 'update'));
  assert.deepEqual([...actions].sort(), [...expected.supported].sort());
  for (const name of expected.unsupported) {
    assert.ok(entity.operations.some((operation: { name: string; support: string }) => operation.name === name && operation.support === 'unsupported'));
    assert.ok(!routes.some(route => route.status === 'implemented' && route.path.split('/').includes(name)));
  }
  for (const exclusion of expected.exclusions) assert.ok(record.candidate.files.every(file => !file.path.toLowerCase().includes(exclusion.toLowerCase())));
  const reopened = new JsonStore(directory);
  await reopened.initialize();
  assert.deepEqual(reopened.read().versions[versionId], version);
  Object.assign(report, { projectId, buildId: record.buildId, candidateId: record.id, candidateDigest: record.candidateDigest, manifestDigest: record.manifestDigest, fileCount: files.length, validation: record.validation?.status, acceptance: record.status, versionId, versionNumber: version.versionNumber, cas: 'passed', snapshotIntegrity: 'passed', ownership: 'passed', semanticCoverage: 'passed', supported: expected.supported, unsupported: expected.unsupported, exclusions: 'passed', backendFiles: files.filter(file => file.path.startsWith('backend/')).length, frontendFiles: files.filter(file => file.path.startsWith('frontend/')).length, validationChecks: record.validation?.checks.map(check => ({ id: check.id, status: check.status })) });
  console.log(JSON.stringify(report));
  if (savedDirectory) {
    const activated = await api(`/api/safe/projects/${projectId}/versions/${versionId}/preview`, {});
    assert.equal(activated.value.preview.status, 'ready');
  }
  assert.ok(runtime, 'TRUSTED_RUNTIME_REQUIRED');
  await inspectRuntime();
  const browserStartedAt = Date.now();
  await publishHandoff();
  if (process.argv[4] === 'browser-auto') {
    // The browser controller writes this screenshot only after the actual UI
    // CREATE/READ/UPDATE flow. Probe immediately, without another manual delay.
    const proof = join(directory, 'browser-proof.png');
    while ((await stat(proof).catch(() => ({ mtimeMs: 0 }))).mtimeMs <= browserStartedAt) {
      if (Date.now() - browserStartedAt > 60_000) throw new Error('BROWSER_VERIFICATION_TIMEOUT');
      await new Promise(done => setTimeout(done, 250));
    }
    await probe();
  } else for await (const command of input) {
    if (command === 'preview') {
      const activated = await api(`/api/safe/projects/${projectId}/versions/${versionId}/preview`, {});
      assert.equal(activated.value.preview.status, 'ready');
      await inspectRuntime();
      await publishHandoff();
    } else if (command === 'probe') await probe();
    else if (command === 'finish') break;
  }
} catch (error) {
  report.failure = error instanceof assert.AssertionError ? `ASSERTION_${error.message.split('\n')[0]}`
    : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LIVE_VERIFICATION_FAILED';
  const code = (error as NodeJS.ErrnoException).code;
  console.log(JSON.stringify({ failure: report.failure, stage: report.probeStage, code: typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : undefined, errorType: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
} finally {
  input.close();
  await infrastructure.dispose();
  await new Promise<void>(done => { server.close(done); server.closeAllConnections(); });
  await rm(handoff, { force: true });
  assert.deepEqual(await readFile(primaryStore).catch(() => undefined), originalStore);
  await writeFile(join(directory, 'verification-report.json'), JSON.stringify({ ...report, cleanup: 'passed', mainStoreUnchanged: true }, null, 2));
  console.log(JSON.stringify({ cleanup: 'passed', mainStoreUnchanged: true, acceptedSnapshotPreserved: Boolean(versionId), store: directory }));
}
