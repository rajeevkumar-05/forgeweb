/**
 * Text primitives shared by the detection pipeline. Matching is always done
 * on normalized text with word boundaries — "cart" must not match "cartel".
 */

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\b(can|could|would|should|does|do|is|are|was|were|must|has|have|had|need)n['\u2019]t\b/g, '$1 not')
    .replace(/\bwon't\b/g, 'will not')
    .replace(/\bcan't\b/g, 'can not')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PhraseMention {
  phrase: string;
  clause: string;
  polarity: 'included' | 'excluded';
}

/** Retain sentence/contrast boundaries before ordinary matching discards punctuation. */
export function clauses(text: string): string[] {
  return text
    .replace(/\bnot only\b/gi, 'also')
    .split(/[.!?;:\n]+|\b(?:but|however|yet)\b|,\s*(?=(?:no|not|without)\b)|(?:,\s*|\band\s+)(?=(?:(?:[a-z]+\s+){1,3}(?:can|should|must|will|do|does)\b|(?:must|should|do|does)\s+not\b))/i)
    // Positive verb lists share their trailing object. Split an imperative
    // only when it follows a negative clause and would otherwise inherit it.
    .flatMap(clause => /\b(?:no|not|without|exclude|omit)\b/.test(normalize(clause))
      ? clause.split(/(?:,\s*|\band\s+)(?=(?:send|include|support|enable|create|edit|update|delete|view|assign|track|search)\b)/i)
      : [clause])
    .map(normalize)
    .filter(Boolean);
}

/** Bounded polarity detection, not a general language parser. Keep both sides of conflicts. */
export function phraseMentions(text: string, phrases: readonly string[], negatedPredicates: readonly string[] = []): PhraseMention[] {
  const mentions: PhraseMention[] = [];
  for (const clause of clauses(text)) {
    for (const phrase of phrases) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const expression = new RegExp(`\\b${escaped}\\b`, 'g');
      for (const match of clause.matchAll(expression)) {
        const before = clause.slice(0, match.index);
        const after = clause.slice(match.index + phrase.length);
        const negativeCue = [...before.matchAll(/\b(?:no|not|without|neither|exclude|excluded|excluding|omit|omitting)\b/g)].at(-1);
        const governed = negativeCue && before.slice(negativeCue.index + negativeCue[0].length);
        // "Do not edit recipes" denies editing, not the existence of Recipes.
        const deniesPredicate = governed && negatedPredicates.some(predicate => containsPhrase(governed, predicate));
        const prefixNegative = Boolean(negativeCue && !deniesPredicate);
        const suffixNegative = /^\s+(?:(?:and|or)\s+[a-z ]+\s+)?(?:is|are|was|were|should be|must be)\s+(?:not\s+(?:needed|required|included|supported|wanted)|excluded|unnecessary)\b/.test(after);
        mentions.push({ phrase, clause, polarity: prefixNegative || suffixNegative ? 'excluded' : 'included' });
      }
    }
  }
  return mentions;
}

const regexCache = new Map<string, RegExp>();

function phraseRegex(phrase: string): RegExp {
  let cached = regexCache.get(phrase);
  if (!cached) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cached = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`);
    regexCache.set(phrase, cached);
  }
  return cached;
}

/** Whole-word/phrase containment on already-normalized text. */
export function containsPhrase(normalizedText: string, phrase: string): boolean {
  return phraseRegex(phrase).test(normalizedText);
}

/** First phrase from the list found in the text, or null. */
export function findPhrase(normalizedText: string, phrases: readonly string[]): string | null {
  for (const phrase of phrases) {
    if (containsPhrase(normalizedText, phrase)) return phrase;
  }
  return null;
}

export function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => (word.length > 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word))
    .join(' ');
}

// Generic naming/string helpers live in shared; re-exported here so the
// analysis pipeline keeps a single import surface for text primitives.
export { dedupe, singularize } from '../../../shared/utils/strings.ts';
