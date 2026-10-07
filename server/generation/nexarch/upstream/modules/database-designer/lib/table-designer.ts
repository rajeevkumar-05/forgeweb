/**
 * TableDesigner: assembles a full `TableDesign` for one architecture entity.
 *
 * Every table follows the platform's relational conventions:
 *   • target-native UUID primary key
 *   • inferred business columns (from the architecture key-field hints)
 *   • foreign-key columns from the relationship engine
 *   • `created_at` / `updated_at` audit columns, and `deleted_at` for soft
 *     delete (applied universally — deletes are recoverable by default)
 *   • indexes on every foreign key and unique business key
 *
 * Enum columns contribute a shared Prisma enum, collected across all tables.
 */
import type { EntityPlan } from '../../../shared/types/architecture.ts';
import { camelCase, snakeCase } from '../../../shared/utils/strings.ts';
import type {
  ColumnDesign,
  DatabaseTargetStrategy,
  IndexDesign,
  OnDelete,
  PrismaEnumDesign,
  TableDesign,
} from '../database-designer.types.ts';
import { inferColumn, parseKeyField } from './column-inference.ts';
import type { InferenceContext } from './column-inference.ts';
import { resolveForeignKeys } from './relationship-engine.ts';

/** Key-field hints that the designer manages itself and must not re-infer. */
const RESERVED_FIELDS = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);

function primaryKeyColumn(target: DatabaseTargetStrategy): ColumnDesign {
  return {
    name: 'id',
    field: 'id',
    sqlType: target.uuid.sqlType,
    prismaType: target.uuid.prismaType,
    ...(target.uuid.prismaNativeType ? { prismaNativeType: target.uuid.prismaNativeType } : {}),
    nullable: false,
    primaryKey: true,
    unique: true,
    defaultExpression: target.uuid.sqlDefaultExpression,
    format: 'uuid',
    description: 'Primary key (UUID generated on insert).',
  };
}

function foreignKeyColumn(
  foreignKey: string,
  parent: string,
  nullable: boolean,
  onDelete: OnDelete,
  target: DatabaseTargetStrategy,
): ColumnDesign {
  return {
    name: foreignKey,
    field: camelCase(foreignKey),
    sqlType: target.uuid.sqlType,
    prismaType: target.uuid.prismaType,
    ...(target.uuid.prismaNativeType ? { prismaNativeType: target.uuid.prismaNativeType } : {}),
    nullable,
    primaryKey: false,
    unique: false,
    references: { table: parent, column: 'id', onDelete, onUpdate: target.foreignKeys.defaultUpdateAction },
    format: 'uuid',
    description: `Foreign key referencing ${parent}.`,
  };
}

function auditColumns(target: DatabaseTargetStrategy): ColumnDesign[] {
  return [
    {
      name: 'created_at',
      field: 'createdAt',
      sqlType: target.timestamps.sqlType,
      prismaType: target.timestamps.prismaType,
      ...(target.timestamps.prismaNativeType ? { prismaNativeType: target.timestamps.prismaNativeType } : {}),
      nullable: false,
      primaryKey: false,
      unique: false,
      defaultExpression: target.timestamps.createdDefaultExpression,
      description: 'Row creation timestamp.',
    },
    {
      name: 'updated_at',
      field: 'updatedAt',
      sqlType: target.timestamps.sqlType,
      prismaType: target.timestamps.prismaType,
      ...(target.timestamps.prismaNativeType ? { prismaNativeType: target.timestamps.prismaNativeType } : {}),
      nullable: false,
      primaryKey: false,
      unique: false,
      onUpdateNow: true,
      ...(target.timestamps.updatedDefaultExpression ? { defaultExpression: target.timestamps.updatedDefaultExpression } : {}),
      description: 'Last modification timestamp (auto-updated).',
    },
    {
      name: 'deleted_at',
      field: 'deletedAt',
      sqlType: target.timestamps.sqlType,
      prismaType: target.timestamps.prismaType,
      ...(target.timestamps.prismaNativeType ? { prismaNativeType: target.timestamps.prismaNativeType } : {}),
      nullable: true,
      primaryKey: false,
      unique: false,
      description: 'Soft-delete timestamp; NULL for live rows.',
    },
  ];
}

function buildIndexes(tableName: string, columns: readonly ColumnDesign[]): IndexDesign[] {
  const indexes: IndexDesign[] = [];
  for (const column of columns) {
    if (column.primaryKey) continue;
    if (column.references) {
      indexes.push({
        name: `idx_${tableName}_${column.name}`,
        columns: [column.name],
        unique: false,
        rationale: `Foreign key lookups and joins on ${column.name}.`,
      });
    } else if (column.unique) {
      indexes.push({
        name: `uq_${tableName}_${column.name}`,
        columns: [column.name],
        unique: true,
        rationale: `Enforces uniqueness of ${column.name}.`,
      });
    }
  }
  // Soft-delete + recency composite: the default "live, newest first" query.
  indexes.push({
    name: `idx_${tableName}_deleted_created`,
    columns: ['deleted_at', 'created_at'],
    unique: false,
    rationale: 'Serves the default filter (deleted_at IS NULL) ordered by recency.',
  });
  return indexes;
}

export interface DesignedTable {
  table: TableDesign;
  enums: PrismaEnumDesign[];
}

export function designTable(entity: EntityPlan, context: InferenceContext): DesignedTable {
  const columns: ColumnDesign[] = [primaryKeyColumn(context.target)];
  const enums: PrismaEnumDesign[] = [];
  const foreignKeys = resolveForeignKeys(entity);
  const fkNames = new Set(foreignKeys.map((fk) => fk.foreignKey));

  // Business columns from architecture hints (skip reserved + FK columns).
  //
  // A column name may only appear once. keyFields arrives from several
  // places — a built-in rule table, a model's suggestions, an earlier
  // merge — and one duplicate makes the whole Prisma schema invalid, so
  // the run dies at `prisma generate` with every other table fine. Names
  // are claimed here, at the one point every column passes through.
  const claimed = new Set<string>(RESERVED_FIELDS);
  for (const name of fkNames) claimed.add(name);

  const semanticFields = new Map(entity.semantic?.fields.map(field => [snakeCase(field.name), field]));
  for (const raw of [...entity.keyFields, ...semanticFields.keys()]) {
    const parsed = parseKeyField(raw);
    if (claimed.has(parsed.name)) continue;
    claimed.add(parsed.name);
    const semantic = semanticFields.get(parsed.name);
    // Unknown semantic types use existing inference/string255 defaults, not
    // invented enum values merely because a field happens to be "category".
    const column = inferColumn(entity.name, parsed, context, !semantic);
    if (semantic?.required !== undefined) column.nullable = !semantic.required;
    if (semantic?.description) column.description = semantic.description;
    columns.push(column);
    if (column.enumValues) {
      enums.push({ name: column.prismaType, values: column.enumValues, ...(column.enumDatabaseType ? { databaseName: column.enumDatabaseType } : {}) });
    }
  }

  // Foreign-key columns.
  for (const fk of foreignKeys) {
    const column = foreignKeyColumn(fk.foreignKey, fk.parent, fk.nullable, fk.onDelete, context.target);
    column.unique = fk.cardinality === 'one-to-one';
    columns.push(column);
  }

  columns.push(...auditColumns(context.target));

  const table: TableDesign = {
    ...(entity.semantic ? { semantic: structuredClone(entity.semantic) } : {}),
    entity: entity.name,
    tableName: entity.tableName,
    columns,
    primaryKey: 'id',
    indexes: buildIndexes(entity.tableName, columns),
    softDelete: true,
    description: `Stores ${entity.name} records.`,
  };

  return { table, enums };
}
