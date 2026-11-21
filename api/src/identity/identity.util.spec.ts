import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import {
  birthDateToIso, describeBiometricReason, gregorianToJalali, jalaliToGregorian, maskNationalCode,
  normalizeBirthDate, normalizeCardSerial, normalizeGender, normalizeMobile, normalizeNationalCode,
} from './identity.util';

describe('identity.util · the numbers behind a courier', () => {
  it('accepts the national codes whose control digit checks out and refuses the rest', () => {
    assert.equal(normalizeNationalCode('۰۰۱۲۳۴۵۶۷۹'), '0012345679');
    assert.throws(() => normalizeNationalCode('0012345678'), BadRequestException);
    assert.throws(() => normalizeNationalCode('123'), BadRequestException);
    assert.throws(() => normalizeNationalCode('1111111111'), BadRequestException);
  });

  it('normalises every shape of a mobile number to 09xxxxxxxxx', () => {
    assert.equal(normalizeMobile('۰۹۱۲۳۴۵۶۷۸۹'), '09123456789');
    assert.equal(normalizeMobile('+989123456789'), '09123456789');
    assert.equal(normalizeMobile('00989123456789'), '09123456789');
    assert.equal(normalizeMobile('912 345 6789'), '09123456789');
    assert.throws(() => normalizeMobile('02188888888'), BadRequestException);
  });

  it('reads a birth date in all four published shapes', () => {
    for (const value of ['1377/06/30', '1377-6-30', '1377.06.30', '13770630', '۱۳۷۷/۰۶/۳۰']) {
      assert.equal(normalizeBirthDate(value), '1377/06/30', value);
    }
    assert.throws(() => normalizeBirthDate('1377/12/31'), BadRequestException);
    assert.throws(() => normalizeBirthDate('1377/13/01'), BadRequestException);
  });

  it('turns away people who are not eighteen yet', () => {
    const today = new Date();
    const [jy, jm, jd] = gregorianToJalali(today.getUTCFullYear() - 17, today.getUTCMonth() + 1, today.getUTCDate());
    assert.throws(() => normalizeBirthDate(`${jy}/${jm}/${jd}`), /۱۸ سال/);
  });

  it('converts both ways without drifting', () => {
    assert.deepEqual(jalaliToGregorian(1377, 6, 30), [1998, 9, 21]);
    assert.deepEqual(jalaliToGregorian(1362, 1, 1), [1983, 3, 21]);
    assert.deepEqual(gregorianToJalali(1998, 9, 21), [1377, 6, 30]);
    assert.deepEqual(gregorianToJalali(1983, 3, 21), [1362, 1, 1]);
    assert.equal(birthDateToIso('1377/06/30'), '1998-09-21');
  });

  it('keeps only a hint of the sensitive numbers', () => {
    assert.equal(maskNationalCode('0012345679'), '001••••79');
    assert.equal(normalizeCardSerial('۰۰۱۲۳۴۵۶۷۸'), '0012345678');
    assert.equal(normalizeGender('مرد'), 1);
    assert.equal(normalizeGender('زن'), 0);
    assert.throws(() => normalizeGender('x'), BadRequestException);
  });

  it('explains every reject reason in the courier’s own words', () => {
    assert.match(describeBiometricReason('REJECT_VIDEO_NOT_LIVE'), /زنده/);
    assert.match(describeBiometricReason('REJECT_FACE_NOT_MATCH_ID'), /چهره/);
    assert.match(describeBiometricReason('SOMETHING_NEW'), /دوباره تلاش کن/);
  });
});
