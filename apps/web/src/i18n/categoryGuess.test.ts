import { describe, expect, it } from 'vitest';
import { CATEGORY_WORDS, type Guessable } from './categoryWords';
import { guessCategory } from './categoryGuess';

const LISTS = Object.entries(CATEGORY_WORDS) as [string, Record<Guessable, readonly string[]>][];

describe('guessing a category from an expense name', () => {
  it('reads a plain name in either language', () => {
    expect(guessCategory('Pizza')).toBe('food');
    expect(guessCategory('Abendessen')).toBe('food');
    expect(guessCategory('Taxi')).toBe('transport');
    expect(guessCategory('Kino')).toBe('entertainment');
    expect(guessCategory('Hotel Barcelona')).toBe('travel');
    expect(guessCategory('Weekly shop at Lidl')).toBe('groceries');
    expect(guessCategory('Strom')).toBe('utilities');
    expect(guessCategory('Zahnarzt')).toBe('health');
    expect(guessCategory('Miete Januar')).toBe('housing');
    expect(guessCategory('New sneakers')).toBe('shopping');
  });

  /**
   * The reader's language does not decide what a name is written in. A German
   * group books a "flight", an English one shops at "Rewe", and both write
   * "Uber" — so every list is read for every name.
   */
  it('reads one language\'s words in the other language\'s app', () => {
    expect(guessCategory('Bäckerei')).toBe('food');
    expect(guessCategory('Groceries')).toBe('groceries');
    expect(guessCategory('Tankstelle')).toBe('transport');
  });

  it('forgives a typo in a word long enough to have room for one', () => {
    expect(guessCategory('Restaurent')).toBe('food');
    expect(guessCategory('Supermarkt')).toBe('groceries');
    expect(guessCategory('Abendesen')).toBe('food');
    expect(guessCategory('Piza')).toBe('food');
    // Transposed letters, which plain Levenshtein would charge two for and so
    // would refuse at a budget of one.
    expect(guessCategory('Hoetl')).toBe('travel');
    expect(guessCategory('Restaurnat')).toBe('food');
  });

  /**
   * A short word has to be right. One edit away from "bar" is "car", "bus" and
   * "far"; spending the typo allowance there would turn the guess into noise.
   */
  it('holds short words to an exact match', () => {
    expect(guessCategory('Bar')).toBe('food');
    expect(guessCategory('Car')).toBe(null);
    expect(guessCategory('Bus')).toBe('transport');
    expect(guessCategory('Bud')).toBe(null);
  });

  /** German writes the family as one word, and the stem identifies it. */
  it('finds a word inside a compound', () => {
    expect(guessCategory('Stromrechnung')).toBe('utilities');
    expect(guessCategory('Mietvertrag Kopie')).toBe('housing');
    expect(guessCategory('Hotelzimmer')).toBe('travel');
    // ...but only from five characters up, or every "Überweisung" would be an
    // Uber ride and every "Reise" an ice cream.
    expect(guessCategory('Überweisung')).toBe(null);
  });

  it('keeps a word that fits two categories in the one the whole name points at', () => {
    expect(guessCategory('Gas bill')).toBe('utilities');
    expect(guessCategory('Gas station')).toBe('transport');
    expect(guessCategory('Spielzeug')).toBe('shopping');
    expect(guessCategory('Brettspiel')).toBe('entertainment');
    expect(guessCategory('Mediamarkt')).toBe('shopping');
    expect(guessCategory('Wochenmarkt')).toBe('groceries');
  });

  it('adds up the words of a longer name', () => {
    expect(guessCategory('Dinner and drinks with the team')).toBe('food');
    expect(guessCategory('Einkauf bei Rewe und Edeka')).toBe('groceries');
  });

  it('declines a name it has nothing to say about', () => {
    expect(guessCategory('')).toBe(null);
    expect(guessCategory('   ')).toBe(null);
    expect(guessCategory('Sonstiges')).toBe(null);
    expect(guessCategory('Zettel vom Wochenende')).toBe(null);
    expect(guessCategory('47')).toBe(null);
  });

  /**
   * A tie is a coin flip and the reader is looking at the dropdown anyway.
   * Guessing one of two equally good answers is how a suggestion loses the
   * benefit of the doubt it needs to be silent.
   */
  it('declines a name that fits two categories equally', () => {
    expect(guessCategory('Pizza Sushi Kino Konzert')).toBe(null);
  });

  it('is unbothered by case, accents and punctuation', () => {
    expect(guessCategory('FRÜHSTÜCK!')).toBe('food');
    expect(guessCategory('fruehstueck')).toBe('food');
    expect(guessCategory('fruhstuck')).toBe('food');
    expect(guessCategory('  Taxi,  Flughafen–Hotel ')).toBe('travel');
  });

  /**
   * The lists are the feature; the matcher is the small part. A word that does
   * not name its own category on its own is either in the wrong list or in two
   * lists at once, and both are invisible until somebody types that word.
   */
  it.each(LISTS)('%s: every word names its own category on its own', (_language, categories) => {
    for (const [category, list] of Object.entries(categories) as [Guessable, readonly string[]][]) {
      for (const word of list) {
        expect(guessCategory(word), word).toBe(category);
      }
    }
  });

  it.each(LISTS)('%s: holds nothing too short to reach the threshold', (_language, categories) => {
    for (const list of Object.values(categories)) {
      for (const word of list) expect(word.length, word).toBeGreaterThanOrEqual(3);
    }
  });
});
