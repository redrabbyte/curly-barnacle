import { CATEGORIES } from '@spendapp/shared';
import type { Language } from './index';

type Category = (typeof CATEGORIES)[number];

/**
 * Every category a name can be guessed as: all of them but the catch-all.
 *
 * 'other' is what the guess falls back to, so it has no words of its own —
 * a description nothing matches is exactly what 'other' means.
 */
export type Guessable = Exclude<Category, 'other'>;

/**
 * The words each category is recognised by, per language.
 *
 * `Record<Language, ...>` rather than a partial map: adding a language to
 * `LANGUAGES` without giving it words would leave its speakers with a feature
 * that silently does nothing, and the compiler should say so. Every category
 * is required for the same reason.
 *
 * Rules the matcher (`categoryGuess.ts`) imposes on what belongs here:
 *
 * - Write words in their natural spelling, accents and all. They are folded
 *   the same way the description is, so "Frühstück" and "fruhstuck" both work.
 * - Words of four characters or fewer must match a whole word exactly — no
 *   typos, no compounds. So list the plural too ("gift", "gifts") where it is
 *   common, and spell out the compounds that matter ("bahn", "bahnhof").
 * - Five characters and up also match inside a longer word, which is what
 *   makes one entry cover a German compound family: "strom" catches
 *   "Stromrechnung" and "Stromabschlag", "essen" catches "Abendessen".
 * - A multi-word entry ("gas station") matches that many words in a row, and
 *   is the way to keep an ambiguous short word ("gas", which is a utility
 *   bill on its own) out of the wrong category.
 * - Nothing shorter than three characters: it could not clear the score
 *   threshold on its own, and would only add noise to longer names.
 *
 * Both languages' lists are scored against every description, whichever
 * language the reader chose — people write "Pizza", "Uber" and "Aldi" in any
 * language, and a German name in an English UI should still be recognised.
 * Overlap between the two lists is therefore harmless (it is deduplicated),
 * but overlap *between categories* is not: a word that fits two categories
 * equally well makes the guess a coin flip, and the matcher answers such a tie
 * by declining to guess. `categoryGuess.test.ts` holds every word here to that
 * standard.
 */
export const CATEGORY_WORDS: Record<Language, Record<Guessable, readonly string[]>> = {
  en: {
    food: [
      'restaurant', 'cafe', 'coffee', 'breakfast', 'brunch', 'lunch', 'dinner',
      'supper', 'pizza', 'burger', 'burgers', 'sushi', 'kebab', 'pasta',
      'noodles', 'curry', 'tacos', 'ramen', 'bakery', 'snack', 'snacks',
      'takeaway', 'takeout', 'canteen', 'bistro', 'diner', 'brewery', 'pub',
      'bar', 'bars', 'beer', 'beers', 'wine', 'cocktail', 'cocktails',
      'drinks', 'dessert', 'ice cream', 'meal', 'meals', 'food', 'foods',
      'barbecue', 'bbq', 'buffet', 'sandwich', 'salad', 'steak', 'steaks', 'steakhouse',
      'starbucks', 'mcdonalds', 'dominos', 'ubereats', 'deliveroo',
      'doordash', 'grubhub', 'wolt', 'lieferando', 'tip', 'tips',
    ],
    groceries: [
      'groceries', 'grocery', 'supermarket', 'market', 'produce', 'butcher',
      'greengrocer', 'milk', 'bread', 'eggs', 'cheese', 'fruit', 'fruits',
      'vegetables', 'veggies', 'meat', 'rice', 'flour', 'sugar', 'pantry',
      'weekly shop', 'food shop', 'tesco', 'asda', 'sainsburys', 'waitrose',
      'morrisons', 'aldi', 'lidl', 'walmart', 'costco', 'kroger', 'safeway',
      'wholefoods', 'trader joes', 'migros', 'coop', 'rewe', 'edeka',
      'kaufland', 'penny', 'netto',
    ],
    transport: [
      'taxi', 'taxis', 'cab', 'cabs', 'uber', 'lyft', 'rideshare', 'bus',
      'buses', 'bus ticket', 'bus fare', 'train', 'trains', 'train ticket',
      'tram', 'metro', 'subway', 'underground', 'railway', 'station', 'fare',
      'fares', 'commute', 'transit', 'public transport', 'parking',
      'car park', 'toll', 'tolls', 'petrol', 'diesel', 'gasoline', 'fuel',
      'gas station', 'charging', 'bike', 'bikes', 'scooter', 'mileage',
      'car wash',
    ],
    housing: [
      'rent', 'rents', 'mortgage', 'landlord', 'lease', 'sublet', 'deposit',
      'apartment', 'flatshare', 'property tax', 'furniture', 'ikea',
      'mattress', 'couch', 'renovation', 'repairs', 'handyman', 'plumber',
      'electrician', 'moving van', 'storage unit', 'cleaner', 'cleaning',
      'household', 'doormat', 'curtains',
    ],
    utilities: [
      'electricity', 'electric', 'power bill', 'water bill', 'water', 'gas',
      'gas bill', 'heating', 'internet', 'wifi', 'broadband', 'router',
      'mobile', 'phone bill', 'sim card', 'utility', 'utilities', 'bill',
      'bills', 'energy', 'meter', 'garbage', 'trash', 'recycling', 'sewage',
      'tv licence', 'tv license', 'vodafone', 'telekom',
    ],
    entertainment: [
      'cinema', 'movie', 'movies', 'film', 'films', 'theatre', 'theater',
      'concert', 'concerts', 'festival', 'museum', 'gallery', 'exhibition',
      'zoo', 'aquarium', 'netflix', 'spotify', 'disney', 'hulu', 'twitch',
      'steam', 'playstation', 'xbox', 'nintendo', 'game', 'games', 'gaming',
      'bowling', 'karaoke', 'billiards', 'nightclub', 'club', 'clubs',
      'party', 'escape room', 'amusement park', 'theme park', 'minigolf',
      'streaming',
    ],
    travel: [
      'flight', 'flights', 'airline', 'airport', 'boarding pass', 'hotel',
      'hostel', 'motel', 'resort', 'airbnb', 'guesthouse', 'campsite',
      'camping', 'vacation', 'holiday', 'trip', 'trips', 'getaway',
      'luggage', 'baggage', 'suitcase', 'passport', 'car rental',
      'rental car', 'ferry', 'cruise', 'sightseeing', 'excursion', 'tour',
      'tours', 'souvenir', 'souvenirs', 'ryanair', 'easyjet', 'lufthansa',
      'booking', 'expedia',
    ],
    health: [
      'doctor', 'dentist', 'orthodontist', 'pharmacy', 'medicine',
      'medication', 'prescription', 'hospital', 'clinic', 'health insurance',
      'therapy', 'therapist', 'physio', 'chiropractor', 'gym',
      'gym membership', 'fitness', 'optician', 'glasses', 'contact lenses',
      'vitamins', 'painkillers', 'vaccination', 'checkup', 'bandages',
      'first aid',
    ],
    shopping: [
      'clothes', 'clothing', 'shoes', 'sneakers', 'jacket', 'coat', 'jeans',
      'shirt', 'dress', 'hoodie', 'socks', 'amazon', 'ebay', 'zalando',
      'asos', 'primark', 'zara', 'decathlon', 'mediamarkt', 'shopping mall',
      'electronics', 'laptop', 'headphones', 'charger', 'gift', 'gifts',
      'present', 'presents', 'books', 'bookshop', 'stationery', 'toy',
      'toys', 'cosmetics', 'makeup', 'perfume', 'jewellery', 'jewelry',
      'wristwatch', 'backpack',
    ],
  },
  de: {
    food: [
      'restaurant', 'cafe', 'kaffee', 'frühstück', 'mittagessen',
      'abendessen', 'essen', 'imbiss', 'pizza', 'burger', 'döner', 'sushi',
      'nudeln', 'pommes', 'currywurst', 'schnitzel', 'bäckerei', 'brötchen',
      'konditorei', 'kuchen', 'eis', 'eisdiele', 'kneipe', 'biergarten',
      'bier', 'wein', 'cocktail', 'getränke', 'mensa', 'kantine',
      'gaststätte', 'wirtshaus', 'trinkgeld', 'brunch', 'vesper',
      'lieferando', 'essengehen', 'mittag', 'abendbrot',
    ],
    groceries: [
      'lebensmittel', 'supermarkt', 'wocheneinkauf', 'grosseinkauf', 'markt',
      'wochenmarkt', 'getränkemarkt', 'milch', 'brot', 'eier', 'gemüse',
      'obst', 'fleisch', 'käse', 'butter', 'joghurt', 'mehl', 'zucker',
      'metzger', 'metzgerei', 'fleischerei', 'hofladen', 'rewe', 'edeka',
      'aldi', 'lidl', 'penny', 'netto', 'kaufland', 'hofer', 'bioladen',
    ],
    transport: [
      'taxi', 'taxifahrt', 'uber', 'bus', 'busticket', 'busfahrt', 'bahn',
      'bahnhof', 'bahnticket', 'zug', 'zugticket', 'straßenbahn', 'ubahn',
      'sbahn', 'öpnv', 'fahrkarte', 'fahrschein', 'fahrtkosten',
      'monatskarte', 'verkehrsmittel', 'benzin', 'diesel', 'tanken',
      'tankstelle', 'sprit', 'parken', 'parkhaus', 'parkgebühr', 'maut',
      'fahrrad', 'roller', 'mitfahrgelegenheit', 'autowäsche',
    ],
    housing: [
      'miete', 'mietzahlung', 'kaltmiete', 'warmmiete', 'kaution',
      'vermieter', 'wohnung', 'mietvertrag', 'hypothek', 'hausgeld',
      'möbel', 'ikea', 'matratze', 'sofa', 'renovierung', 'handwerker',
      'klempner', 'elektriker', 'hausmeister', 'umzug', 'umzugswagen',
      'putzmittel', 'haushalt', 'gardinen',
    ],
    utilities: [
      'strom', 'stadtwerke', 'wasser', 'abwasser', 'heizung', 'heizkosten',
      'nebenkosten', 'betriebskosten', 'gas', 'gasrechnung', 'energie',
      'internet', 'wlan', 'telefon', 'handy', 'handyvertrag', 'mobilfunk',
      'rechnung', 'abschlag', 'zählerstand', 'müll', 'müllabfuhr',
      'entsorgung', 'rundfunkbeitrag', 'gez', 'vodafone', 'telekom',
    ],
    entertainment: [
      'kino', 'kinokarte', 'film', 'theater', 'konzert', 'festival',
      'museum', 'ausstellung', 'zoo', 'tierpark', 'freizeitpark',
      'schwimmbad', 'therme', 'netflix', 'spotify', 'disney', 'spiel',
      'spiele', 'brettspiel', 'gaming', 'bowling', 'kegeln', 'karaoke',
      'disko', 'club', 'party', 'eintritt', 'veranstaltung', 'stadion',
      'freizeit',
    ],
    travel: [
      'flug', 'flugticket', 'fluggesellschaft', 'flughafen', 'hotel',
      'hostel', 'pension', 'ferienwohnung', 'jugendherberge',
      'übernachtung', 'campingplatz', 'urlaub', 'reise', 'ausflug',
      'wanderung', 'gepäck', 'koffer', 'reisepass', 'mietwagen', 'fähre',
      'kreuzfahrt', 'stadtführung', 'souvenir', 'andenken', 'lufthansa',
      'buchung',
    ],
    health: [
      'arzt', 'ärztin', 'hausarzt', 'zahnarzt', 'kinderarzt', 'tierarzt',
      'apotheke', 'medikament', 'medizin', 'rezept', 'krankenhaus',
      'klinik', 'krankenkasse', 'krankenversicherung', 'therapie',
      'physiotherapie', 'massage', 'fitnessstudio', 'brille', 'optiker',
      'kontaktlinsen', 'vitamine', 'schmerzmittel', 'impfung', 'praxis',
      'zuzahlung', 'pflaster',
    ],
    shopping: [
      'kleidung', 'klamotten', 'schuhe', 'jacke', 'mantel', 'hose', 'hemd',
      'kleid', 'pullover', 'socken', 'amazon', 'ebay', 'zalando', 'primark',
      'decathlon', 'mediamarkt', 'saturn', 'kaufhaus', 'einkaufszentrum',
      'elektronik', 'laptop', 'kopfhörer', 'ladekabel', 'geschenk',
      'geschenke', 'bücher', 'buchladen', 'schreibwaren', 'spielzeug',
      'kosmetik', 'schminke', 'parfüm', 'schmuck', 'armbanduhr', 'rucksack',
      'drogerie', 'rossmann',
    ],
  },
};
