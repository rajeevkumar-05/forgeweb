/**
 * The pipeline contract between the Requirement Analyzer (producer) and the
 * Architecture Planner (consumer). Lives in shared/ because module islands
 * never import each other's internals — stage contracts are shared types.
 */
export type RequirementEvidenceKind = 'role' | 'module' | 'authentication' | 'integration' | 'backend' | 'frontend' | 'operation' | 'field';

export interface RequirementEvidence {
  kind: RequirementEvidenceKind;
  label: string;
  phrase: string;
  clause: string;
  polarity: 'included' | 'excluded';
  /** Explicit field-declaration subject, retained across its bullet list. */
  fieldContext?: string;
}

export interface RequirementSemantics {
  operations: { action: string; modules: string[] }[];
  fields: { name: string; modules: string[] }[];
  exclusions: { kind: RequirementEvidenceKind; label: string; modules?: string[] }[];
  evidence: RequirementEvidence[];
  /** Optional downstream design facts; absence preserves the legacy contract. */
  design?: SemanticDesign;
}

export type SemanticSource = 'known' | 'inferred';
export type SemanticSupport = 'unverified' | 'unsupported';
export interface SemanticField {
  name: string;
  label?: string;
  description?: string;
  source: SemanticSource;
  /** Omitted means unknown, not an assumed string/required/searchable field. */
  category?: 'string' | 'text' | 'number' | 'boolean' | 'date' | 'timestamp' | 'enum' | 'json' | 'relation';
  required?: boolean;
  searchable?: boolean;
  relationTarget?: string;
}
export interface SemanticOperation {
  name: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'domain';
  intent: 'requested' | 'excluded';
  source: SemanticSource;
  support: SemanticSupport;
}
export interface SemanticEntity {
  name: string;
  description?: string;
  fields: SemanticField[];
  relationships: { target: string; field?: string; kind?: 'many-to-one' | 'one-to-one'; source: SemanticSource }[];
  operations: SemanticOperation[];
  /** An empty unspecified list is not an explicit read-only/no-operation policy. */
  operationPolicy: 'explicit' | 'unspecified';
}
export interface SemanticDesign {
  version: 'nexarch-semantic-design-v1';
  projectType: string;
  roles: { name: string; source: SemanticSource }[];
  modules: { name: string; entity?: string; entities: string[]; source: SemanticSource }[];
  entities: SemanticEntity[];
  /** Missing entries mean not requested; exclusions are never positive support. */
  capabilities: {
    kind: 'integration' | 'authentication' | 'backend' | 'frontend';
    name: string;
    intent: 'requested' | 'excluded';
    source: SemanticSource;
    support: SemanticSupport;
  }[];
  exclusions: { kind: RequirementEvidenceKind | 'entity'; name: string; modules?: string[]; source: SemanticSource }[];
}

export interface RequirementSpec {
  projectName: string;
  projectType: string;
  roles: string[];
  modules: string[];
  frontend: string[];
  backend: string[];
  database: string[];
  authentication: string[];
  integrations: string[];
  /** Features the domain usually needs that the prompt never mentioned. */
  missingRequirements: string[];
  /** Explicit prompt facts, distinct from domain defaults. Exclusions win conflicts. */
  semantics?: RequirementSemantics;

  /* ── Planning-mesh detail ───────────────────────────────────────────
   *
   * Every field below is optional, and deliberately so. The deterministic
   * pipeline reads only the fields above and must keep working unchanged;
   * the Requirement Analyst agent fills these in as well, so the planning
   * mesh has the depth it needs without the legacy contract breaking.
   */

  /** One sentence: what this product is for. */
  goal?: string;
  /** Capabilities the system must provide, in the user's terms. */
  functionalRequirements?: string[];
  /** Qualities it must have — performance, availability, compliance. */
  nonFunctionalRequirements?: string[];
  /** Limits the solution must respect. */
  constraints?: string[];
  /** What was taken as given because the request did not say. */
  assumptions?: string[];
  securityRequirements?: string[];
  /** Testable statements of done. */
  acceptanceCriteria?: string[];
}
