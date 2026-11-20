import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import {
  MAX_IMAGE_BYTES,
  decryptDeliveryCode,
  encryptDeliveryCode,
  generateDeliveryCode,
  hashDeliveryCode,
  isDriverProfileComplete,
  missingDriverFields,
  normalizePlate,
  parseImageUrl,
  verifyDeliveryCode,
} from './security.util';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

describe('photo validation', () => {
  it('accepts an https link and a real JPEG/PNG/WebP data URL', () => {
    assert.equal(parseImageUrl('https://cdn.example.test/food/kabab.jpg'), 'https://cdn.example.test/food/kabab.jpg');
    assert.equal(parseImageUrl(PNG), PNG);
    assert.equal(parseImageUrl('  '), null, 'an empty field clears the photo');
    assert.equal(parseImageUrl(undefined), null);
  });

  it('refuses what a storefront must never render', () => {
    for (const value of [
      'http://cdn.example.test/food.jpg',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/png;base64,bm90LWEtcG5n',
      'https://user:pass@cdn.example.test/x.jpg',
      '/images/local.jpg',
      42,
    ]) {
      assert.throws(() => parseImageUrl(value), BadRequestException, `${String(value)} must be rejected`);
    }
  });

  it('rejects a payload above the size budget', () => {
    const big = `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 10).toString('base64')}`;
    assert.throws(() => parseImageUrl(big), BadRequestException);
  });
});

describe('Iranian plate normalisation', () => {
  it('accepts Persian digits, spaces and lowercase letters', () => {
    assert.equal(normalizePlate('12 ب 34567'), '12ب34567');
    assert.equal(normalizePlate('۱۲ب۳۴۵۶۷'), '12ب34567');
    assert.equal(normalizePlate('45-ج-678-90'), '45ج67890');
    assert.equal(normalizePlate('12ب345-67'), '12ب34567');
  });

  it('refuses a plate that cannot identify a courier', () => {
    for (const value of ['', '12x34567', '12345678', 'ب1234567', null, 12]) {
      assert.throws(() => normalizePlate(value), BadRequestException, `${String(value)} must be rejected`);
    }
  });
});

describe('handover code', () => {
  it('issues four digits, keeps only a verifiable hash and can be read back by the owner', () => {
    process.env.JWT_SECRET = 'unit-test-secret-for-handover-codes';
    const orderId = '123e4567-e89b-12d3-a456-426614174099';
    const code = generateDeliveryCode();
    assert.match(code, /^\d{4}$/);
    const hash = hashDeliveryCode(orderId, code);
    assert.equal(hash.length, 64);
    assert.ok(!hash.includes(code));
    assert.equal(verifyDeliveryCode(orderId, code, hash), true);
    assert.equal(verifyDeliveryCode(orderId, String((Number(code) + 1) % 10000).padStart(4, '0'), hash), false);
    assert.equal(verifyDeliveryCode('223e4567-e89b-12d3-a456-426614174099', code, hash), false, 'the hash is bound to the order');
    assert.equal(decryptDeliveryCode(encryptDeliveryCode(code)), code);
    const cipher = encryptDeliveryCode(code);
    assert.notEqual(cipher, code);
    assert.notEqual(cipher, encryptDeliveryCode(code), 'a fresh IV every time');
  });
});

describe('driver identity completeness', () => {
  it('names every field a customer checks at the door', () => {
    assert.deepEqual(missingDriverFields({}), ['fullName', 'vehicleType', 'plateNumber', 'photoUrl']);
    assert.equal(isDriverProfileComplete({ full_name: 'رضا', vehicle_type: 'CAR', plate_number: '12ب34567', photo_url: PNG }), true);
    assert.deepEqual(missingDriverFields({ full_name: '  ', vehicle_type: 'CAR', plate_number: '12ب34567', photo_url: PNG }), ['fullName']);
  });
});
