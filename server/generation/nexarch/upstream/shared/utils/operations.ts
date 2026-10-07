import type { SemanticEntity } from '../types/requirement.ts';

export type CrudOperation = 'create' | 'read' | 'update' | 'delete';
const CRUD: readonly CrudOperation[] = ['create', 'read', 'update', 'delete'];

/** Legacy/unspecified contracts keep CRUD; explicit intent is a whitelist. */
export function crudOperations(entity?: { readonly operationPolicy: SemanticEntity['operationPolicy']; readonly operations: readonly SemanticEntity['operations'][number][] }): CrudOperation[] {
  const requested = entity?.operations.filter(operation => operation.intent === 'requested') ?? [];
  return CRUD.filter(action =>
    !entity?.operations.some(operation => operation.action === action && operation.intent === 'excluded')
    && (!entity || entity.operationPolicy === 'unspecified'
      || (requested.length === 0 && entity.operations.some(operation => operation.intent === 'excluded'))
      || requested.some(operation => operation.action === action)),
  );
}

export function operationForMethod(method: string): CrudOperation {
  switch (method.toUpperCase()) {
    case 'GET': return 'read';
    case 'POST': return 'create';
    case 'DELETE': return 'delete';
    default: return 'update';
  }
}
