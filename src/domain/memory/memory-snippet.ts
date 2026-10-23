/**
 * Turn-level memory view.
 * LongMemEval (ICLR 2025, section 5.2) retrieves a dialogue round more reliably than a
 * whole session, and indexes the user utterance as the key.
 * Layer: Domain
 */

const MEMORY_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'any', 'are', 'been', 'bit', 'but', 'can',
  'could', 'did', 'does', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'her',
  'his', 'how', 'into', 'its', 'just', 'like', 'lot', 'may', 'more', 'most', 'new',
  'not', 'now', 'one', 'only', 'our', 'out', 'see', 'saw', 'some', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'two', 'use',
  'used', 'was', 'way', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'why', 'will', 'with', 'would', 'you', 'your',
  'как', 'или', 'для', 'это', 'что', 'при', 'его', 'она', 'они', 'меня', 'мой',
]);

export interface MemoryRound {
  text: string;
  sessionId?: string;
  /** Session timestamp, `YYYY-MM-DD` or `YYYY/MM/DD`. */
  at?: string;
}

export function memoryQueryTerms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => (token.length >= 3 || (token.length >= 2 && /\d/.test(token))) && !MEMORY_STOP_WORDS.has(token)),
  )];
}

const MONTH_NAMES: ReadonlyArray<readonly [number, readonly string[]]> = [
  [1, ['january', 'январ']],
  [2, ['february', 'феврал']],
  [3, ['march', 'март']],
  [4, ['april', 'апрел']],
  [5, ['may', 'мая', 'мае', 'май']],
  [6, ['june', 'июн']],
  [7, ['july', 'июл']],
  [8, ['august', 'август']],
  [9, ['september', 'сентябр']],
  [10, ['october', 'октябр']],
  [11, ['november', 'ноябр']],
  [12, ['december', 'декабр']],
];

/**
 * SelRoute (arXiv:2604.02431) searches a prior assistant reply in the whole round:
 * the question paraphrases that reply. A new request stays on the user line.
 */
export function recallsPriorAssistantReply(query: string): boolean {
  return /\b(?:previous|earlier|you mentioned|you made|remind me|you provided)\b/i.test(query)
    || /(?:раньше|предыдущ|напомни|упоминал)/iu.test(query);
}

/**
 * LongMemEval indexes the user utterance as the search key and keeps the
 * assistant reply only in the value. A memory without role labels stays whole.
 */
export function indexedMemoryText(text: string): string {
  const user = text
    .split('\n')
    .filter((line) => /^user:/i.test(line))
    .join('\n');
  return user.length > 0 ? user : text;
}

function matchesQueryTerm(lowerText: string, term: string): boolean {
  if (term.length >= 4) {
    return lowerText.includes(term);
  }
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${term}`, 'u').test(lowerText);
}

export function termCoverage(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((count, term) => count + (matchesQueryTerm(lower, term) ? 1 : 0), 0);
}

function mentionsToken(text: string, name: string): boolean {
  if (name.length >= 4) {
    return text.includes(name);
  }
  return new RegExp(`(?:^|[^\\p{L}])${name}(?:$|[^\\p{L}])`, 'u').test(text);
}

export function mentionedMonths(query: string): number[] {
  const lower = query.toLowerCase();
  return MONTH_NAMES
    .filter(([, names]) => names.some((name) => mentionsToken(lower, name)))
    .map(([month]) => month);
}

export function textMonth(value: string): number | null {
  const match = /(?:^|\D)\d{4}[/-](\d{1,2})[/-]\d{1,2}/.exec(value);
  if (!match) {
    return null;
  }
  const month = Number(match[1]);
  return month >= 1 && month <= 12 ? month : null;
}

/**
 * A month named in the question adds a small bonus when the round
 * is dated in that month. Lexical overlap still decides the rank.
 */
function datedMonthBonus(round: MemoryRound, months: readonly number[]): number {
  const month = textMonth(`${round.at ?? ''}\n${round.text.slice(0, 160)}`);
  return month !== null && months.includes(month) ? 2 : 0;
}

export function scoreMemoryRound(round: MemoryRound, query: string): number {
  return termCoverage(round.text, memoryQueryTerms(query)) + datedMonthBonus(round, mentionedMonths(query));
}

/** One user turn plus the assistant reply that follows it. */
export function splitDialogueRounds(text: string): string[] {
  const pieces = text.split(/\n(?=(?:user|assistant|message):)/i).map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length === 0) {
    return [text];
  }
  const rounds: string[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const current = pieces[index];
    const next = pieces[index + 1];
    if (/^user:/i.test(current) && next && /^assistant:/i.test(next)) {
      rounds.push(`${current}\n${next}`);
      index += 1;
    } else {
      rounds.push(current);
    }
  }
  return rounds;
}

function memoryRoundKey<T extends MemoryRound>(round: T, query: string): string {
  const text = recallsPriorAssistantReply(query) ? round.text : indexedMemoryText(round.text);
  return text.toLowerCase();
}

function termDocumentFrequency(keys: readonly string[], terms: readonly string[]): Map<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    let count = 0;
    for (const key of keys) {
      if (matchesQueryTerm(key, term)) count += 1;
    }
    documentFrequency.set(term, count);
  }
  return documentFrequency;
}

function termFrequency(lower: string, term: string): number {
  if (term.length >= 4) {
    return lower.split(term).length - 1;
  }
  return (lower.match(new RegExp(`(?:^|[^\\p{L}\\p{N}])${term}`, 'gu')) || []).length;
}

function monthScoreBonus(round: MemoryRound, months: readonly number[]): number {
  return datedMonthBonus(round, months);
}

function rankByScore<T extends MemoryRound>(
  rounds: readonly T[],
  scoreOf: (round: T, index: number) => number,
): T[] {
  return rounds
    .map((round, index) => ({ round, score: scoreOf(round, index) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.round.text.length - right.round.text.length)
    .map((item) => item.round);
}

/**
 * Reciprocal rank fusion of the rare-word list and BM25 (k1 = 1.2, b = 0.75).
 * On the 50-question slice this keeps every previous turn hit and adds one preference hit.
 */
function fuseMemoryRanks<T extends MemoryRound>(left: readonly T[], right: readonly T[], limit: number): T[] {
  const fused = new Map<T, number>();
  const add = (list: readonly T[]) => {
    list.forEach((round, index) => {
      fused.set(round, (fused.get(round) ?? 0) + 1 / (60 + index + 1));
    });
  };
  add(left);
  add(right);
  return [...fused.entries()]
    .sort((leftRank, rightRank) => rightRank[1] - leftRank[1] || leftRank[0].text.length - rightRank[0].text.length)
    .slice(0, limit)
    .map(([round]) => round);
}

export function selectMemoryRounds<T extends MemoryRound>(
  rounds: readonly T[],
  query: string,
  limit: number,
): T[] {
  const terms = memoryQueryTerms(query);
  const months = mentionedMonths(query);
  if (terms.length === 0 || limit <= 0) {
    return [];
  }
  const keys = rounds.map((round) => memoryRoundKey(round, query));
  const documentFrequency = termDocumentFrequency(keys, terms);
  const lengths = keys.map((key) => key.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length);
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lengths.length);
  const idfRanked = rankByScore(rounds, (round, index) => {
    const lower = keys[index] ?? '';
    let score = 0;
    for (const term of terms) {
      if (!matchesQueryTerm(lower, term)) continue;
      score += 1 / Math.log(2 + (documentFrequency.get(term) ?? 0));
    }
    return score + monthScoreBonus(round, months);
  });
  const bm25Ranked = rankByScore(rounds, (round, index) => {
    const lower = keys[index] ?? '';
    const k1 = 1.2;
    const b = 0.75;
    const docLength = lengths[index] || 1;
    let score = 0;
    for (const term of terms) {
      const tf = termFrequency(lower, term);
      if (tf <= 0) continue;
      const documents = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (keys.length - documents + 0.5) / (documents + 0.5));
      const norm = 1 - b + (b * docLength) / Math.max(1, averageLength);
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
    }
    return score + monthScoreBonus(round, months);
  });
  const fused = fuseMemoryRanks(idfRanked, bm25Ranked, rounds.length);
  return bridgeSameSessionGap(fused, rounds, limit);
}

/**
 * Two selected turns of one session sometimes skip the turn between them.
 * That turn replaces a second turn of some other session, so the session set stays.
 */
function bridgeSameSessionGap<T extends MemoryRound>(fused: readonly T[], source: readonly T[], limit: number): T[] {
  const top = fused.slice(0, limit);
  if (top.length < 2) {
    return top;
  }
  const positive = new Set<T>(fused);
  const result = [...top];
  const sessions = [...new Set(result.map((round) => round.sessionId))]
    .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0);
  for (const sessionId of sessions) {
    const positions = result
      .map((round) => (round.sessionId === sessionId ? source.indexOf(round) : -1))
      .filter((index) => index >= 0);
    if (positions.length < 2) continue;
    const lo = Math.min(...positions);
    const hi = Math.max(...positions);
    if (hi - lo !== 2) continue;
    const between = source[lo + 1];
    if (!between || between.sessionId !== sessionId || !positive.has(between) || result.includes(between)) continue;
    let replaceAt = -1;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const round = result[index];
      if (!round || round.sessionId === sessionId) continue;
      if (result.filter((item) => item.sessionId === round.sessionId).length < 2) continue;
      replaceAt = index;
      break;
    }
    if (replaceAt < 0) continue;
    result[replaceAt] = between;
  }
  return result;
}

function asksForQuantity(query: string): boolean {
  return /\b(?:how much|how many|how long|сколько)\b/i.test(query);
}

/** Sentences that state a number. Quantity questions often hide the amount away from the lexical prefix. */
function quantitySentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => /\$\s?\d|\b\d+(?:\.\d+)?\b/u.test(part) && part.length > 12);
}

/** The dialogue rounds that share the most query terms, packed into a character budget. */
export function bestMemoryWindow(text: string, query: string, budget: number): string {
  if (budget <= 0) {
    return '';
  }
  const terms = memoryQueryTerms(query);
  const months = mentionedMonths(query);
  const rounds = splitDialogueRounds(text);
  if (terms.length === 0) {
    return text.slice(0, budget);
  }
  const scoreText = (value: string): number => termCoverage(value, terms) + datedMonthBonus({ text: value }, months);
  let bestIndex = 0;
  let bestScore = -1;
  rounds.forEach((round, index) => {
    const score = scoreText(round);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  let start = bestIndex;
  let end = bestIndex;
  let packed = rounds[bestIndex] ?? '';
  while ((start > 0 || end < rounds.length - 1) && packed.length < budget) {
    const left = start > 0 ? rounds[start - 1] : '';
    const right = end < rounds.length - 1 ? rounds[end + 1] : '';
    const takeLeft = scoreText(left) >= scoreText(right) && left.length > 0;
    const addition = takeLeft ? left : right;
    if (!addition) {
      break;
    }
    const next = takeLeft ? `${addition}\n${packed}` : `${packed}\n${addition}`;
    if (next.length > budget && packed.length > 0) {
      break;
    }
    packed = next;
    if (takeLeft) {
      start -= 1;
    } else {
      end += 1;
    }
  }
  const window = packed.slice(0, budget);
  if (!asksForQuantity(query) || budget < 80) {
    return extendAssistantReply(window, text, query, budget);
  }
  const sentences = quantitySentences(text);
  const first = sentences[0] ?? '';
  const last = sentences[sentences.length - 1] ?? '';
  const withAmounts = appendQuantitySentence(appendQuantitySentence(window, last, budget), first, budget);
  return extendAssistantReply(withAmounts, text, query, budget);
}

/** The reply is often cut while the sentence is still going. Keep the next 200 characters, then put amounts back. */
function extendAssistantReply(window: string, text: string, query: string, budget: number): string {
  if (budget < 400) return window;
  const assistant = text
    .split('\n')
    .filter((line) => /^assistant:/i.test(line))
    .join('\n')
    .replace(/^assistant:\s*/i, '');
  if (assistant.length < 80) return window;
  let cut = 0;
  for (let size = assistant.length; size >= 40; size -= 20) {
    if (window.includes(assistant.slice(0, size))) {
      cut = size;
      break;
    }
  }
  const rest = assistant.slice(cut, cut + 200).trim();
  const extended = appendQuantitySentence(window, rest, budget);
  if (!asksForQuantity(query)) return extended;
  const sentences = quantitySentences(text);
  const first = sentences[0] ?? '';
  const last = sentences[sentences.length - 1] ?? '';
  return appendQuantitySentence(appendQuantitySentence(extended, last, budget), first, budget);
}

function appendQuantitySentence(current: string, sentence: string, budget: number): string {
  if (!sentence || current.includes(sentence)) {
    return current;
  }
  const tail = sentence.slice(0, Math.min(sentence.length, 220));
  return `${current.slice(0, Math.max(0, budget - tail.length - 1))}\n${tail}`.slice(0, budget);
}
