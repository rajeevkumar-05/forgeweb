// Adapted from NexArch commit 398f4cbd9e314954eda95540411ed4d06cd50cf3; used with the original author's permission.
/**
 * Backend Generation Engine: orchestrates the emitters into one
 * GeneratedProject.
 *
 *   architecture + design → ProjectModel (openapi tags → modules,
 *                            classified endpoints, Prisma-backed entities)
 *   ProjectModel → shared layer + one emission per module + app wiring +
 *                  root project files + test scaffolds
 *
 * Pure and deterministic. Consumes
 * only Phase 2–4 artifacts — never a raw prompt — and never touches the
 * platform's own source tree; everything is produced as an in-memory file
 * list.
 */
import type { ArchitecturePlan } from '../../shared/types/architecture.ts';
import type {
  DatabaseDesign,
  EntityMetadataSet,
  EntityValidation,
  OpenApiDocument,
} from '../../shared/types/design.ts';
import type { RequirementSpec } from '../../shared/types/requirement.ts';
import type {
  GeneratedFile,
  GeneratedModuleSummary,
  GeneratedProject,
  GeneratedRoute,
} from './backend-generator.types.ts';
import { emitAppWiring } from './lib/emit-app.ts';
import { emitModule } from './lib/emit-module.ts';
import { credentialTableOf } from './lib/emit-auth-module.ts';
import { emitProjectFiles } from './lib/emit-project-files.ts';
import { emitShared } from './lib/emit-shared.ts';
import { emitTests } from './lib/emit-tests.ts';
import { buildFolderTree, countLines } from './lib/file-tree.ts';
import { buildProjectModel, entitySingular } from './lib/project-model.ts';
import type { ModuleModel, ProjectModel } from './lib/project-model.ts';

function summarize(mod: ModuleModel, files: readonly GeneratedFile[]): GeneratedModuleSummary {
  const prefix = `src/modules/${mod.name}/`;
  const singular = mod.entity ? entitySingular(mod.entity.entity) : mod.className;
  return {
    name: mod.className,
    entity: mod.entity?.entity ?? null,
    crud: mod.crud,
    endpoints: mod.endpoints.length,
    controller: `${mod.className}Controller`,
    service: `${singular}Service`,
    repository: mod.entity ? `${singular}Repository` : null,
    files: files.filter((f) => f.path.startsWith(prefix)).map((f) => f.path),
  };
}

function routesOf(project: ProjectModel): GeneratedRoute[] {
  const routes: GeneratedRoute[] = [];
  for (const mod of project.modules) {
    for (const endpoint of mod.endpoints) {
      routes.push({
        method: endpoint.method.toUpperCase(),
        path: `${project.apiPrefix}${mod.basePath}${endpoint.routePath === '/' ? '' : endpoint.routePath}`,
        handler: `${mod.className}Controller.${endpoint.handlerName}`,
        auth: endpoint.auth,
        implemented: mod.entity !== null && endpoint.kind !== 'custom',
      });
    }
  }
  return routes;
}

export function generateBackend(
  architecture: ArchitecturePlan,
  requirements: RequirementSpec,
  database: DatabaseDesign,
  prismaSchema: string,
  openapi: OpenApiDocument,
  validationRules: EntityValidation[],
  entityMetadata: EntityMetadataSet,
): GeneratedProject {
  const project = buildProjectModel(
    architecture,
    requirements,
    database,
    openapi,
    validationRules,
    entityMetadata,
  );

  const files: GeneratedFile[] = [
    ...emitProjectFiles(project, prismaSchema, database.target),
    ...emitShared(),
    ...emitAppWiring(project, JSON.stringify(openapi, null, 2), database.target.engine),
    ...emitTests(project),
  ];
  // Resolved once: which table, if any, this application authenticates
  // against. Null means the design has no credential store and the auth
  // module stays a stub rather than authenticating against nothing.
  const credential = credentialTableOf(project.tables);
  for (const mod of project.modules) {
    files.push(...emitModule(mod, credential));
  }

  const modules = project.modules.map((mod) => summarize(mod, files));
  const routes = routesOf(project);
  const implementedEndpoints = routes.filter((r) => r.implemented).length;

  const generated: GeneratedProject = {
    meta: {
      projectName: project.projectName,
      projectType: project.projectType,
      framework: 'Express 5 + Prisma',
      language: 'TypeScript',
      generatedAt: database.meta.generatedAt,
      generator: 'nexarch-backend-generator/1.0',
    },
    files,
    modules,
    routes,
    folderTree: buildFolderTree(files),
    stats: {
      files: files.length,
      modules: modules.length,
      endpoints: routes.length,
      implementedEndpoints,
      linesOfCode: countLines(files),
    },
  };

  return generated;
}
