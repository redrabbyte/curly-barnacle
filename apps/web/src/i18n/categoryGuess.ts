import { CATEGORY_WORDS, type Guessable } from './categoryWords';

/**
 * Guessing a category from what the entry is called.
 *
 * The server never sees an expense, so nothing but the device can do this;
 * and since it runs on every keystroke of the description field, it has to be
 * a few thousand string comparisons rather than anything cleverer. That is
 * enough: names in this app are two or three words ("Pizza", "Rewe Einkauf",
 * "Taxi zum Flughafen"), and a word list plus a typo allowance reads them well.
 *
 * The result is only ever a *suggestion*. It fills the dropdown for an entry
 * nobody has categorised, and stops the moment somebody picks for themselves —
 * so the cost of a wrong guess is one dropdown change, and the cost of no
 * guess is what the app did before. That budget is what the thresholds below
 * are set against: guess readily, but never when two categories fit equally.
 */

/** Lowercase, drop accents, and spell ß out, so "Frühstück" meets "fruhstuck". */
const fold = (text: string): string =>
  text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');

/** The words of a name, punctuation and amounts of whitespace forgotten. */
const words = (text: string): string[] => fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * How far off a word may be and still count.
 *
 * Nothing for a short word: at four characters a single edit is the distance
 * between unrelated words ("bar" and "car", "meal" and "meat"), and a typo
 * allowance there would guess more often than it guessed right. Longer words
 * have room, and get a second edit at eight — "restaurent" and "abendesen"
 * are the mistakes this is here for.
 */
const typoBudget = (word: string): number => (word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0);

/**
 * Optimal string alignment distance, giving up once the budget is blown.
 *
 * Levenshtein plus transposition, because swapped letters ("piza" → "pzia")
 * are the most common typo of all and plain Levenshtein charges two for them.
 * The early exits matter: this runs for every word of every category on every
 * keystroke, and almost every pair is nowhere near a match.
 */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let beforePrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1);
    row[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      let cost = Math.min(prev[j]! + 1, row[j - 1]! + 1, substitution);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cost = Math.min(cost, beforePrev[j - 2]! + 1);
      }
      row[j] = cost;
      if (cost < best) best = cost;
    }
    // Every alignment through this row already costs more than the budget, and
    // the rows below can only add to it.
    if (best > max) return max + 1;
    beforePrev = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/** How well a list word matches the piece of the name it was lined up with, 0 if not at all. */
function quality(word: string, candidate: string): number {
  if (word === candidate) return 1;

  // German writes a whole family of expenses as one word — Stromrechnung,
  // Abendessen, Mietvertrag — and the stem is what identifies them. Below five
  // characters a stem is noise rather than evidence, though: "uber" sits
  // inside "Überweisung" and "eis" inside "Reise".
  if (word.length >= 5 && candidate.includes(word)) return 0.85;

  const budget = typoBudget(word);
  if (budget === 0) return 0;
  const off = distance(word, candidate, budget);
  return off > budget ? 0 : 1 - 0.25 * off;
}

/**
 * What a match is worth. A long word is specific and a short one is not, so
 * "restaurant" carries a full point where "bar" carries half of one — which is
 * also exactly the threshold, so a name that is nothing but a short word still
 * gets its category, and a short word inside a longer name needs company.
 */
const weight = (word: string): number => Math.min(word.length, 6) / 6;

/** A stretch of the name that a list word matched, and what that match is worth. */
interface Match {
  from: number;
  to: number;
  points: number;
}

/**
 * What a name is worth to one category: its matches, counting each word of the
 * name once.
 *
 * Taking the best match for a word and then moving on is what keeps a category
 * from scoring twice on one word — the two languages share "pizza", and
 * "Supermarkt" holds both "markt" and "supermarkt". It is also why the score
 * grows with how much of the name a category explains, rather than with how
 * many ways it can explain the same word.
 */
function score(nameWords: string[], categoryWords: readonly string[]): number {
  const matches: Match[] = [];
  for (const word of categoryWords) {
    const span = word.split(' ').length;
    const value = weight(word);
    for (let i = 0; i + span <= nameWords.length; i++) {
      const q = quality(word, nameWords.slice(i, i + span).join(' '));
      if (q > 0) matches.push({ from: i, to: i + span, points: q * value });
    }
  }

  matches.sort((a, b) => b.points - a.points);
  const taken = new Set<number>();
  let total = 0;
  for (const match of matches) {
    let free = true;
    for (let i = match.from; i < match.to; i++) if (taken.has(i)) free = false;
    if (!free) continue;
    for (let i = match.from; i < match.to; i++) taken.add(i);
    total += match.points;
  }
  return total;
}

/** Half a point: one short word matched exactly, or one long word with a typo. */
export const GUESS_THRESHOLD = 0.5;

/** The words of every language at once, each category's list free of repeats. */
const WORDS: Record<Guessable, string[]> = (() => {
  const merged = {} as Record<Guessable, string[]>;
  for (const perCategory of Object.values(CATEGORY_WORDS)) {
    for (const [category, list] of Object.entries(perCategory) as [Guessable, readonly string[]][]) {
      const seen = (merged[category] ??= []);
      for (const word of list) {
        const folded = words(word).join(' ');
        if (folded && !seen.includes(folded)) seen.push(folded);
      }
    }
  }
  return merged;
})();

/**
 * The category a name reads as, or null for one that reads as nothing in
 * particular — which is what 'other' is for.
 *
 * A tie is also null. Two categories that fit a name equally well ("Kino und
 * Pizza") make the pick a coin flip, and a coin flip is worse than leaving the
 * dropdown where the reader will look at it anyway.
 */
export function guessCategory(name: string): Guessable | null {
  const nameWords = words(name);
  if (nameWords.length === 0) return null;

  let best: Guessable | null = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const [category, list] of Object.entries(WORDS) as [Guessable, string[]][]) {
    const points = score(nameWords, list);
    if (points > bestScore) {
      runnerUp = bestScore;
      bestScore = points;
      best = category;
    } else if (points > runnerUp) {
      runnerUp = points;
    }
  }

  if (bestScore < GUESS_THRESHOLD) return null;
  return bestScore - runnerUp > 1e-9 ? best : null;
}
