import type { PlanningSpecification } from "./planning.ts";

export const APPLICATION_TARGET = { dialect: "postgresql", profile: "forgeweb-postgresql-v1" } as const;

export function requireApplicationTarget(plan: PlanningSpecification): void {
  if (plan.databaseDialect !== APPLICATION_TARGET.dialect
    || plan.database?.dialect !== "PostgreSQL"
    || plan.architecture?.projection.data.database !== "PostgreSQL") {
    throw new TypeError("UNSUPPORTED_DATABASE_TARGET: ForgeWeb applications require a PostgreSQL plan");
  }
}
