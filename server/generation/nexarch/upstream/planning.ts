// Adapted orchestration of NexArch's pure planning helpers. No routers, logger,
// provider configuration, schema emitters, or persistence enter this module.
import type { RequirementSpec } from "./shared/types/requirement.ts";
import type { ArchitecturePlan } from "./shared/types/architecture.ts";
import type { DatabaseDesign, PrismaEnumDesign } from "./shared/types/design.ts";
import type { AnalysisResult, DetectionSummary } from "./modules/analysis/analysis.types.ts";
import { normalize } from "./modules/analysis/lib/normalize.ts";
import { detectIntent } from "./modules/analysis/lib/intent-detector.ts";
import { extractFeatures } from "./modules/analysis/lib/feature-extractor.ts";
import { evaluateCompleteness } from "./modules/analysis/lib/completeness.ts";
import { buildSpec } from "./modules/analysis/lib/spec-builder.ts";
import { planApi } from "./modules/architecture/lib/api-planner.ts";
import { planDatabase } from "./modules/architecture/lib/database-planner.ts";
import { planDependencies } from "./modules/architecture/lib/dependency-planner.ts";
import { planFolders } from "./modules/architecture/lib/folder-planner.ts";
import { planFrontend } from "./modules/architecture/lib/frontend-planner.ts";
import { exportMarkdown } from "./modules/architecture/lib/markdown-exporter.ts";
import { planBackendModules, planMiddleware } from "./modules/architecture/lib/module-planner.ts";
import { planScalability, scoreNonFunctionals } from "./modules/architecture/lib/scalability-planner.ts";
import { planSecurity } from "./modules/architecture/lib/security-planner.ts";
import { decideTechnology } from "./modules/architecture/lib/technology-engine.ts";
import { designTable } from "./modules/database-designer/lib/table-designer.ts";
import { buildRelationships } from "./modules/database-designer/lib/relationship-engine.ts";
import { planOptimization } from "./modules/database-designer/lib/optimization-planner.ts";

export function analyzeRequirements(prompt: string): AnalysisResult {
  const normalized = normalize(prompt);
  const intent = detectIntent(normalized);
  const features = extractFeatures(normalized);
  const detection: DetectionSummary = {
    projectType: intent.profile?.type ?? null,
    confidence: intent.confidence,
    matchedSignals: [...new Set([...intent.matchedKeywords, ...features.signals])],
  };
  const verdict = evaluateCompleteness(intent.profile, features);
  if (!verdict.complete) return { status: "INCOMPLETE", questions: verdict.questions, detection };
  return { status: "COMPLETE", spec: buildSpec(prompt, normalized, intent.profile, features), detection };
}

export function planArchitecture(spec: RequirementSpec): { plan: ArchitecturePlan; markdown: string } {
  const plan: ArchitecturePlan = {
    meta: { projectName: spec.projectName, projectType: spec.projectType, generatedAt: new Date().toISOString(), planner: "nexarch-architecture-planner/1.0" },
    decisions: decideTechnology(spec),
    folderStructure: planFolders(spec),
    apiModules: planApi(spec),
    frontend: planFrontend(spec),
    database: planDatabase(spec),
    services: planBackendModules(spec),
    middleware: planMiddleware(spec),
    security: planSecurity(spec),
    dependencyGraph: planDependencies(spec),
    futureScalability: planScalability(spec),
    nonFunctional: scoreNonFunctionals(spec),
  };
  // Preserve the planner's auth design. Its upstream global default strips it.
  return { plan, markdown: exportMarkdown(plan) };
}

export function designDatabase(architecture: ArchitecturePlan, requirements: RequirementSpec): DatabaseDesign {
  const roleEnumValues = requirements.roles.map((role) => role.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, ""));
  const tables = [];
  const enumMap = new Map<string, PrismaEnumDesign>();
  for (const entity of architecture.database.entities) {
    const designed = designTable(entity, { roleEnumValues });
    tables.push(designed.table);
    for (const item of designed.enums) if (!enumMap.has(item.name)) enumMap.set(item.name, item);
  }
  const design: DatabaseDesign = {
    meta: {
      projectName: architecture.meta.projectName,
      projectType: architecture.meta.projectType,
      engine: architecture.database.engine,
      databaseVersion: "MySQL 8.0",
      normalForm: "Third Normal Form (3NF)",
      generatedAt: new Date().toISOString(),
      generator: "nexarch-database-designer/1.0",
    },
    enums: [...enumMap.values()],
    tables,
    relationships: buildRelationships(architecture.database.entities),
    optimization: { indexes: [], cachingCandidates: [], partitioningCandidates: [], queryGuidelines: [] },
  };
  design.optimization = planOptimization(design);
  return design;
}
