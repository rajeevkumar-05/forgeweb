import type { PlanningSpecification } from "./planning.ts";
import type { DatabaseTargetContract } from "./engine.ts";
import type { DatabaseTargetStrategy } from "./nexarch/upstream/shared/types/design.ts";

export const MYSQL_PLANNING_PROFILE = "nexarch-mysql8-planning-v1";
export const POSTGRESQL_APPLICATION_PROFILE = "forgeweb-postgresql-v1";

const referentialActions = ["CASCADE", "RESTRICT", "SET NULL", "NO ACTION"] as const;

const mysql8 = {
  dialect: "mysql8",
  profile: MYSQL_PLANNING_PROFILE,
  engine: "MySQL 8",
  version: "MySQL 8.0",
  provider: "mysql",
  connection: { envVar: "DATABASE_URL", placeholder: "mysql://USER:PASSWORD@HOST:3306/DATABASE" },
  scalarTypes: {
    string32: { sqlType: "VARCHAR(32)", prismaType: "String", prismaNativeType: "@db.VarChar(32)" },
    string64: { sqlType: "VARCHAR(64)", prismaType: "String", prismaNativeType: "@db.VarChar(64)" },
    string191: { sqlType: "VARCHAR(191)", prismaType: "String", prismaNativeType: "@db.VarChar(191)" },
    string255: { sqlType: "VARCHAR(255)", prismaType: "String", prismaNativeType: "@db.VarChar(255)" },
    string320: { sqlType: "VARCHAR(320)", prismaType: "String", prismaNativeType: "@db.VarChar(320)" },
    string512: { sqlType: "VARCHAR(512)", prismaType: "String", prismaNativeType: "@db.VarChar(512)" },
    decimal12_2: { sqlType: "DECIMAL(12,2)", prismaType: "Decimal", prismaNativeType: "@db.Decimal(12, 2)" },
    integer: { sqlType: "INT", prismaType: "Int" },
    boolean: { sqlType: "BOOLEAN", prismaType: "Boolean" },
    timestamp: { sqlType: "DATETIME", prismaType: "DateTime" },
    date: { sqlType: "DATE", prismaType: "DateTime", prismaNativeType: "@db.Date" },
    text: { sqlType: "TEXT", prismaType: "String", prismaNativeType: "@db.Text" },
    json: { sqlType: "JSON", prismaType: "Json" },
  },
  enum: { representation: "inline-native", identifierStyle: "inline" },
  uuid: { sqlType: "CHAR(36)", prismaType: "String", prismaNativeType: "@db.Char(36)", sqlDefaultExpression: "uuid()", prismaDefaultExpression: "uuid()" },
  timestamps: { sqlType: "DATETIME", prismaType: "DateTime", createdDefaultExpression: "now()", updateBehavior: "prisma-updated-at" },
  defaults: { currentTimestamp: "now()", booleanTrue: "true", booleanFalse: "false" },
  foreignKeys: { supportedDeleteActions: referentialActions, supportedUpdateActions: referentialActions, defaultUpdateAction: "CASCADE" },
  indexes: { foreignKeys: "explicit", uniqueness: "unique-index", partialIndexes: false },
  identifiers: { quote: "`", maxLength: 64, unquotedCase: "preserve", overflow: "reject" },
  migration: { tool: "prisma-migrate", strategy: "versioned", destructiveReset: false },
  prisma: {
    provider: "mysql",
    datasourceName: "db",
    urlExpression: 'env("DATABASE_URL")',
    datasource: 'datasource db {\n  provider = "mysql"\n  url      = env("DATABASE_URL")\n}',
  },
} as const satisfies DatabaseTargetStrategy;

const postgresql = {
  dialect: "postgresql",
  profile: POSTGRESQL_APPLICATION_PROFILE,
  engine: "PostgreSQL",
  version: "PostgreSQL 13+",
  provider: "postgresql",
  connection: { envVar: "DATABASE_URL", placeholder: "postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public" },
  scalarTypes: {
    string32: { sqlType: "VARCHAR(32)", prismaType: "String", prismaNativeType: "@db.VarChar(32)" },
    string64: { sqlType: "VARCHAR(64)", prismaType: "String", prismaNativeType: "@db.VarChar(64)" },
    string191: { sqlType: "VARCHAR(191)", prismaType: "String", prismaNativeType: "@db.VarChar(191)" },
    string255: { sqlType: "VARCHAR(255)", prismaType: "String", prismaNativeType: "@db.VarChar(255)" },
    string320: { sqlType: "VARCHAR(320)", prismaType: "String", prismaNativeType: "@db.VarChar(320)" },
    string512: { sqlType: "VARCHAR(512)", prismaType: "String", prismaNativeType: "@db.VarChar(512)" },
    decimal12_2: { sqlType: "NUMERIC(12,2)", prismaType: "Decimal", prismaNativeType: "@db.Decimal(12, 2)" },
    integer: { sqlType: "INTEGER", prismaType: "Int" },
    boolean: { sqlType: "BOOLEAN", prismaType: "Boolean" },
    timestamp: { sqlType: "TIMESTAMPTZ(3)", prismaType: "DateTime", prismaNativeType: "@db.Timestamptz(3)" },
    date: { sqlType: "DATE", prismaType: "DateTime", prismaNativeType: "@db.Date" },
    text: { sqlType: "TEXT", prismaType: "String", prismaNativeType: "@db.Text" },
    json: { sqlType: "JSONB", prismaType: "Json", prismaNativeType: "@db.JsonB" },
  },
  enum: { representation: "named-native", identifierStyle: "snake_case" },
  uuid: { sqlType: "UUID", prismaType: "String", prismaNativeType: "@db.Uuid", sqlDefaultExpression: "gen_random_uuid()", prismaDefaultExpression: "uuid()" },
  timestamps: { sqlType: "TIMESTAMPTZ(3)", prismaType: "DateTime", prismaNativeType: "@db.Timestamptz(3)", createdDefaultExpression: "CURRENT_TIMESTAMP", updatedDefaultExpression: "CURRENT_TIMESTAMP", updateBehavior: "prisma-updated-at" },
  defaults: { currentTimestamp: "CURRENT_TIMESTAMP", booleanTrue: "TRUE", booleanFalse: "FALSE" },
  foreignKeys: { supportedDeleteActions: referentialActions, supportedUpdateActions: referentialActions, defaultUpdateAction: "CASCADE" },
  indexes: { foreignKeys: "explicit", uniqueness: "unique-index", partialIndexes: true },
  identifiers: { quote: '"', maxLength: 63, unquotedCase: "lowercase", overflow: "reject" },
  migration: { tool: "prisma-migrate", strategy: "versioned", destructiveReset: false },
  prisma: {
    provider: "postgresql",
    datasourceName: "db",
    urlExpression: 'env("DATABASE_URL")',
    datasource: 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}',
  },
} as const satisfies DatabaseTargetStrategy;

export const DATABASE_TARGETS = { mysql8, postgresql } as const;
export const APPLICATION_TARGET = DATABASE_TARGETS.postgresql;

export function resolveDatabaseTarget(dialect: unknown, profile: unknown): DatabaseTargetStrategy {
  if (dialect !== "mysql8" && dialect !== "postgresql") {
    throw new TypeError(`UNSUPPORTED_DATABASE_DIALECT: ${String(dialect)}`);
  }
  const target = DATABASE_TARGETS[dialect];
  if (profile !== target.profile) {
    throw new TypeError(`UNSUPPORTED_DATABASE_PROFILE: ${String(profile)} for ${dialect}`);
  }
  return target;
}

export function databaseTargetContract(target: DatabaseTargetStrategy): DatabaseTargetContract {
  return {
    dialect: target.dialect,
    profile: target.profile,
    provider: target.provider,
    connection: { ...target.connection },
    supportedScalarTypes: [...new Set([target.uuid.sqlType, ...Object.values(target.scalarTypes).map((type) => type.sqlType)])],
    enum: { ...target.enum },
    uuid: { sqlType: target.uuid.sqlType, sqlDefaultExpression: target.uuid.sqlDefaultExpression, prismaDefaultExpression: target.uuid.prismaDefaultExpression },
    timestamps: {
      sqlType: target.timestamps.sqlType,
      createdDefaultExpression: target.timestamps.createdDefaultExpression,
      ...(target.timestamps.updatedDefaultExpression ? { updatedDefaultExpression: target.timestamps.updatedDefaultExpression } : {}),
      updateBehavior: target.timestamps.updateBehavior,
    },
    defaults: { ...target.defaults },
    foreignKeys: {
      supportedDeleteActions: [...target.foreignKeys.supportedDeleteActions],
      supportedUpdateActions: [...target.foreignKeys.supportedUpdateActions],
      defaultUpdateAction: target.foreignKeys.defaultUpdateAction,
    },
    indexes: { ...target.indexes },
    identifiers: { ...target.identifiers },
    migration: { ...target.migration },
    prisma: { ...target.prisma },
  };
}

function containsMySqlOnlyColumnConstruct(plan: PlanningSpecification): boolean {
  return Boolean(plan.database?.entities.some((entity) => entity.fields.some((field) =>
    /^(?:CHAR\(36\)|DATETIME|INT)$/i.test(field.type)
    || /^ENUM\s*\(/i.test(field.type)
    || /^uuid\(\)$/i.test(field.defaultExpression ?? ""),
  )));
}

export function requireApplicationTarget(plan: PlanningSpecification): void {
  const target = plan.database?.target;
  const expected = databaseTargetContract(APPLICATION_TARGET);
  if (plan.databaseDialect !== APPLICATION_TARGET.dialect
    || plan.database?.dialect !== APPLICATION_TARGET.engine
    || plan.architecture?.projection.data.database !== APPLICATION_TARGET.engine
    || target?.dialect !== APPLICATION_TARGET.dialect
    || JSON.stringify(target) !== JSON.stringify(expected)
    || containsMySqlOnlyColumnConstruct(plan)) {
    throw new TypeError("UNSUPPORTED_DATABASE_TARGET: ForgeWeb applications require a verified PostgreSQL design");
  }
}
