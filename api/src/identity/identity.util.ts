import { BadRequestException } from '@nestjs/common';

/** Persian/Arabic digits become ASCII so the same value works on every keyboard. */
export function toAsciiDigits(value: unknown): string {
  return String(value ?? '').trim()
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

export function onlyDigits(value: unknown): string {
  return toAsciiDigits(value).replace(/[\s\-_()]/g, '');
}

/** 09xxxxxxxxx, +989xx, 00989xx and 9xx all come home as 09xxxxxxxxx. */
export function normalizeMobile(input: unknown): string {
  const digits = onlyDigits(input).replace(/^\+/, '');
  const national = digits.startsWith('0098') ? digits.slice(4)
    : digits.startsWith('98') && digits.length === 12 ? digits.slice(2)
      : digits;
  const local = national.startsWith('0') ? national : `0${national}`;
  if (!/^09\d{9}$/.test(local)) throw new BadRequestException('شمارهٔ موبایل معتبر نیست؛ مثل ۰۹۱۲۳۴۵۶۷۸۹ بنویس.');
  return local;
}

/** The official ten-digit check: nine digits plus a control digit that must add up. */
export function normalizeNationalCode(input: unknown): string {
  const code = onlyDigits(input);
  if (!/^\d{10}$/.test(code)) throw new BadRequestException('کد ملی باید ۱۰ رقم باشد.');
  if (/^(\d)\1{9}$/.test(code)) throw new BadRequestException('این کد ملی معتبر نیست.');
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(code[index]) * (10 - index);
  const remainder = sum % 11;
  const control = remainder < 2 ? remainder : 11 - remainder;
  if (control !== Number(code[9])) throw new BadRequestException('این کد ملی معتبر نیست؛ رقم‌ها رو یه بار دیگه چک کن.');
  return code;
}

export function maskNationalCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 3)}••••${code.slice(-2)}` : '••••';
}

export function normalizeCardSerial(input: unknown): string {
  const serial = onlyDigits(input);
  if (!/^\d{10}$/.test(serial)) throw new BadRequestException('سریال کارت ملی باید ۱۰ رقم باشد؛ روی پشت کارت نوشته شده.');
  return serial;
}

/** Zohal wants 0 for women and 1 for men. */
export function normalizeGender(input: unknown): 0 | 1 {
  const text = toAsciiDigits(input).toLowerCase();
  if (text === '1' || text === 'male' || text === 'مرد') return 1;
  if (text === '0' || text === 'female' || text === 'زن') return 0;
  throw new BadRequestException('جنسیت را انتخاب کن.');
}

const div = (a: number, b: number) => Math.trunc(a / b);
const mod = (a: number, b: number) => a - Math.floor(a / b) * b;

/**
 * The Jalali/Gregorian pair below is the jalaali-js algorithm (MIT): a fixed table of leap jumps
 * instead of a guessed 33-year cycle, because a birthday that drifts by a day is a failed KYC.
 */
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

function jalCal(jy: number) {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jm = 0;
  let jump = 0;
  if (jy < jp || jy >= BREAKS[bl - 1]) throw new Error(`Invalid Jalali year ${jy}`);
  for (let index = 1; index < bl; index += 1) {
    jm = BREAKS[index];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 16) === 0) leapJ -= 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy: number, gm: number, gd: number): number {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn: number): [number, number, number] {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return [gy, gm, gd];
}

function d2j(jdn: number): [number, number, number] {
  const gy = d2g(jdn)[0];
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) return [jy, 1 + div(k, 31), mod(k, 31) + 1];
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return [jy, 7 + div(k, 30), mod(k, 30) + 1];
}

/** Jalali → Gregorian. */
export function jalaliToGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  const r = jalCal(jy);
  const jdn = g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
  return d2g(jdn);
}

/** Gregorian → Jalali, so the app can name today's Jalali date without a dependency. */
export function gregorianToJalali(gy: number, gm: number, gd: number): [number, number, number] {
  return d2j(g2d(gy, gm, gd));
}

/** 1377/06/30, 1377-6-30, 1377.06.30 and 13770630 are all the same birthday. */
export function normalizeBirthDate(input: unknown): string {
  // Dashes matter here, so this normaliser keeps them instead of stripping like onlyDigits does.
  const text = toAsciiDigits(input).replace(/\s+/g, '').replace(/[/.]/g, '-');
  const compact = text.replace(/-/g, '');
  let jy: number; let jm: number; let jd: number;
  if (/^\d{8}$/.test(compact)) {
    jy = Number(compact.slice(0, 4)); jm = Number(compact.slice(4, 6)); jd = Number(compact.slice(6, 8));
  } else {
    const parts = text.split('-').filter(Boolean);
    if (parts.length !== 3) throw new BadRequestException('تاریخ تولد را مثل ۱۳۷۷/۰۶/۳۰ بنویس.');
    jy = Number(parts[0]); jm = Number(parts[1]); jd = Number(parts[2]);
  }
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd) || jy < 1300 || jy > 1420 || jm < 1 || jm > 12 || jd < 1 || jd > 31) {
    throw new BadRequestException('تاریخ تولد معتبر نیست؛ سال، ماه و روز شمسی را درست بنویس.');
  }
  if (jm > 6 && jd > 30) throw new BadRequestException('تاریخ تولد معتبر نیست؛ ماه‌های دوم سال ۳۰ روزه‌اند.');
  const [gy, gm, gd] = jalaliToGregorian(jy, jm, jd);
  const born = new Date(Date.UTC(gy, gm - 1, gd));
  if (Number.isNaN(born.getTime())) throw new BadRequestException('تاریخ تولد معتبر نیست.');
  if (born.getTime() < Date.UTC(1920, 0, 1)) throw new BadRequestException('تاریخ تولد معتبر نیست.');
  const minimum = new Date();
  minimum.setUTCFullYear(minimum.getUTCFullYear() - 18);
  if (born.getTime() > minimum.getTime()) throw new BadRequestException('برای پیک شدن باید ۱۸ سالت تموم شده باشه.');
  return `${String(jy).padStart(4, '0')}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

export function birthDateToIso(jalali: string): string {
  const [jy, jm, jd] = jalali.split('/').map(Number);
  const [gy, gm, gd] = jalaliToGregorian(jy, jm, jd);
  return `${String(gy).padStart(4, '0')}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
}

/** The provider's reject reasons, in the words a courier can act on. */
export const BIOMETRIC_REASON_LABELS: Record<string, string> = {
  ACCEPT: 'چهره و ویدئوت تأیید شد.',
  REJECT_INPUT_DATA_INVALID: 'اطلاعات هویتی با هم نمی‌خونه؛ کد ملی، تاریخ تولد و سریال کارت رو دوباره چک کن.',
  REJECT_SERIAL_NATIONAL_CARD_WRONG: 'سریال کارت ملی درست نیست؛ ۱۰ رقم پشت کارت رو دقیق وارد کن.',
  REJECT_NATIONAL_CARD_EXPIRED: 'کارت ملی منقضی شده؛ کارت تازه بگیر و دوباره بیا.',
  REJECT_INFO_NOT_MATCHED: 'اطلاعات و چهره با ثبت احوال مطابقت نداشت.',
  REJECT_FACE_NOT_MATCH_ID: 'چهرهٔ ویدئو با عکس ثبت‌احوال یکی نبود؛ با نور خوب و بدون ماسک یا عینک دوباره ضبط کن.',
  REJECT_VIDEO_NOT_LIVE: 'ویدئو زنده تشخیص داده نشد؛ باید همون لحظه خودت رو ضبط کنی، نه عکس یا ویدئوی آماده.',
  REJECT_VIDEO_BAD_LIGHT: 'نور کم بود؛ جلوی نور طبیعی بایست و دوباره ضبط کن.',
  REJECT_VIDEO_BAD_QUALITY: 'کیفیت ویدئو پایین بود؛ لنز رو پاک کن و آرام‌تر ضبط کن.',
  REJECT_PERSON_TOO_FAR_AWAY: 'صورتت دور بود؛ گوشی رو نزدیک‌تر بگیر.',
  REJECT_MORE_THAN_ONE_PERSON: 'بیشتر از یک نفر تو تصویر بود؛ تنها ویدئو رو بگیر.',
  REJECT_NO_PERSON_DETECTED: 'کسی تو ویدئو پیدا نشد؛ صورتت کامل تو کادر باشه.',
  REJECT_INCOMPATIBLE_HEJAB: 'پوشش صورت با این سرویس سازگار نیست؛ مطابق راهنما دوباره ضبط کن.',
  REJECT_INCOMPATIBLE_ANGLE_CAMERA: 'زاویهٔ دوربین درست نبود؛ گوشی رو هم‌سطح صورت بگیر.',
  REJECT_INCOMPATIBLE_BACKGROUND: 'پس‌زمینهٔ شلوغ رد شد؛ پشت سرت ساده و روشن باشه.',
  REJECT_INCOMPATIBLE_LOOK_CAMERA: 'باید در طول ضبط به دوربین نگاه کنی.',
  REJECT_FAKE_VIDEO: 'ویدئوی جعلی تشخیص داده شد؛ فقط ضبط زندهٔ خودت قبوله.',
  REJECT_INVALID_SIGNATURE: 'امضای درخواست معتبر نبود؛ با پشتیبانی تماس بگیر.',
  REJECT_USER_DID_NOT_SPEAK_REQUIRED_TEXT: 'متن راهنمای داخل ویدئو گفته نشد؛ مطابق راهنما دوباره ضبط کن.',
  SERVICE_UNAVAILABLE: 'سرویس بیومتریک الان در دسترس نیست؛ چند دقیقهٔ دیگه دوباره امتحان کن.',
  UNDEFINED: 'نتیجه مشخص نشد؛ دوباره تلاش کن.',
  UNKNOWN: 'نتیجه مشخص نشد؛ دوباره تلاش کن.',
};

export function describeBiometricReason(reason: string | null | undefined): string {
  return BIOMETRIC_REASON_LABELS[String(reason ?? '').toUpperCase()] ?? 'احراز هویت بیومتریک تأیید نشد؛ دوباره تلاش کن.';
}
