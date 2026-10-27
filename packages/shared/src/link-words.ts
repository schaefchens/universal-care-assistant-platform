/**
 * The fingerprint words of a device link (docs/plan-m4.md, G3): four of these 64 things, shown with their pictures
 * and said on both devices, so the person can tell that the device asking is the one in their hand. Simple, concrete
 * things that sound unlike each other in each language; no word of UCAP's commands, no word of help or alarm. They
 * are not recovery words, and the pages say so: nothing secret is in them.
 */
import type { Lang } from './i18n.ts';

export const LINK_WORDS: readonly { emoji: string; de: string; en: string }[] = [
  { emoji: '🐕', de: 'Hund', en: 'dog' },
  { emoji: '🐈', de: 'Katze', en: 'cat' },
  { emoji: '🦁', de: 'Löwe', en: 'lion' },
  { emoji: '🐎', de: 'Pferd', en: 'horse' },
  { emoji: '🐖', de: 'Schwein', en: 'pig' },
  { emoji: '🐘', de: 'Elefant', en: 'elephant' },
  { emoji: '🐇', de: 'Hase', en: 'rabbit' },
  { emoji: '🐧', de: 'Pinguin', en: 'penguin' },
  { emoji: '🐢', de: 'Schildkröte', en: 'turtle' },
  { emoji: '🐟', de: 'Fisch', en: 'fish' },
  { emoji: '🦋', de: 'Schmetterling', en: 'butterfly' },
  { emoji: '🌸', de: 'Blume', en: 'flower' },
  { emoji: '🌳', de: 'Baum', en: 'tree' },
  { emoji: '🌵', de: 'Kaktus', en: 'cactus' },
  { emoji: '🍄', de: 'Pilz', en: 'mushroom' },
  { emoji: '🌙', de: 'Mond', en: 'moon' },
  { emoji: '☁️', de: 'Wolke', en: 'cloud' },
  { emoji: '🕯️', de: 'Kerze', en: 'candle' },
  { emoji: '🍌', de: 'Banane', en: 'banana' },
  { emoji: '🍎', de: 'Apfel', en: 'apple' },
  { emoji: '🍓', de: 'Erdbeere', en: 'strawberry' },
  { emoji: '🌽', de: 'Mais', en: 'corn' },
  { emoji: '🍕', de: 'Pizza', en: 'pizza' },
  { emoji: '🎂', de: 'Kuchen', en: 'cake' },
  { emoji: '❤️', de: 'Herz', en: 'heart' },
  { emoji: '🤖', de: 'Roboter', en: 'robot' },
  { emoji: '🎩', de: 'Hut', en: 'hat' },
  { emoji: '👓', de: 'Brille', en: 'glasses' },
  { emoji: '🔑', de: 'Schlüssel', en: 'key' },
  { emoji: '☂️', de: 'Regenschirm', en: 'umbrella' },
  { emoji: '⌛', de: 'Sanduhr', en: 'hourglass' },
  { emoji: '🎁', de: 'Geschenk', en: 'present' },
  { emoji: '💡', de: 'Glühbirne', en: 'light bulb' },
  { emoji: '📕', de: 'Buch', en: 'book' },
  { emoji: '✏️', de: 'Bleistift', en: 'pencil' },
  { emoji: '✂️', de: 'Schere', en: 'scissors' },
  { emoji: '🔨', de: 'Hammer', en: 'hammer' },
  { emoji: '🚩', de: 'Flagge', en: 'flag' },
  { emoji: '🚂', de: 'Zug', en: 'train' },
  { emoji: '🚲', de: 'Fahrrad', en: 'bicycle' },
  { emoji: '✈️', de: 'Flugzeug', en: 'aeroplane' },
  { emoji: '🚀', de: 'Rakete', en: 'rocket' },
  { emoji: '🏆', de: 'Pokal', en: 'trophy' },
  { emoji: '⚽', de: 'Ball', en: 'football' },
  { emoji: '🎸', de: 'Gitarre', en: 'guitar' },
  { emoji: '🎺', de: 'Trompete', en: 'trumpet' },
  { emoji: '🥁', de: 'Trommel', en: 'drum' },
  { emoji: '⚓', de: 'Anker', en: 'anchor' },
  { emoji: '🎧', de: 'Kopfhörer', en: 'headphones' },
  { emoji: '📁', de: 'Ordner', en: 'folder' },
  { emoji: '⭐', de: 'Stern', en: 'star' },
  { emoji: '☀️', de: 'Sonne', en: 'sun' },
  { emoji: '⛄', de: 'Schneemann', en: 'snowman' },
  { emoji: '🦉', de: 'Eule', en: 'owl' },
  { emoji: '🐝', de: 'Biene', en: 'bee' },
  { emoji: '🐸', de: 'Frosch', en: 'frog' },
  { emoji: '👑', de: 'Krone', en: 'crown' },
  { emoji: '🏠', de: 'Haus', en: 'house' },
  { emoji: '🚗', de: 'Auto', en: 'car' },
  { emoji: '🚢', de: 'Schiff', en: 'ship' },
  { emoji: '🍒', de: 'Kirschen', en: 'cherries' },
  { emoji: '🍋', de: 'Zitrone', en: 'lemon' },
  { emoji: '🦔', de: 'Igel', en: 'hedgehog' },
  { emoji: '☕', de: 'Tasse', en: 'cup' },
];

/** The words for a link's four indices, in the person's language, with their pictures. */
export function linkWordsOf(indices: readonly number[], lang: Lang): { emoji: string; word: string }[] {
  return indices.map((i) => {
    const w = LINK_WORDS[i % LINK_WORDS.length]!;
    return { emoji: w.emoji, word: w[lang] };
  });
}
