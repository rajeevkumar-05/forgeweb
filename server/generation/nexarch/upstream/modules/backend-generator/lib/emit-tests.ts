// Adapted from NexArch commit 398f4cbd9e314954eda95540411ed4d06cd50cf3; used with the original author's permission.
/**
 * Emits Jest test scaffolds: one unit test per CRUD module (service layer,
 * mocking the repository), an integration test skeleton per module hitting
 * the real Express app against a disposable database, mock fixtures derived
 * from the real column types, and the Jest config itself.
 */
import { entitySingular } from './project-model.ts';
import type { ModuleModel, ProjectModel } from './project-model.ts';
import { credentialTableOf, isAuthModule } from './emit-auth-module.ts';
import { mockValue } from './type-map.ts';
import type { GeneratedFile } from '../backend-generator.types.ts';
import { file } from './file-tree.ts';

function unitTest(mod: ModuleModel): GeneratedFile | null {
  const entity = mod.entity;
  if (!entity) return null;
  const singular = entitySingular(entity.entity);

  const fields = entity.columns.filter(
    (c) => !['id', 'created_at', 'updated_at', 'deleted_at'].includes(c.name),
  );
  const createFields = fields.map((c) => `  ${c.field}: ${mockValue(c)},`).join('\n');
  const fixtureFields = entity.columns.map((c) =>
    `  ${c.field}: ${c.name === 'deleted_at' && c.nullable ? 'null' : mockValue(c)},`,
  ).join('\n');

  return file(
    `src/modules/${mod.name}/services/${mod.name}.service.test.ts`,
    'typescript',
    `import { ${singular}Service } from './${mod.name}.service.js';
import { ${singular}Repository } from '../repositories/${mod.name}.repository.js';
import type { Create${singular}Dto, ${entity.entity}Entity } from '../dto/${mod.name}.dto.js';

jest.mock('../repositories/${mod.name}.repository.js');

const fixture: ${entity.entity}Entity = {
${fixtureFields}
};

const createFixture: Create${singular}Dto = {
${createFields}
};

describe('${singular}Service', () => {
  let service: ${singular}Service;
  let repository: jest.Mocked<${singular}Repository>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ${singular}Service();
    repository = (${singular}Repository as jest.Mock).mock.instances[0] as jest.Mocked<${singular}Repository>;
  });

  it('lists records with pagination metadata', async () => {
    repository.findManyPaginated = jest.fn().mockResolvedValue([fixture]);
    repository.count = jest.fn().mockResolvedValue(1);

    const result = await service.list({});

    expect(result.items).toEqual([fixture]);
    expect(result.meta.total).toBe(1);
  });

  it('returns a record by id', async () => {
    repository.findById = jest.fn().mockResolvedValue(fixture);

    const result = await service.findById(fixture.id);

    expect(result).toEqual(fixture);
  });

  it('throws NotFoundError when the record is missing', async () => {
    repository.findById = jest.fn().mockResolvedValue(null);

    await expect(service.findById('missing-id')).rejects.toThrow('${entity.entity} not found');
  });

  it('creates a record', async () => {
    repository.create = jest.fn().mockResolvedValue(fixture);

    const result = await service.create(createFixture);

    expect(repository.create).toHaveBeenCalledWith(createFixture);
    expect(result).toEqual(fixture);
  });

  it('soft-deletes a record after confirming it exists', async () => {
    repository.findById = jest.fn().mockResolvedValue(fixture);
    repository.softDelete = jest.fn().mockResolvedValue(fixture);

    await service.remove(fixture.id);

    expect(repository.softDelete).toHaveBeenCalledWith(fixture.id);
  });
});
`,
  );
}

function integrationTest(mod: ModuleModel, project: ProjectModel): GeneratedFile | null {
  if (!mod.entity) return null;
  const listEndpoint = mod.endpoints.find((e) => e.kind === 'list');
  if (!listEndpoint) return null;
  const path = `${project.apiPrefix}${mod.basePath}${listEndpoint.routePath === '/' ? '' : listEndpoint.routePath}`;
  const credential = credentialTableOf(project.tables);
  const auth = credential ? project.modules.find(isAuthModule) : undefined;
  const register = auth?.endpoints.find((endpoint) => endpoint.method === 'post' && endpoint.routePath.toLowerCase() === '/register');
  const login = auth?.endpoints.find((endpoint) => endpoint.method === 'post' && endpoint.routePath.toLowerCase() === '/login');
  const canSignIn = listEndpoint.auth && credential && auth && register && login;
  const registrationFields = canSignIn ? [
    `      ${credential.emailField}: 'integration-${mod.name}@example.test',`,
    "      password: 'integration-test-password',",
    ...(credential.nameField ? [`      ${credential.nameField}: 'Integration User',`] : []),
    ...credential.extraRequired.map((column) => `      ${column.field}: ${mockValue(column)},`),
  ].join('\n') : '';
  const signIn = canSignIn ? `
  let accessToken: string;

  beforeAll(async () => {
    const registered = await request(app).post('${project.apiPrefix}${auth.basePath}${register.routePath}').send({
${registrationFields}
    });
    expect(registered.status).toBe(201);
    const signedIn = await request(app).post('${project.apiPrefix}${auth.basePath}${login.routePath}').send({
      ${credential.emailField}: 'integration-${mod.name}@example.test',
      password: 'integration-test-password',
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.accessToken).toEqual(expect.any(String));
    accessToken = signedIn.body.data.accessToken;
  });
` : '';
  const rejectionTests = listEndpoint.auth ? `
  it('GET ${path} rejects unauthenticated access', async () => {
    const response = await request(app).get('${path}');
    expect(response.status).toBe(401);
  });

  it('GET ${path} rejects an invalid bearer token', async () => {
    const response = await request(app).get('${path}').set('Authorization', 'Bearer invalid-test-token');
    expect(response.status).toBe(401);
  });
` : '';
  // Missing sign-in is a contract failure, not permission to skip the
  // positive-access test or invent a credential provider.
  const successTest = !listEndpoint.auth || canSignIn ? `
  it('GET ${path} returns a paginated envelope${listEndpoint.auth ? ' after sign-in' : ''}', async () => {
    const response = await request(app).get('${path}')${canSignIn ? ".set('Authorization', 'Bearer ' + accessToken)" : ''};

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({ success: true, data: expect.any(Array) }),
    );
  });
` : `
  it('GET ${path} requires an implemented sign-in capability for its access test', () => {
    throw new Error('Protected list route has no implemented register/login capability');
  });
`;

  return file(
    `test/integration/${mod.name}.integration.test.ts`,
    'typescript',
    `/**
 * Integration scaffold for ${mod.className}. Requires a running database
 * (point DATABASE_URL at a disposable test database before running).
 */
import request from 'supertest';

import { createApp } from '../../src/app.js';
import { disconnectDatabase } from '../../src/shared/database/prisma.js';

describe('${path} (integration)', () => {
  const app = createApp();
${signIn}
  afterAll(async () => { await disconnectDatabase(); });
${rejectionTests}${successTest}
});
`,
  );
}

function jestConfig(): GeneratedFile {
  return file(
    'jest.config.js',
    'javascript',
    `/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\\\.{1,2}/.*)\\\\.js$': '$1' },
  transform: { '^.+\\\\.ts$': ['ts-jest', { useESM: true }] },
  testMatch: ['**/*.test.ts'],
};
`,
  );
}

function apiMocks(project: ProjectModel): GeneratedFile {
  const fixtures = project.modules
    .filter((m) => m.entity)
    .map((m) => {
      const entity = m.entity;
      if (!entity) return '';
      const fields = entity.columns
        .filter((c) => !['id', 'created_at', 'updated_at', 'deleted_at'].includes(c.name))
        .map((c) => `    ${c.field}: ${mockValue(c)},`)
        .join('\n');
      return `export const mock${entity.entity} = {
  id: '00000000-0000-0000-0000-000000000001',
${fields}
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
};
`;
    })
    .join('\n');

  return file(
    'test/mocks/fixtures.ts',
    'typescript',
    `// Generated mock fixtures — one per entity, for unit and integration tests.\n\n${fixtures}`,
  );
}

export function emitTests(project: ProjectModel): GeneratedFile[] {
  const files: GeneratedFile[] = [jestConfig(), apiMocks(project)];
  for (const mod of project.modules) {
    const unit = unitTest(mod);
    if (unit) files.push(unit);
    const integration = integrationTest(mod, project);
    if (integration) files.push(integration);
  }
  return files;
}
