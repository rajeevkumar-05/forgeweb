import { digest } from "../lib.ts";
import type { AssembledCandidateArtifacts } from "./candidate.ts";
import { candidateOutputDigest } from "./candidate.ts";
import { candidateManifestDigest, prepareCandidate, prepareGenerationRequest, prepareValidation } from "./contract.ts";
import type { GenerationRequest } from "./engine.ts";
import type { CandidateValidationReport } from "./validation.ts";

export const ENGINEERING_GRAPH_CONTRACT_VERSION = "forgeweb-engineering-graph-v1" as const;

export type EngineeringNodeType =
  | "PROJECT"
  | "REQUIREMENT"
  | "FEATURE"
  | "COMPONENT"
  | "API"
  | "ENTITY"
  | "FIELD"
  | "MODULE"
  | "SERVICE"
  | "FILE"
  | "TEST"
  | "SECURITY_RULE"
  | "DEPENDENCY";

export type EngineeringRelationship =
  | "CONTAINS"
  | "IMPLEMENTS"
  | "EXPOSES"
  | "USES"
  | "BELONGS_TO"
  | "PERSISTS"
  | "GENERATES"
  | "TESTS"
  | "CALLS"
  | "DEPENDS_ON"
  | "SECURED_BY"
  | "TARGETS";

export type EngineeringGraphNode = {
  readonly id: string;
  readonly type: EngineeringNodeType;
  readonly label: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
};

export type EngineeringGraphEdge = {
  readonly id: string;
  readonly type: EngineeringRelationship;
  readonly from: string;
  readonly to: string;
  readonly evidence: string;
};

export type EngineeringEvidenceGraph = {
  readonly contractVersion: typeof ENGINEERING_GRAPH_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly manifestDigest: string;
  readonly validationStatus: CandidateValidationReport["status"];
  readonly targetProfile: string;
  readonly databaseProvider: "postgresql";
  readonly nodes: readonly EngineeringGraphNode[];
  readonly edges: readonly EngineeringGraphEdge[];
  readonly generatedAt: string;
  readonly digest: string;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function stableDigest(value: unknown): string {
  return digest(JSON.stringify(canonical(value)));
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function nodeId(type: EngineeringNodeType, key: string): string {
  return `${type.toLowerCase()}:${encodeURIComponent(key)}`;
}

function graphDigest(graph: Omit<EngineeringEvidenceGraph, "id" | "digest">): string {
  return stableDigest(graph);
}

export function engineeringGraphDigest(graph: EngineeringEvidenceGraph): string {
  const { id: _id, digest: _digest, ...content } = graph;
  return graphDigest(content);
}

function requireGraph(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid engineering graph: ${message}`);
}

export function verifyEngineeringGraph(graph: EngineeringEvidenceGraph, candidate: AssembledCandidateArtifacts): void {
  requireGraph(graph.contractVersion === ENGINEERING_GRAPH_CONTRACT_VERSION, "unsupported contract");
  requireGraph(graph.projectId === candidate.projectId && graph.candidateId === candidate.id, "candidate context mismatch");
  requireGraph(graph.candidateDigest === candidate.assembly.determinism.outputDigest && graph.manifestDigest === candidate.manifestDigest, "candidate evidence mismatch");
  requireGraph(graph.digest === engineeringGraphDigest(graph) && graph.id === `engineering_graph_${graph.digest.slice(0, 24)}`, "digest mismatch");
  const nodes = new Set<string>();
  for (const node of graph.nodes) {
    requireGraph(!nodes.has(node.id), `duplicate node ${node.id}`);
    nodes.add(node.id);
  }
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    requireGraph(nodes.has(edge.from) && nodes.has(edge.to), `edge ${edge.id} references a missing node`);
    requireGraph(!edges.has(edge.id), `duplicate edge ${edge.id}`);
    edges.add(edge.id);
  }
}

export class ForgeWebEngineeringGraphBuilder {
  build(requestInput: GenerationRequest, candidateInput: AssembledCandidateArtifacts, validationInput: CandidateValidationReport): EngineeringEvidenceGraph {
    const request = prepareGenerationRequest(requestInput);
    const candidate = prepareCandidate(candidateInput, request) as AssembledCandidateArtifacts;
    const validation = prepareValidation(validationInput, candidate) as CandidateValidationReport;
    requireGraph(candidate.assembly.determinism.outputDigest === candidateOutputDigest(candidate), "candidate digest is invalid");
    requireGraph(candidate.manifestDigest === candidateManifestDigest(candidate), "candidate manifest is invalid");
    requireGraph(validation.manifestDigest === candidate.manifestDigest, "validation targets another manifest");

    const nodes = new Map<string, EngineeringGraphNode>();
    const edges = new Map<string, EngineeringGraphEdge>();
    const addNode = (type: EngineeringNodeType, key: string, label: string, metadata: EngineeringGraphNode["metadata"] = {}) => {
      const id = nodeId(type, key);
      const existing = nodes.get(id);
      requireGraph(!existing || existing.label === label, `conflicting node ${id}`);
      nodes.set(id, { id, type, label, metadata });
      return id;
    };
    const addEdge = (type: EngineeringRelationship, from: string, to: string, evidence: string) => {
      requireGraph(nodes.has(from) && nodes.has(to), `${type} edge lacks evidence nodes`);
      const key = `${type}\u0000${from}\u0000${to}\u0000${evidence}`;
      const id = `engineering_edge_${stableDigest(key).slice(0, 24)}`;
      edges.set(id, { id, type, from, to, evidence });
    };
    const project = addNode("PROJECT", candidate.projectId, request.approved.specification.productName, {
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
    });
    const requirementNodes = new Map(request.approved.specification.requirements.map((requirement) => {
      const id = addNode("REQUIREMENT", requirement.id, requirement.title, { priority: requirement.priority });
      addEdge("CONTAINS", project, id, `approved specification ${request.approved.specification.id}`);
      return [requirement.id, id] as const;
    }));
    const trace = (from: string, requirementIds: readonly string[], evidence: string, relationship: EngineeringRelationship = "IMPLEMENTS") => {
      for (const requirementId of requirementIds) {
        const requirement = requirementNodes.get(requirementId);
        requireGraph(requirement, `unknown requirement ${requirementId}`);
        addEdge(relationship, from, requirement, evidence);
      }
    };

    const rootModules = {
      backend: addNode("MODULE", "backend", "Backend", { profile: candidate.assembly.target.profile }),
      frontend: addNode("MODULE", "frontend", "Frontend", { profile: candidate.assembly.target.frontendProfile }),
    };
    addEdge("CONTAINS", project, rootModules.backend, "backend slice");
    addEdge("CONTAINS", project, rootModules.frontend, "frontend slice");

    const featureNodes = new Map<string, string>();
    const feature = (name: string) => {
      const existing = featureNodes.get(name);
      if (existing) return existing;
      const id = addNode("FEATURE", name, name, {});
      featureNodes.set(name, id);
      addEdge("CONTAINS", project, id, "generated capability manifest");
      return id;
    };

    const apiNodes = new Map<string, string>();
    for (const route of candidate.assembly.capabilities.backendRoutes) {
      const key = `${route.method.toUpperCase()} ${route.path}`;
      const api = addNode("API", key, key, { status: route.status, authenticated: route.auth, handler: route.handler });
      apiNodes.set(key, api);
      addEdge("CONTAINS", project, api, "backend route manifest");
      const owner = feature(route.feature);
      addEdge("EXPOSES", owner, api, `backend feature ${route.feature}`);
      addEdge("BELONGS_TO", api, owner, `backend route feature ${route.feature}`);
      trace(api, route.requirementIds, `route ${key}`);
      if (route.auth) {
        const rule = addNode("SECURITY_RULE", "authenticated-route", "Authenticated route", { kind: "authentication" });
        addEdge("CONTAINS", project, rule, "authenticated backend routes");
        addEdge("SECURED_BY", api, rule, `route ${key} requires authentication`);
      }
      for (const role of route.roles) {
        const rule = addNode("SECURITY_RULE", `role:${role}`, `Role ${role}`, { kind: "authorization", role });
        addEdge("CONTAINS", project, rule, `route role manifest ${role}`);
        addEdge("SECURED_BY", api, rule, `route ${key} requires role ${role}`);
      }
    }

    const entityNodes = new Map<string, string>();
    for (const entity of candidate.assembly.evidence.backendEntities) {
      const entityNode = addNode("ENTITY", entity.name, entity.name, { tableName: entity.tableName, softDelete: entity.softDelete });
      entityNodes.set(entity.name, entityNode);
      addEdge("CONTAINS", project, entityNode, `backend entity ${entity.tableName}`);
      for (const field of entity.fields) {
        const fieldNode = addNode("FIELD", `${entity.name}.${field}`, field, { entity: entity.name });
        addEdge("CONTAINS", entityNode, fieldNode, `entity field ${entity.name}.${field}`);
      }
    }
    for (const route of candidate.assembly.capabilities.backendRoutes) {
      if (!route.entity) continue;
      const api = apiNodes.get(`${route.method.toUpperCase()} ${route.path}`)!;
      const entity = entityNodes.get(route.entity);
      requireGraph(entity, `route ${route.method} ${route.path} references missing entity ${route.entity}`);
      addEdge("USES", api, entity, `route entity ${route.entity}`);
    }

    for (const module of candidate.assembly.evidence.backendModules) {
      const moduleNode = addNode("MODULE", `backend:${module.name}`, module.name, { entity: module.entity ?? "", crud: module.crud });
      addEdge("CONTAINS", rootModules.backend, moduleNode, `backend module ${module.name}`);
      const serviceNode = addNode("SERVICE", module.service, module.service, { module: module.name });
      addEdge("CONTAINS", moduleNode, serviceNode, `module service ${module.service}`);
      addEdge("BELONGS_TO", serviceNode, moduleNode, `module ${module.name}`);
      if (module.entity) {
        const entityNode = entityNodes.get(module.entity);
        requireGraph(entityNode, `module ${module.name} references missing entity ${module.entity}`);
        addEdge("PERSISTS", moduleNode, entityNode, `module entity ${module.entity}`);
      }
      for (const route of candidate.assembly.capabilities.backendRoutes.filter((entry) => entry.feature === module.name)) {
        const api = apiNodes.get(`${route.method.toUpperCase()} ${route.path}`)!;
        addEdge("EXPOSES", moduleNode, api, `module route ${route.handler}`);
      }
    }

    for (const component of candidate.assembly.evidence.frontendComponents) {
      const componentNode = addNode("COMPONENT", component.name, component.name, { kind: component.kind, file: component.file });
      addEdge("CONTAINS", rootModules.frontend, componentNode, `frontend component ${component.file}`);
      trace(componentNode, component.requirementIds, `component ${component.name}`);
    }
    for (const page of candidate.assembly.evidence.frontendPages) {
      const pageFeature = feature(page.name);
      addEdge("BELONGS_TO", pageFeature, rootModules.frontend, `frontend page ${page.route}`);
      trace(pageFeature, page.requirementIds, `frontend page ${page.route}`);
    }
    for (const store of candidate.assembly.evidence.frontendStores) {
      const componentNode = addNode("COMPONENT", `store:${store.name}`, store.name, { kind: "store", file: store.file, persisted: store.persisted, sensitive: store.sensitive });
      addEdge("CONTAINS", rootModules.frontend, componentNode, `frontend store ${store.file}`);
      trace(componentNode, store.requirementIds, `store ${store.name}`);
    }
    for (const call of candidate.assembly.capabilities.frontendApi.generatedCalls) {
      const api = apiNodes.get(`${call.method.toUpperCase()} ${call.path}`);
      requireGraph(api, `frontend call references missing API ${call.method} ${call.path}`);
      const caller = feature(call.feature);
      addEdge("CALLS", caller, api, `generated frontend call ${call.method.toUpperCase()} ${call.path}`);
      trace(caller, call.requirementIds, `frontend API feature ${call.feature}`);
    }

    const componentByFile = new Map(candidate.assembly.evidence.frontendComponents.map((entry) => [entry.file, nodeId("COMPONENT", entry.name)]));
    const moduleByFile = new Map(candidate.assembly.evidence.backendModules.flatMap((module) => module.files.map((path) => [path, nodeId("MODULE", `backend:${module.name}`)] as const)));
    for (const file of candidate.files) {
      const fileNode = addNode("FILE", file.path, file.path, { digest: file.digest });
      addEdge("GENERATES", project, fileNode, `candidate ${candidate.id}`);
      trace(fileNode, file.requirementIds, `file traceability ${file.path}`);
      const containingModule = moduleByFile.get(file.path) ?? (file.path.startsWith("backend/") ? rootModules.backend : rootModules.frontend);
      addEdge("BELONGS_TO", fileNode, containingModule, `generated path ${file.path}`);
      const componentNode = componentByFile.get(file.path);
      if (componentNode) addEdge("BELONGS_TO", componentNode, fileNode, `component source ${file.path}`);
      if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path)) {
        const testNode = addNode("TEST", file.path, file.path, { digest: file.digest });
        addEdge("BELONGS_TO", testNode, fileNode, `test source ${file.path}`);
        trace(testNode, file.requirementIds, `test traceability ${file.path}`, "TESTS");
      }
    }

    for (const [surface, dependencies] of Object.entries(candidate.assembly.dependencies) as Array<["backend" | "frontend", typeof candidate.assembly.dependencies.backend]>) {
      for (const [group, entries] of Object.entries(dependencies) as Array<["runtime" | "development", Readonly<Record<string, string>>]>) {
        for (const [name, version] of Object.entries(entries)) {
          const dependencyNode = addNode("DEPENDENCY", `${surface}:${group}:${name}`, name, { version, surface, group });
          addEdge("DEPENDS_ON", project, dependencyNode, `${surface} ${group} dependency manifest`);
          addEdge("TARGETS", dependencyNode, rootModules[surface], `${surface} package metadata`);
        }
      }
    }

    const graphWithoutIdentity: Omit<EngineeringEvidenceGraph, "id" | "digest"> = {
      contractVersion: ENGINEERING_GRAPH_CONTRACT_VERSION,
      projectId: candidate.projectId,
      candidateId: candidate.id,
      candidateDigest: candidate.assembly.determinism.outputDigest,
      manifestDigest: candidate.manifestDigest,
      validationStatus: validation.status,
      targetProfile: candidate.assembly.target.profile,
      databaseProvider: candidate.assembly.target.database.provider,
      nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
      generatedAt: candidate.generatedAt,
    };
    const graphContentDigest = graphDigest(graphWithoutIdentity);
    const graph: EngineeringEvidenceGraph = {
      ...graphWithoutIdentity,
      id: `engineering_graph_${graphContentDigest.slice(0, 24)}`,
      digest: graphContentDigest,
    };
    verifyEngineeringGraph(graph, candidate);
    return freezeTree(graph);
  }
}
