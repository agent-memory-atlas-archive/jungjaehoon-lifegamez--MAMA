/**
 * What a search query is asking for.
 *
 * The classifier is a mechanism: an ordered list of patterns, first match wins. The
 * WORDS are not. Two of them named connectors that one deployment happens to run,
 * which told every other product installing this core that asking about that
 * connector is asking about an artifact, whether or not it has one.
 *
 * So the words are injectable. The default below carries only words that name no
 * product: what a file is, what a date is, what asking "why" looks like. A caller
 * with its own domain adds to it.
 */
export type QuestionType =
  | 'correction'
  | 'artifact'
  | 'timeline'
  | 'status'
  | 'decision_reason'
  | 'how_to'
  | 'unknown';

export const QUESTION_TYPES: readonly QuestionType[] = [
  'correction',
  'artifact',
  'timeline',
  'status',
  'decision_reason',
  'how_to',
  'unknown',
];

/** One question type and the pattern that names it. Order is the precedence. */
export interface QuestionPattern {
  readonly type: Exclude<QuestionType, 'unknown'>;
  readonly pattern: RegExp;
}

export type QuestionVocabulary = readonly QuestionPattern[];

// Korean: patterns for classifyQuestionType() multilingual query routing.
// A language is not a product: these words name no deployment, no connector and no
// package. Domain words belong in a caller's vocabulary, not here.
export const DEFAULT_QUESTION_VOCABULARY: QuestionVocabulary = [
  {
    type: 'correction',
    pattern:
      /\b(fix|revert|correct|correction|supersede|superseded|revise|revision)\b|수정|되돌|정정|교정/i,
  },
  {
    type: 'artifact',
    pattern:
      /\b(file|doc|docs|document|image|video|pdf|attachment|artifact)\b|파일|문서|이미지|영상|첨부/i,
  },
  {
    type: 'timeline',
    pattern:
      /\b(when|history|before|after|around|timeline|chronology)\b|언제|이력|히스토리|(?:^|\s)(?:전|후)(?=$|\s|[?.!,]|에|의|로|부터|까지|는|를|가|와|도)|즈음|\bon\s+\d{4}(?:-\d{1,2})?(?:-\d{1,2})?\b|\b\d{4}-\d{1,2}-\d{1,2}\b/i,
  },
  {
    type: 'status',
    pattern:
      /\b(status|state|current|currently|now|latest|progress|blocked|done)\b|상태|현재|최신|진행|진척/i,
  },
  { type: 'decision_reason', pattern: /\b(why|reason|because|rationale)\b|근거|이유|왜|때문/i },
  {
    type: 'how_to',
    pattern:
      /\b(how\s+to|how\s+do|setup|set\s+up|configure|configuration|install)\b|설정|구성|어떻게/i,
  },
];

let vocabulary: QuestionVocabulary = DEFAULT_QUESTION_VOCABULARY;

/**
 * Declare the words this deployment asks questions with. Call once, at boot.
 *
 * Replaces the default outright rather than merging: a caller that wants the general
 * words plus its own spreads DEFAULT_QUESTION_VOCABULARY itself, and can see in one
 * place what its classifier actually knows.
 */
export function declareQuestionVocabulary(next: QuestionVocabulary): void {
  vocabulary = next;
}

/** Restore the default. For tests that declared their own. */
export function resetQuestionVocabulary(): void {
  vocabulary = DEFAULT_QUESTION_VOCABULARY;
}

export function classifyQuestionType(query: string): QuestionType {
  const normalized = query.trim();
  for (const entry of vocabulary) {
    if (entry.pattern.test(normalized)) {
      return entry.type;
    }
  }
  return 'unknown';
}

export function isQuestionType(value: string): value is QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value);
}
