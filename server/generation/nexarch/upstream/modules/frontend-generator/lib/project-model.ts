// Adapted from NexArch commit 398f4cbd9e314954eda95540411ed4d06cd50cf3; used with the original author's permission.
/**
 * The generation IR.
 *
 * Pages are derived once, here, from the design artifacts — never from a
 * prompt. Modules come from the OpenAPI tags (mirroring the Backend
 * Generator's own approach, so the two stay in lockstep); each is matched to
 * its Prisma-backed table for list/form field derivation, and to its
 * backend-manifest entry to decide whether the page gets live CRUD UI or an
 * honest "not implemented yet" panel — the frontend never wires a table or
 * form against an endpoint Phase 5 only stubbed.
 */
import type { ArchitecturePlan } from '../../../shared/types/architecture.ts';
import type {
  ColumnDesign,
  DatabaseDesign,
  EntityMetadata,
  EntityMetadataSet,
  OpenApiDocument,
  TableDesign,
} from '../../../shared/types/design.ts';
import type { RequirementSemantics, RequirementSpec, SemanticEntity } from '../../../shared/types/requirement.ts';
import { kebabCase, pascalCase, singularize } from '../../../shared/utils/strings.ts';
import type { BackendManifest } from '../frontend-generator.types.ts';
import { crudOperations, operationForMethod } from '../../../shared/utils/operations.ts';
import type { CrudOperation } from '../../../shared/utils/operations.ts';

const SERVER_MANAGED = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);
const CHROME_TAGS = new Set(['Authentication', 'Reports', 'Notifications']);

/** Lucide icon per common module concept; falls back to a generic icon. */
const ICON_BY_KEYWORD: readonly [string, string][] = [
  ['user', 'Users'],
  ['product', 'Package'],
  ['order', 'ShoppingCart'],
  ['cart', 'ShoppingCart'],
  ['payment', 'CreditCard'],
  ['invoice', 'Receipt'],
  ['billing', 'Receipt'],
  ['appointment', 'CalendarClock'],
  ['booking', 'CalendarClock'],
  ['patient', 'HeartPulse'],
  ['doctor', 'Stethoscope'],
  ['student', 'GraduationCap'],
  ['teacher', 'GraduationCap'],
  ['class', 'BookOpen'],
  ['course', 'BookOpen'],
  ['exam', 'FileCheck2'],
  ['employee', 'Briefcase'],
  ['account', 'Landmark'],
  ['transaction', 'ArrowLeftRight'],
  ['loan', 'Landmark'],
  ['review', 'Star'],
  ['message', 'MessageSquare'],
  ['chat', 'MessageSquare'],
  ['notification', 'Bell'],
  ['report', 'BarChart3'],
  ['inventory', 'Boxes'],
  ['supplier', 'Truck'],
  ['room', 'BedDouble'],
  ['menu', 'UtensilsCrossed'],
  ['table', 'UtensilsCrossed'],
];

function iconFor(entityName: string): string {
  const lower = entityName.toLowerCase();
  for (const [keyword, icon] of ICON_BY_KEYWORD) {
    if (lower.includes(keyword)) return icon;
  }
  return 'Layers';
}

/**
 * A module's base path is the longest path-segment prefix shared by every
 * route carrying its tag (not "shortest path minus a trailing param" — that
 * breaks when the shortest route is a leaf action like `/auth/me`).
 */
function moduleBasePath(tag: string, doc: OpenApiDocument): string {
  const paths: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const operation of Object.values(item)) {
      if (operation.tags[0] === tag) paths.push(path);
    }
  }
  if (paths.length === 0) return `/${kebabCase(tag)}`;

  const segmentLists = paths.map((p) => p.split('/').filter(Boolean));
  const minLength = Math.min(...segmentLists.map((s) => s.length));
  const common: string[] = [];
  for (let i = 0; i < minLength; i++) {
    const first = segmentLists[0]?.[i];
    if (first === undefined || first.startsWith('{')) break;
    if (!segmentLists.every((segments) => segments[i] === first)) break;
    common.push(first);
  }
  return common.length > 0 ? `/${common.join('/')}` : `/${kebabCase(tag)}`;
}

function routeImplemented(manifest: BackendManifest, method: string, path: string): boolean {
  return manifest.routes.some((route) => route.implemented && route.method.toUpperCase() === method && route.path === path);
}

function completeCrud(manifest: BackendManifest, basePath: string, authEnabled: boolean, operations: readonly CrudOperation[]): boolean {
  const root = `/api/v1${basePath}`;
  const required = [['GET', root], ['GET', `${root}/:id`], ['POST', root], ['PUT', `${root}/:id`], ['DELETE', `${root}/:id`]] as const;
  const routes = required.filter(([method]) => operations.includes(operationForMethod(method)))
    .map(([method, path]) => manifest.routes.find((route) => route.implemented && route.method.toUpperCase() === method && route.path === path));
  return operations.includes('read') && routes.every(Boolean) && (authEnabled || routes.every((route) => route?.auth === false));
}

export interface PageModel {
  /** Intent survives even when the live capability gate withholds this page. */
  semantic?: SemanticEntity;
  /** PascalCase, e.g. `Products`. */
  name: string;
  /** kebab-case, e.g. `products`. */
  slug: string;
  /** Route path, e.g. `/products`. */
  route: string;
  /** API base path, e.g. `/products`. */
  apiBasePath: string;
  entity: TableDesign | null;
  metadata: EntityMetadata | null;
  /** Real CRUD is implemented on the backend for this entity. */
  implemented: boolean;
  operations: CrudOperation[];
  listColumns: ColumnDesign[];
  formFields: ColumnDesign[];
  icon: string;
  navLabel: string;
}

export interface FrontendProjectModel {
  semantics?: RequirementSemantics;
  projectName: string;
  projectType: string;
  apiPrefix: string;
  roles: string[];
  authEnabled: boolean;
  pages: PageModel[];
}

/** Columns worth a table column: skip huge text and skip FK ids (shown via a
 * resolved label elsewhere, not raw UUIDs) — cap at 6 for a scannable table. */
function pickListColumns(entity: TableDesign): ColumnDesign[] {
  if (entity.semantic?.fields.length) {
    const fields = new Set(entity.semantic.fields.map(field => field.name));
    return entity.columns.filter(column => fields.has(column.field));
  }
  const candidates = entity.columns.filter(
    (c) => !c.references && c.name !== 'id' && c.name !== 'deleted_at' && !(c.sqlType === 'TEXT'),
  );
  return candidates.slice(0, 6);
}

export function buildProjectModel(
  architecture: ArchitecturePlan,
  requirements: RequirementSpec,
  design: DatabaseDesign,
  openapi: OpenApiDocument,
  backendManifest: BackendManifest,
  entityMetadata: EntityMetadataSet,
): FrontendProjectModel {
  const tableByEntity = new Map(design.tables.map((t) => [t.entity, t]));
  const metadataByEntity = new Map(entityMetadata.entities.map((m) => [m.entity, m]));
  const backendByName = new Map(backendManifest.modules.map((m) => [m.name, m]));
  const authEnabled = openapi.tags.some((t) => t.name === 'Authentication')
    && routeImplemented(backendManifest, 'POST', '/api/v1/auth/login')
    && routeImplemented(backendManifest, 'POST', '/api/v1/auth/register');

  const pages: PageModel[] = [];

  for (const tag of openapi.tags.map((t) => t.name)) {
    // Authentication gets dedicated Login/Register/Profile pages, not a
    // generic entity page — every other tag gets a real nav item and page,
    // even when it has no backing table (Reports, Notifications, or a tag
    // an upstream path collision left with no table match): the frontend's
    // navigation should mirror the architecture's module list completely,
    // with an honest "not implemented" panel standing in for anything that
    // isn't backed by real CRUD yet, exactly as the Backend Generator
    // stubs a controller rather than omitting the module.
    if (CHROME_TAGS.has(tag)) continue;
    const entityName = architecture.apiModules.find(module => module.module === tag)?.entity ?? tag;
    const entity = tableByEntity.get(entityName) ?? null;
    const backendModule = backendByName.get(tag);
    // Nothing to build a table/form from without a table, regardless of
    // what the backend manifest claims.
    const apiBasePath = moduleBasePath(tag, openapi);
    const operations = crudOperations(entity?.semantic);
    const implemented = entity !== null && (backendModule?.crud ?? false) && completeCrud(backendManifest, apiBasePath, authEnabled, operations);

    pages.push({
      ...(entity?.semantic ? { semantic: structuredClone(entity.semantic) } : {}),
      name: pascalCase(tag),
      slug: kebabCase(tag),
      route: `/${kebabCase(tag)}`,
      apiBasePath,
      entity,
      metadata: entity ? (metadataByEntity.get(entity.entity) ?? null) : null,
      implemented,
      operations,
      listColumns: entity ? pickListColumns(entity) : [],
      formFields: entity ? entity.columns.filter((c) => !SERVER_MANAGED.has(c.name)) : [],
      icon: iconFor(entity?.entity ?? tag),
      navLabel: pascalCase(tag),
    });
  }

  return {
    ...(requirements.semantics ? { semantics: structuredClone(requirements.semantics) } : {}),
    projectName: architecture.meta.projectName,
    projectType: architecture.meta.projectType,
    apiPrefix: '/api/v1',
    roles: requirements.roles.length > 0 ? requirements.roles : ['Admin', 'User'],
    authEnabled,
    pages,
  };
}

/** Singular PascalCase form of a page's (plural) entity name, e.g. `Products` → `Product`. */
export function entitySingular(pluralName: string): string {
  return pascalCase(singularize(pluralName));
}
