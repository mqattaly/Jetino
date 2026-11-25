import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { GROCERY_FLOW_IMAGE, HERO_IMAGE, photoFor } from '../../src/catalogImages';

const root = resolve(__dirname, '../..');
const publicFile = (url: string) => resolve(root, 'public', url.replace(/^\//, ''));

describe('storefront images and install icons', () => {
  it('uses the appropriate representative image for known food categories', () => {
    assert.equal(photoFor('قلیه ماهی').src, '/images/cat-seafood.jpg');
    assert.equal(photoFor('چلوکباب کوبده').src, '/images/cat-kebab.jpg');
    assert.equal(photoFor('خورشت قورمه سبزی').src, '/images/cat-stew.jpg');
    assert.equal(photoFor('نان محلی').src, '/images/cat-bakery.jpg');
    assert.equal(photoFor('شربت لیمو').src, '/images/cat-dessert.jpg');
    // pastry shops and cafes have their own photos, not bread and not ice cream
    assert.equal(photoFor('قنادی نخل').src, '/images/cat-sweets.jpg');
    assert.equal(photoFor('کافه ساحل').src, '/images/cat-coffee.jpg');
    // the supermarket service needs its own picture: grocery shops must not fall back to food
    assert.equal(photoFor('سوپرمارکت محله').src, '/images/cat-grocery.jpg');
    assert.equal(photoFor('هایپر مرکزی', 'میوه و سبزیجات').src, '/images/cat-grocery.jpg');
    // «قورمه سبزی» is a stew, not a greengrocer
    assert.equal(photoFor('خورشت قورمه سبزی').src, '/images/cat-stew.jpg');
  });
  it('picks a stable image when a business has no known category', () => {
    assert.deepEqual(photoFor('کسب‌وکار ناشناخته'), photoFor('کسب‌وکار ناشناخته'));
  });
  it('ships every representative photo inside public', () => {
    const terms = ['کباب', 'زغال', 'ماهی', 'خورشت', 'نان', 'شربت', 'قنادی', 'کافه', 'سوپرمارکت', 'لبنیات'];
    for (const photo of [HERO_IMAGE, GROCERY_FLOW_IMAGE, ...terms.map((term) => photoFor(term))]) {
      assert.ok(existsSync(publicFile(photo.src)), `${photo.src} should exist in the static build`);
    }
  });
  it('ships the installation icons declared in the manifest', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8')) as { icons: Array<{ src: string; sizes: string; purpose: string }> };
    assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
    assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'));
    for (const icon of manifest.icons) assert.ok(existsSync(publicFile(icon.src)), `${icon.src} should exist`);
  });
});
