/**
 * JSON generator: merges domain defaults with the facts extracted from the
 * prompt into the final RequirementSpec. Merge policy is always
 * "profile first, prompt additions after, no duplicates" so output stays
 * stable and predictable for the Architecture Planner downstream.
 */
import type { ExtractedFeatures, RequirementSpec } from '../analysis.types.ts';
import type { DomainProfile } from './knowledge-base.ts';
import { EXCLUSION_LINKS, FIELD_LEXICON, MODULE_LEXICON } from './lexicon.ts';
import { containsPhrase, dedupe, singularize, titleCase } from './normalize.ts';

/** Modules that are platform chrome rather than data domains. */
const NON_DATA_MODULES = new Set([
  'Authentication',
  'Dashboard',
  'Settings',
  'Notifications',
  'Reports',
]);

/** Domains whose product is public-facing enough to need a landing page. */
const LANDING_PAGE_DOMAINS = new Set([
  'ecommerce',
  'portfolio',
  'blog',
  'lms',
  'hotel',
  'restaurant',
]);

const NAME_PATTERN =
  /(?:called|named)\s+"?([a-z0-9][a-z0-9 _-]{1,40}?)"?(?:[.,]|\s+(?:with|that|which|for)\b|$)/i;

function extractProjectName(rawPrompt: string): string | null {
  const match = NAME_PATTERN.exec(rawPrompt);
  const candidate = match?.[1]?.trim();
  return candidate ? titleCase(candidate) : null;
}

function entitiesForModules(moduleLabels: readonly string[]): string[] {
  const entities: string[] = [];
  for (const label of moduleLabels) {
    const entry = MODULE_LEXICON.find((candidate) => candidate.label === label);
    if (entry) entities.push(...entry.entities);
  }
  return entities;
}

function buildAuthentication(features: ExtractedFeatures, roleCount: number): string[] {
  const auth = [...features.authMethods];
  // Sensible platform defaults when auth is needed but unspecified.
  if (auth.length === 0) auth.push('JWT', 'Email Login');
  if (!auth.includes('JWT') && !auth.includes('OAuth')) auth.unshift('JWT');
  if (roleCount > 1 && !auth.includes('RBAC')) auth.push('RBAC');
  return dedupe(auth);
}

function buildFrontend(
  profile: DomainProfile | null,
  modules: readonly string[],
  features: ExtractedFeatures,
): string[] {
  const pages: string[] = [];
  if (profile && LANDING_PAGE_DOMAINS.has(profile.id)) pages.push('Landing Page');
  pages.push('Dashboard');
  pages.push(...modules.filter((module) => !NON_DATA_MODULES.has(module)));
  if (
    modules.includes('Reports') ||
    modules.includes('Analytics') ||
    features.frontend.includes('Charts')
  ) {
    pages.push('Reports & Charts');
  }
  pages.push('Settings');
  return dedupe(pages);
}

function buildBackend(modules: readonly string[], features: ExtractedFeatures): string[] {
  const apis: string[] = ['Auth API'];
  for (const module of modules) {
    if (NON_DATA_MODULES.has(module)) continue;
    apis.push(`${singularize(module)} API`);
  }
  if (modules.includes('Reports') || features.backend.includes('Reports API')) {
    apis.push('Reports API');
  }
  if (features.integrations.includes('File Upload')) apis.push('File Upload API');
  if (features.backend.includes('Search')) apis.push('Search API');
  apis.push('Filtering & Pagination');
  return dedupe(apis);
}

function buildMissingRequirements(
  profile: DomainProfile | null,
  normalizedPrompt: string,
): string[] {
  if (!profile) return [];
  return profile.expected
    .filter(
      (feature) => !feature.coveredBy.some((phrase) => containsPhrase(normalizedPrompt, phrase)),
    )
    .map((feature) => feature.label);
}

export function buildSpec(
  rawPrompt: string,
  normalizedPrompt: string,
  profile: DomainProfile | null,
  features: ExtractedFeatures,
): RequirementSpec {
  const evidence = features.evidence;
  const exclusions = evidence.filter(item => item.polarity === 'excluded')
    .filter((item, index, items) => items.findIndex(other => other.kind === item.kind && other.label === item.label) === index)
    .map(({ kind, label }) => ({ kind, label }));
  const excluded = (kind: typeof exclusions[number]['kind'], label: string) => exclusions.some(item => item.kind === kind && item.label === label);
  const links = EXCLUSION_LINKS.filter(link => excluded(link.kind, link.label));
  const excludedModules = new Set([...exclusions.filter(item => item.kind === 'module').map(item => item.label), ...links.flatMap(link => [...link.modules])]);
  const excludedEntities = new Set([...entitiesForModules([...excludedModules]), ...links.flatMap(link => [...link.entities])]);
  const excludedIntegrations = new Set([...exclusions.filter(item => item.kind === 'integration').map(item => item.label), ...links.flatMap(link => [...link.integrations])]);
  // Domain roles and explicitly-mentioned roles are unioned: "with vendors"
  // extends the e-commerce defaults rather than replacing them, and a
  // mention of "admin dashboard" can never collapse the spec to Admin-only.
  const roles = dedupe([
    'Admin',
    ...(profile?.roles ?? (features.roles.length > 0 ? [] : ['User'])),
    ...features.roles,
  ]).filter(role => !excluded('role', role));

  const modules = dedupe([
    'Authentication',
    ...(profile?.modules ?? ['Dashboard', 'Users', 'Settings']),
    ...features.modules,
  ]).filter(module => !excludedModules.has(module));

  const database = dedupe([
    'Users',
    ...(profile?.entities ?? []),
    ...entitiesForModules(features.modules),
  ]).filter(entity => !excludedEntities.has(entity));

  const integrations = dedupe([...features.integrations, ...(profile?.integrations ?? [])]).filter(integration => !excludedIntegrations.has(integration));
  const dataModules = modules.filter(module => !NON_DATA_MODULES.has(module));
  const facts = (kind: 'operation' | 'field') => evidence.filter(item => item.kind === kind && item.polarity === 'included');
  const scopeFor = (clause: string) => {
    const explicit = MODULE_LEXICON.filter(entry => dataModules.includes(entry.label) && entry.phrases.some(phrase => containsPhrase(clause, phrase))).map(entry => entry.label);
    return explicit.length ? explicit : dataModules.filter(module => module !== 'Users');
  };
  const scopeForFact = (fact: typeof evidence[number]) => {
    if (fact.kind !== 'operation') return scopeFor(fact.clause);
    const object = fact.clause.slice(fact.clause.indexOf(fact.phrase) + fact.phrase.length).split(/\b(?:with|for|in|to|from|by)\b/)[0];
    const targets = MODULE_LEXICON.filter(entry => dataModules.includes(entry.label) && entry.phrases.some(phrase => containsPhrase(object, phrase))).map(entry => entry.label);
    return targets.length ? targets : scopeFor(fact.clause);
  };
  const denied = (kind: 'operation' | 'field', label: string, module: string) => evidence.some(item => item.kind === kind && item.label === label && item.polarity === 'excluded' && scopeForFact(item).includes(module));
  const operations = [...new Set(facts('operation').map(item => item.label))].map(action => ({
    action, modules: dedupe(facts('operation').filter(item => item.label === action).flatMap(scopeForFact)).filter(module => !denied('operation', action, module)),
  })).filter(item => item.modules.length);
  const fields = [...new Set(facts('field').map(item => item.label))].map(name => ({
    name, modules: dedupe(facts('field').filter(item => item.label === name).flatMap(item => scopeFor(item.clause)))
      .filter(module => FIELD_LEXICON.find(entry => entry.label === name)?.modules.includes(module) && !denied('field', name, module)),
  })).filter(item => item.modules.length);
  const scopedExclusions = exclusions.map(item => item.kind === 'operation' || item.kind === 'field'
    ? { ...item, modules: dedupe(evidence.filter(fact => fact.kind === item.kind && fact.label === item.label && fact.polarity === 'excluded').flatMap(scopeForFact)) }
    : item);
  const functionalRequirements = [
    ...operations.map(item => `${item.modules.join(', ')}: ${item.action}.`),
    ...fields.map(item => `${item.modules.join(', ')} field: ${item.name}.`),
    `Roles: ${roles.join(', ')}.`,
    ...integrations.map(integration => `Integration: ${integration}.`),
    ...features.backend.map(feature => `Backend capability: ${feature}.`),
    ...features.frontend.map(feature => `Frontend capability: ${feature}.`),
  ];
  const constraints = scopedExclusions.map(item => `Exclude ${item.kind}: ${item.label}${'modules' in item ? ` (${item.modules.join(', ')})` : ''}.`);

  return {
    projectName: extractProjectName(rawPrompt) ?? profile?.defaultName ?? 'Custom Application',
    projectType: profile?.type ?? 'Custom',
    roles,
    modules,
    frontend: buildFrontend(profile, modules, features),
    backend: buildBackend(modules, features),
    database,
    authentication: buildAuthentication(features, roles.length),
    integrations,
    missingRequirements: buildMissingRequirements(profile, normalizedPrompt).filter(label => !excludedIntegrations.has(label) && !excludedModules.has(label)),
    semantics: { operations, fields, exclusions: scopedExclusions, evidence },
    functionalRequirements,
    constraints,
    acceptanceCriteria: [...functionalRequirements, ...constraints],
  };
}
