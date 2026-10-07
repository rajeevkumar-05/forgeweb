import type { EntityPlan } from './upstream/shared/types/architecture.ts';
import type { RequirementSpec, SemanticDesign, SemanticOperation, SemanticSource } from './upstream/shared/types/requirement.ts';
import { EXCLUSION_LINKS, MODULE_LEXICON } from './upstream/modules/analysis/lib/lexicon.ts';
import { camelCase } from './upstream/shared/utils/strings.ts';

const ACTIONS: Readonly<Record<string, SemanticOperation['action']>> = {
  create: 'create', read: 'read', list: 'read', view: 'read', edit: 'update', update: 'update', delete: 'delete',
};

/** Enrich structured facts only; no prompt parsing or business-column emission. */
export function semanticDesign(spec: RequirementSpec, plannedEntities: readonly EntityPlan[]): SemanticDesign {
  if (spec.semantics?.design) return structuredClone(spec.semantics.design);
  const facts = spec.semantics;
  const source = (kind: string, label: string): SemanticSource => facts?.evidence.some(item => item.kind === kind && item.label === label && item.polarity === 'included') ? 'known' : 'inferred';
  const modules = spec.modules.map(name => {
    const entities = (MODULE_LEXICON.find(item => item.label === name)?.entities ?? [name]).filter(entity => spec.database.includes(entity));
    const entity = entities.includes(name) ? name : entities.length === 1 ? entities[0] : undefined;
    return { name, ...(entity ? { entity } : {}), entities, source: source('module', name) };
  });
  const modulesFor = (entity: string) => modules.filter(module => module.entities.includes(entity)).map(module => module.name);
  const exclusions: SemanticDesign['exclusions'] = (facts?.exclusions ?? []).map(item => ({ kind: item.kind, name: item.label, ...(item.modules ? { modules: [...item.modules] } : {}), source: 'known' }));
  for (const link of EXCLUSION_LINKS) {
    if (!facts?.exclusions.some(item => item.kind === link.kind && item.label === link.label)) continue;
    for (const [kind, names] of [['entity', link.entities], ['module', link.modules], ['integration', link.integrations]] as const) {
      for (const name of names) if (!exclusions.some(item => item.kind === kind && item.name === name)) exclusions.push({ kind, name, source: 'inferred' });
    }
  }
  const capabilities: SemanticDesign['capabilities'] = [];
  for (const [kind, values] of [['integration', spec.integrations], ['authentication', spec.authentication], ['backend', spec.backend], ['frontend', spec.frontend]] as const) {
    for (const name of values) capabilities.push({ kind, name, intent: 'requested', source: source(kind, name), support: kind === 'integration' ? 'unsupported' : 'unverified' });
    for (const item of exclusions.filter(item => item.kind === kind)) capabilities.push({ kind, name: item.name, intent: 'excluded', source: item.source, support: 'unsupported' });
  }
  return {
    version: 'nexarch-semantic-design-v1', projectType: spec.projectType,
    roles: spec.roles.map(name => ({ name, source: source('role', name) })), modules, capabilities, exclusions,
    entities: spec.database.map(name => {
      const scopes = modulesFor(name);
      const requested = (facts?.operations ?? []).filter(item => item.modules.some(module => scopes.includes(module)));
      const denied = (facts?.exclusions ?? []).filter(item => item.kind === 'operation' && item.modules?.some(module => scopes.includes(module)));
      const needsRead = requested.some(item => ACTIONS[item.action] === 'update')
        && !requested.some(item => ACTIONS[item.action] === 'read')
        && !denied.some(item => ACTIONS[item.label] === 'read');
      return {
        name,
        fields: (facts?.fields ?? []).filter(item => item.modules.some(module => scopes.includes(module))).map(item => ({ name: camelCase(item.name), label: item.name, source: 'known' as const })),
        relationships: (plannedEntities.find(entity => entity.name === name)?.relations ?? []).map(relation => ({ target: relation.target, field: camelCase(relation.foreignKey), kind: relation.type, source: 'inferred' as const })),
        operations: [
          ...requested.map(item => ({ name: item.action, action: ACTIONS[item.action] ?? 'domain', intent: 'requested' as const, source: 'known' as const, support: ACTIONS[item.action] ? 'unverified' as const : 'unsupported' as const })),
          ...(needsRead ? [{ name: 'read', action: 'read' as const, intent: 'requested' as const, source: 'inferred' as const, support: 'unverified' as const }] : []),
          ...denied.map(item => ({ name: item.label, action: ACTIONS[item.label] ?? 'domain', intent: 'excluded' as const, source: 'known' as const, support: 'unsupported' as const })),
        ],
        operationPolicy: requested.length || denied.length ? 'explicit' as const : 'unspecified' as const,
      };
    }),
  };
}
