/**
 * Feature extraction: everything the prompt states *explicitly*, independent
 * of the detected domain. The spec builder later merges these facts with
 * domain defaults — extraction itself never assumes.
 */
import type { ExtractedFeatures } from '../analysis.types.ts';
import type { RequirementEvidence, RequirementEvidenceKind } from '../../../shared/types/requirement.ts';
import {
  AUTH_GENERIC_PHRASES,
  AUTH_LEXICON,
  BACKEND_LEXICON,
  FRONTEND_LEXICON,
  INTEGRATION_LEXICON,
  MODULE_LEXICON,
  ROLE_LEXICON,
  OPERATION_LEXICON,
  FIELD_LEXICON,
} from './lexicon.ts';
import type { LexiconEntry } from './lexicon.ts';
import { dedupe, phraseMentions } from './normalize.ts';

function matchLexicon(
  prompt: string,
  lexicon: readonly LexiconEntry[],
  kind: RequirementEvidenceKind,
  evidence: RequirementEvidence[],
): string[] {
  const labels: string[] = [];
  for (const entry of lexicon) {
    const mentions = phraseMentions(prompt, entry.phrases, kind === 'operation' ? [] : OPERATION_LEXICON.flatMap(item => [...item.phrases]));
    evidence.push(...mentions.map(mention => ({ ...mention, kind, label: entry.label })));
    if (mentions.some(item => item.polarity === 'included') && !mentions.some(item => item.polarity === 'excluded')) {
      labels.push(entry.label);
    }
  }
  return labels;
}

export function extractFeatures(prompt: string): ExtractedFeatures {
  const evidence: RequirementEvidence[] = [];

  const authMethods = matchLexicon(prompt, AUTH_LEXICON, 'authentication', evidence);
  const genericAuth = matchLexicon(prompt, [{ label: 'Authentication', phrases: AUTH_GENERIC_PHRASES }], 'module', evidence);

  const roles = matchLexicon(prompt, ROLE_LEXICON, 'role', evidence);
  const modules = matchLexicon(prompt, MODULE_LEXICON, 'module', evidence);
  const integrations = matchLexicon(prompt, INTEGRATION_LEXICON, 'integration', evidence);
  const backend = matchLexicon(prompt, BACKEND_LEXICON, 'backend', evidence);
  const frontend = matchLexicon(prompt, FRONTEND_LEXICON, 'frontend', evidence);
  matchLexicon(prompt, OPERATION_LEXICON, 'operation', evidence);
  matchLexicon(prompt, FIELD_LEXICON, 'field', evidence);

  return {
    roles,
    modules,
    authNeeded: genericAuth.length > 0 || authMethods.length > 0,
    authMethods,
    integrations,
    backend,
    frontend,
    signals: dedupe(evidence.filter(item => item.polarity === 'included' && !evidence.some(other => other.kind === item.kind && other.label === item.label && other.polarity === 'excluded')).map(item => item.phrase)),
    evidence,
  };
}
