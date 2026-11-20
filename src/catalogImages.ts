/**
 * Photographs for the storefront. The schema has no image column yet (§4 of the PRD defers media
 * uploads), so a business or a dish is matched to one of the photos shipped in `public/images` by
 * keyword, and anything unmatched falls back to a stable pick from its name — the same shop always
 * gets the same picture, and no card is ever left with a grey box. Replacing this with
 * `businesses.image_url` is a drop-in change for the two callers.
 */
export type CatalogPhoto = { src: string; alt: string };

const PHOTOS = {
  kebab: { src: '/images/cat-kebab.jpg', alt: 'چلوکباب کوبده با برنج زعفرانی و گوجه کبابی' },
  grill: { src: '/images/cat-grill.jpg', alt: 'سیخ‌های جوجه کباب روی زغال' },
  seafood: { src: '/images/cat-seafood.jpg', alt: 'قلیه ماهی جنوبی با سس ترش و سبزی' },
  stew: { src: '/images/cat-stew.jpg', alt: 'خورشت سبزی با لیمو عمانی و برنج' },
  bakery: { src: '/images/cat-bakery.jpg', alt: 'نان محلی، خرما و شیرینی سنتی' },
  dessert: { src: '/images/cat-dessert.jpg', alt: 'شربت تازه، لیمو نعنا و بستنی سنتی' },
} satisfies Record<string, CatalogPhoto>;

export const HERO_IMAGE: CatalogPhoto = { src: '/images/hero-night.jpg', alt: 'شب بندر خمیر؛ پیک با جعبهٔ غذای زرشکی و ماه کامل روی خلیج' };

/** Ordered so the most specific southern keywords win over the generic ones. */
const KEYWORDS: [RegExp, keyof typeof PHOTOS][] = [
  [/قلیه|قاليه|ماهی|میگو|دریایی|سبزه|میوه دریایی/i, 'seafood'],
  [/جوجه|جوجه‌کباب|کباب‌پز|کبابی|کوبده|چلوکباب|کباب/i, 'kebab'],
  [/زغال|گریل|برگر|پیتزا|ساندویچ|سندویچ|همبرگر|شیشلیک|بریان|جگر/i, 'grill'],
  [/خورشت|قورمه|فسنجان|قیمه|گوشت|آبگوشت|دیزی|استامبولی|لوبیا/i, 'stew'],
  [/نان|تیرش|شیرینی|قناد|حلوا|کیک|بکری|سوهان/i, 'bakery'],
  [/دسر|بستنی|شربت|آبمیوه|نوشیدنی|قهوه|چای|کافه|شیک/i, 'dessert'],
];

const ORDER: (keyof typeof PHOTOS)[] = ['kebab', 'grill', 'seafood', 'stew', 'bakery', 'dessert'];

const hash = (text: string) => {
  let value = 0;
  for (const char of text) value = (value * 31 + char.codePointAt(0)!) % 9973;
  return value;
};

/** `name` plus the categories it belongs to, so a shop named after its food is enough. */
export function photoFor(...terms: (string | null | undefined)[]): CatalogPhoto {
  const haystack = terms.filter(Boolean).join(' ');
  for (const [pattern, photo] of KEYWORDS) if (pattern.test(haystack)) return PHOTOS[photo];
  return PHOTOS[ORDER[hash(haystack) % ORDER.length]];
}
