import assert from "node:assert/strict";
import test from "node:test";
import type { AssembledCandidateArtifacts } from "../generation/candidate.ts";
import { disposablePostgresRequest, ForgeWebPostgresValidator } from "../generation/postgres-validation.ts";
import type { DisposablePostgresProvider, DisposablePostgresRequest } from "../generation/postgres-validation.ts";
import { digest } from "../lib.ts";

function candidate(schema = 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n\nmodel Task {\n  id String @id @default(uuid()) @db.Uuid\n}\n'): AssembledCandidateArtifacts {
  return {
    id: "candidate-postgres",
    manifestDigest: digest("postgres-manifest"),
    files: [{ path: "backend/prisma/schema.prisma", content: schema, digest: digest(schema), requirementIds: ["REQ-001"] }],
  } as unknown as AssembledCandidateArtifacts;
}

test("PostgreSQL validation is unavailable, never passed, without a disposable provider", async () => {
  const result = await new ForgeWebPostgresValidator().validate(candidate());
  assert.equal(result.status, "unavailable");
  assert.equal(result.checks.find((entry) => entry.id === "postgresql-runtime")?.status, "unavailable");
  assert.equal(result.target.userDatabaseAccess, false);
  assert.equal(result.target.forgeWebControlPlaneAccess, false);
  assert.equal(result.target.destroyAfterValidation, true);
});

test("disposable provider can attest schema and migration validation without receiving a database URL", async () => {
  let received: DisposablePostgresRequest | undefined;
  const provider: DisposablePostgresProvider = {
    async validate(request) {
      received = request;
      return {
        candidateId: request.candidateId,
        snapshotDigest: request.snapshotDigest,
        instanceDigest: "sha256:disposable-postgres-instance",
        schema: { status: "passed", evidence: "prisma validate passed" },
        migrations: { status: "passed", evidence: "migration dry run passed on disposable database" },
      };
    },
  };
  const result = await new ForgeWebPostgresValidator(provider).validate(candidate());
  assert.equal(result.status, "passed");
  assert.ok(received);
  assert.equal(JSON.stringify(received).includes("DATABASE_URL"), true);
  assert.equal(JSON.stringify(received).includes("postgresql://"), false);
  assert.equal("url" in (received as unknown as Record<string, unknown>), false);
  assert.equal(received?.target.userDatabaseAccess, false);
});

test("invalid or credential-bearing schema fails before any database provider is called", async () => {
  let called = false;
  const provider: DisposablePostgresProvider = {
    async validate() {
      called = true;
      throw new Error("must not run");
    },
  };
  const invalid = 'datasource db { provider = "mysql" url = "postgresql://user:secret@real.example/app" }';
  const result = await new ForgeWebPostgresValidator(provider).validate(candidate(invalid));
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0]?.status, "failed");
  assert.equal(called, false);
});

test("schema or migration failure on a disposable target prevents PostgreSQL success", async () => {
  const provider: DisposablePostgresProvider = {
    async validate(request) {
      return {
        candidateId: request.candidateId,
        snapshotDigest: request.snapshotDigest,
        instanceDigest: "sha256:disposable-postgres-instance",
        schema: { status: "passed", evidence: "schema valid" },
        migrations: { status: "failed", evidence: "migration dry run failed" },
      };
    },
  };
  const result = await new ForgeWebPostgresValidator(provider).validate(candidate());
  assert.equal(result.status, "failed");
  assert.equal(result.checks.find((entry) => entry.id === "postgresql-runtime")?.status, "failed");
});

test("disposable request is snapshot-bound and never contains user database access", () => {
  const request = disposablePostgresRequest(candidate());
  assert.equal(request.target.kind, "disposable-postgresql");
  assert.equal(request.target.userDatabaseAccess, false);
  assert.equal(request.target.forgeWebControlPlaneAccess, false);
  assert.equal(request.schema.digest, digest(request.schema.content));
});
