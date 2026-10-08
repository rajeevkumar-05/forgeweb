import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, symlink, writeFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import { resolve, sep } from 'node:path';

const root = '/tmp/project';
const backend = `${root}/backend`;
const frontend = `${root}/frontend`;
const prisma = '/opt/backend/node_modules/prisma/build/index.js';
const children = new Set();

async function measured(operation, task) {
  const started = Date.now();
  const report = (completed, classification) => console.log('FORGEWEB_EXECUTION_DIAGNOSTIC ' + JSON.stringify({
    operation, parent: process.argv[2], startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started, completed, timedOut: false, classification,
  }));
  // Child output stays private. Only this supervisor's fixed operation vocabulary leaves the sandbox.
  report(false, 'completed');
  try {
    const result = await task();
    report(true, 'completed');
    return result;
  } catch (error) {
    report(true, 'exit_nonzero');
    throw error;
  }
}

// Only trusted supervisor output leaves the container. Child logs can contain
// disposable credentials and must never be forwarded to the control plane.
function command(binary, args, cwd = backend, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 2_000_000) child.kill('SIGKILL');
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      children.delete(child);
      if (code !== 0) reject(new Error('Worker command failed'));
      else resolvePromise(output);
    });
    child.stdin.end(input);
  });
}

async function prepare() {
  await mkdir(root, { recursive: true });
  await cp('/workspace', root, { recursive: true, force: true });
  for (const part of ['backend', 'frontend']) {
    await mkdir(`${root}/${part}`, { recursive: true });
    try { await symlink(`/opt/${part}/node_modules`, `${root}/${part}/node_modules`); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

async function database() {
  const directory = '/tmp/pgdata';
  const password = randomBytes(32).toString('hex');
  const binaries = (await readdir('/usr/lib/postgresql')).sort().at(-1);
  const pg = `/usr/lib/postgresql/${binaries}/bin`;
  await measured('database-init', async () => {
    await writeFile('/tmp/pg-password', password, { mode: 0o600 });
    await command(`${pg}/initdb`, ['-D', directory, '-U', 'forgeweb', '--pwfile=/tmp/pg-password', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256']);
    await command(`${pg}/pg_ctl`, ['-D', directory, '-l', '/tmp/pg.log', '-o', '-h 127.0.0.1 -k /tmp -p 5432', '-w', 'start']);
    process.env.PGPASSWORD = password;
    await command(`${pg}/createdb`, ['-h', '127.0.0.1', '-U', 'forgeweb', 'forgeweb']);
  });
  process.env.DATABASE_URL = `postgresql://forgeweb:${password}@127.0.0.1:5432/forgeweb?schema=public`;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.PORT = '4000';
  await measured('database-schema', async () => {
  await command('node', [prisma, 'validate', '--schema', `${backend}/prisma/schema.prisma`]);
  const migrations = await readdir(`${backend}/prisma/migrations`).catch(() => []);
  if (migrations.some((name) => name !== 'migration_lock.toml')) {
    await command('node', [prisma, 'migrate', 'deploy', '--schema', `${backend}/prisma/schema.prisma`]);
  } else {
    // With no versioned migrations, validate an explicit schema bootstrap,
    // not a fictional successful migration history.
    const sql = await command('node', [prisma, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', `${backend}/prisma/schema.prisma`, '--script']);
    await command(`${pg}/psql`, ['-h', '127.0.0.1', '-U', 'forgeweb', '-d', 'forgeweb', '-v', 'ON_ERROR_STOP=1'], backend, sql);
  }
  await command('node', [prisma, 'migrate', 'diff', '--from-url', process.env.DATABASE_URL, '--to-schema-datamodel', `${backend}/prisma/schema.prisma`, '--exit-code']);
  });
}

async function build() {
  await measured('backend-build', () => command('node', ['/opt/backend/node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']));
  await measured('frontend-typecheck', () => command('node', ['/opt/frontend/node_modules/typescript/bin/tsc', '-b'], frontend));
  await measured('frontend-build', () => command('node', ['/opt/frontend/node_modules/vite/bin/vite.js', 'build', '--configLoader', 'runner'], frontend));
}

async function health() {
  const child = spawn('node', [`${backend}/dist/index.js`], { cwd: backend, env: process.env, stdio: 'ignore' });
  children.add(child);
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error('Backend startup failed');
    try {
      const response = await fetch('http://127.0.0.1:4000/api/v1/health', { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.ok && body.data?.checks?.database === 'up' && body.data?.status === 'ok') return;
    } catch { /* Startup is bounded by the supervisor and container deadline. */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('Backend health failed');
}

function serve() {
  const staticRoot = `${frontend}/dist`;
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
  http.createServer(async (request, response) => {
    try {
      if (request.url.startsWith('/api/')) {
        const proxy = http.request({ hostname: '127.0.0.1', port: 4000, path: request.url, method: request.method, headers: request.headers }, (upstream) => {
          response.writeHead(upstream.statusCode, upstream.headers);
          upstream.pipe(response);
        });
        proxy.on('error', () => { response.writeHead(502); response.end(); });
        request.pipe(proxy);
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const path = resolve(staticRoot, `.${pathname}`);
      if (!path.startsWith(staticRoot + sep) && path !== staticRoot) throw new Error('Unsafe path');
      const content = await readFile(path).catch(() => readFile(`${staticRoot}/index.html`));
      const extension = path.slice(path.lastIndexOf('.'));
      response.setHeader('Content-Type', types[extension] ?? 'text/html');
      response.end(content);
    } catch { response.writeHead(400); response.end(); }
  }).listen(8080, '127.0.0.1');
}

async function main() {
  const mode = process.argv[2];
  await measured('worker-startup', prepare);
  process.env.DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5432/forgeweb';
  if (mode === 'typecheck') {
    await measured('backend-typecheck', () => command('node', ['/opt/backend/node_modules/typescript/bin/tsc', '--noEmit']));
    await measured('frontend-typecheck', () => command('node', ['/opt/frontend/node_modules/typescript/bin/tsc', '-b', '--force'], frontend));
  } else if (mode === 'build') {
    await build();
  } else if (mode === 'tests') {
    await database();
    await measured('tests', () => command('node', ['/opt/backend/node_modules/jest/bin/jest.js', '--runInBand']));
  } else if (mode === 'postgres') {
    await database();
  } else if (mode === 'health' || mode === 'runtime') {
    await measured('startup', async () => { await database(); await build(); });
    await measured('health-probe', health);
    if (mode === 'runtime') { serve(); return; }
  } else throw new Error('Unsupported worker operation');
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
}

main().catch(() => { for (const child of children) child.kill('SIGKILL'); process.exit(1); });
