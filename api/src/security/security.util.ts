import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Snapp-style handover security, shared by the menu, the driver profile and the order flow:
 *  - a product/driver photo is either an https URL or a small base64 data URL whose bytes
 *    really are a JPEG/PNG/WebP (SVG and friends never reach the storefront);
 *  - an Iranian plate is normalised (Persian digits, Arabic letter variants) and checked
 *    against the real format before it can identify a courier at the door;
 *  - the 4-digit handover code is compared by hash and stored encrypted, so the customer
 *    can read it back but a database leak does not hand the code to anyone.
 */

export const MAX_IMAGE_BYTES = 300 * 1024;
export const MAX_DATA_URL_LENGTH = 420_000;
export const MAX_IMAGE_URL_LENGTH = 2048;
export const MAX_DELIVERY_CODE_ATTEMPTS = 5;

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

function magicMatches(kind: string, bytes: Buffer): boolean {
  if (kind === 'jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (kind === 'png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

/**
 * Parses an optional photo field. `null`/`undefined`/empty clears it; anything else must be
 * an https URL or a validated data URL. Callers that need "field absent" semantics check
 * `body.field === undefined` before calling this.
 */
export function parseImageUrl(value: unknown, label = 'تصویر'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException(`${label} معتبر نیست.`);
  const text = value.trim();
  if (!text) return null;
  if (text.startsWith('data:')) {
    const match = DATA_URL.exec(text);
    if (!match || text.length > MAX_DATA_URL_LENGTH) throw new BadRequestException(`${label} باید تصویر JPEG، PNG یا WebP حداکثر ۳۰۰ کیلوبایت باشد.`);
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !magicMatches(match[1], bytes)) {
      throw new BadRequestException(`${label} باید تصویر JPEG، PNG یا WebP حداکثر ۳۰۰ کیلوبایت باشد.`);
    }
    return text;
  }
  if (text.length > MAX_IMAGE_URL_LENGTH || /[\s\u0000-\u001f\u007f]/.test(text)) throw new BadRequestException(`${label} باید لینک https باشد.`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BadRequestException(`${label} باید لینک https یا تصویر JPEG، PNG یا WebP باشد.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new BadRequestException(`${label} باید لینک https باشد.`);
  }
  return text;
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_PLATE_LETTERS = 'بپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';
const PLATE_PATTERN = new RegExp(`^\\d{2}[${FA_PLATE_LETTERS}]\\d{5}$`);

/**
 * Normalises an Iranian plate to `12ب34567` form: English digits, one Persian letter and no
 * separators. A Latin letter is not accepted — a plate has to be readable at the door exactly
 * as it is written on the vehicle.
 */
export function normalizePlate(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('پلاک معتبر نیست.');
  const normalized = value
    .trim()
    .replace(/[۰-۹]/g, (digit) => String(FA_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String(AR_DIGITS.indexOf(digit)))
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\s\-_]/g, '')
    .toUpperCase();
  if (!PLATE_PATTERN.test(normalized)) throw new BadRequestException('پلاک باید به فرمت ایران باشد؛ مثلاً 12ب34567.');
  return normalized;
}

export function generateDeliveryCode(): string {
  return String(randomInt(1000, 10_000));
}

export function hashDeliveryCode(orderId: string, code: string): string {
  return createHash('sha256').update(`${orderId}:${code}`).digest('hex');
}

export function verifyDeliveryCode(orderId: string, code: string, hash: string): boolean {
  const candidate = Buffer.from(hashDeliveryCode(orderId, code), 'hex');
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function deliveryKey(): Buffer {
  // Production must not fall back: the key that encrypts the customer's handover code is the
  // same secret that signs sessions, and a deployment without it cannot authenticate anyway.
  const secret = process.env.JWT_SECRET || process.env.OTP_HMAC_SECRET || '';
  if (!secret && process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('کلید رمزنگاری کد تحویل تنظیم نشده است.');
  return createHash('sha256').update(`jetino-delivery-code:${secret || 'jetino-local-development-key'}`).digest();
}

export function encryptDeliveryCode(code: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deliveryKey(), iv);
  const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptDeliveryCode(payload: string): string {
  const [iv, tag, encrypted] = payload.split('.');
  if (!iv || !tag || !encrypted) throw new ServiceUnavailableException('کد تحویل قابل خواندن نیست.');
  const decipher = createDecipheriv('aes-256-gcm', deliveryKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}

export type DriverIdentityRow = {
  full_name?: string | null;
  plate_number?: string | null;
  photo_url?: string | null;
  vehicle_type?: string | null;
};

/** Which parts of the door-check identity are still missing, in display order. */
export function missingDriverFields(row: DriverIdentityRow): string[] {
  const missing: string[] = [];
  if (!row.full_name?.trim()) missing.push('fullName');
  if (!row.vehicle_type) missing.push('vehicleType');
  if (!row.plate_number?.trim()) missing.push('plateNumber');
  if (!row.photo_url?.trim()) missing.push('photoUrl');
  return missing;
}

export function isDriverProfileComplete(row: DriverIdentityRow): boolean {
  return missingDriverFields(row).length === 0;
}
