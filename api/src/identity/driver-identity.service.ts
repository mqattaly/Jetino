import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';
import { RateLimitService } from '../security/rate-limit.service';
import { ZohalError, ZohalService } from './zohal.service';
import {
  birthDateToIso, describeBiometricReason, gregorianToJalali, maskNationalCode, normalizeBirthDate,
  normalizeCardSerial, normalizeGender, normalizeMobile, normalizeNationalCode,
} from './identity.util';

type Principal = { sub: string; roles?: string[] };

const MAX_VIDEO_BYTES = 4_000_000; // Vercel caps a request body at 4.5 MB; stay under it.
const VIDEO_TYPES = ['video/webm', 'video/mp4', 'video/quicktime'];
const BIOMETRIC_POLL_QUIET_MS = 10_000;

type DriverRow = {
  id: string;
  user_id: string;
  status: string;
  national_code: string | null;
  birth_date: string | null;
  national_card_serial: string | null;
  gender: number | null;
  shahkar_matched: boolean | null;
  identity_matched: boolean | null;
  identity_first_name: string | null;
  identity_last_name: string | null;
  identity_father_name: string | null;
  identity_checked_at: string | null;
  full_name: string | null;
  biometric_status: string;
  biometric_session_id: string | null;
  biometric_reason: string | null;
  biometric_checked_at: string | null;
  phone: string | null;
};

/** The selfie video arrives as raw bytes; the browser sends webm or mp4 and nothing else. */
function assertVideo(bytes: Uint8Array, mime: string) {
  if (!VIDEO_TYPES.includes(mime.toLowerCase())) {
    throw new BadRequestException('فقط ویدئوی webm یا mp4 قبول می‌شه؛ دوباره ضبط کن.');
  }
  if (!bytes?.length) throw new BadRequestException('ویدئویی نفرستادی.');
  if (bytes.length > MAX_VIDEO_BYTES) throw new BadRequestException('ویدئو بزرگ‌تر از حد مجازه؛ کوتاه‌تر (۱۰ ثانیه) ضبط کن.');
  const head = Array.from(bytes.slice(0, 12));
  const isWebm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  const isMp4 = bytes.length > 8 && String.fromCharCode(head[4], head[5], head[6], head[7]) === 'ftyp';
  if (!isWebm && !isMp4) throw new BadRequestException('فایل ارسالی ویدئو نیست؛ دوباره ضبط کن.');
}

/**
 * Courier identity, checked against the official registries instead of a human comparing photos:
 * Shahkar ties the login number to the national code, the national registry confirms the name and
 * birthday, and a fresh selfie video proves the face behind the account.
 *
 * The last gate — `require_driver_identity` — is off by default so an unconfigured provider can
 * never lock a working courier out of missions.
 */
@Injectable()
export class DriverIdentityService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ZohalService) private readonly zohal: ZohalService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
  ) {}

  private async driverRow(user: Principal): Promise<DriverRow> {
    const result = await this.pool.query(
      `SELECT d.id,d.user_id,d.status,d.national_code,d.birth_date,d.national_card_serial,d.gender,
              d.shahkar_matched,d.identity_matched,d.identity_first_name,d.identity_last_name,
              d.identity_father_name,d.identity_checked_at,d.full_name,
              d.biometric_status,d.biometric_session_id,d.biometric_reason,d.biometric_checked_at,
              u.phone
       FROM drivers d JOIN users u ON u.id=d.user_id WHERE d.user_id=$1`,
      [user.sub]);
    if (!result.rowCount) throw new NotFoundException('پروفایل پیک پیدا نشد؛ اول درخواست همکاری بده.');
    return result.rows[0] as DriverRow;
  }

  private async view(row: DriverRow) {
    const setting = await this.pool.query(`SELECT value_int FROM platform_settings WHERE key='require_driver_identity'`);
    const identityReady = row.shahkar_matched === true && row.identity_matched === true;
    return {
      configured: this.zohal.configured(),
      biometricConfigured: this.zohal.biometricConfigured(),
      requireIdentity: Number(setting.rows[0]?.value_int ?? 0) === 1,
      nationalCode: row.national_code ? maskNationalCode(row.national_code) : null,
      birthDate: row.birth_date ? new Intl.DateTimeFormat('fa-IR-u-nu-latn', { dateStyle: 'short', calendar: 'persian' }).format(new Date(row.birth_date)) : null,
      cardSerial: row.national_card_serial ? `${row.national_card_serial.slice(0, 3)}•••${row.national_card_serial.slice(-2)}` : null,
      gender: row.gender,
      shahkarMatched: row.shahkar_matched,
      identityMatched: row.identity_matched,
      identityReady,
      firstName: row.identity_first_name,
      lastName: row.identity_last_name,
      fatherName: row.identity_father_name,
      identityCheckedAt: row.identity_checked_at,
      biometricStatus: row.biometric_status,
      biometricReason: row.biometric_reason,
      biometricReasonText: row.biometric_reason ? describeBiometricReason(row.biometric_reason) : null,
      biometricCheckedAt: row.biometric_checked_at,
      hasSession: Boolean(row.biometric_session_id),
      complete: identityReady && row.biometric_status === 'MATCHED',
    };
  }

  async status(user: Principal) {
    return this.view(await this.driverRow(user));
  }

  private async record(input: {
    driverId: string; userId: string; kind: string; ok: boolean; reason?: string | null;
    providerRef?: string | null; latencyMs?: number; metadata?: Record<string, unknown>;
  }) {
    await this.pool.query(
      `INSERT INTO identity_checks(driver_id,user_id,kind,ok,reason,provider_ref,latency_ms,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [input.driverId, input.userId, input.kind, input.ok, input.reason ?? null, input.providerRef ?? null,
        input.latencyMs ?? null, JSON.stringify(input.metadata ?? {})]);
  }

  private rethrow(error: unknown): never {
    if (error instanceof ZohalError) throw new BadGatewayException(error.message);
    throw error;
  }

  /**
   * Shahkar + national registry in one go. Both answers are stored (and audited) even when they
   * say no, so support can see exactly what the registries returned and why the courier is stuck.
   */
  async verify(user: Principal, body: { nationalCode?: unknown; birthDate?: unknown; cardSerial?: unknown; gender?: unknown }) {
    const nationalCode = normalizeNationalCode(body?.nationalCode);
    const birthDate = normalizeBirthDate(body?.birthDate);
    const cardSerial = normalizeCardSerial(body?.cardSerial);
    const gender = normalizeGender(body?.gender);
    await this.rateLimit.enforce(`driver.identity:${user.sub}`, 5, 3600, 'استعلام هویت زیاد تکرار شده');
    const row = await this.driverRow(user);
    let phone: string;
    try {
      phone = normalizeMobile(row.phone);
    } catch {
      throw new BadRequestException('شمارهٔ موبایل حسابت معتبر نیست؛ اول شماره‌ات را در پروفایل درست کن.');
    }
    const duplicate = await this.pool.query(
      `SELECT 1 FROM drivers WHERE national_code=$1 AND user_id<>$2 LIMIT 1`, [nationalCode, user.sub]);
    if (duplicate.rowCount) throw new ConflictException('این کد ملی قبلاً برای یک پیک دیگر ثبت شده؛ اگر اشتباهه با پشتیبانی تماس بگیر.');

    const maskedCode = maskNationalCode(nationalCode);
    let shahkarMatched = false;
    let identity: Awaited<ReturnType<ZohalService['identity']>> | null = null;
    try {
      const shahkar = await this.zohal.shahkar(phone, nationalCode);
      shahkarMatched = shahkar.matched;
      await this.record({
        driverId: row.id, userId: user.sub, kind: 'SHAHKAR', ok: shahkar.matched,
        reason: shahkar.matched ? null : 'NOT_MATCHED', latencyMs: shahkar.latencyMs,
        metadata: { nationalCode: maskedCode },
      });
      identity = await this.zohal.identity(nationalCode, birthDate, gender === 1);
      await this.record({
        driverId: row.id, userId: user.sub, kind: 'ID_INQUIRY', ok: identity.matched,
        reason: identity.matched ? null : 'NOT_MATCHED', latencyMs: identity.latencyMs,
        metadata: { nationalCode: maskedCode },
      });
    } catch (error) {
      await this.record({
        driverId: row.id, userId: user.sub, kind: identity ? 'ID_INQUIRY' : 'SHAHKAR', ok: false,
        reason: (error as ZohalError).code?.slice(0, 80) ?? 'PROVIDER_ERROR',
        metadata: { nationalCode: maskedCode, message: (error as Error).message },
      });
      this.rethrow(error);
    }

    const identityMatched = shahkarMatched && identity.matched;
    const identityChanged = row.national_code !== nationalCode || row.birth_date !== birthDateToIso(birthDate);
    await this.pool.query(
      `UPDATE drivers SET national_code=$2,birth_date=$3,national_card_serial=$4,gender=$5,
         shahkar_matched=$6,identity_matched=$7,identity_first_name=$8,identity_last_name=$9,
         identity_father_name=$10,identity_checked_at=now(),
         full_name=COALESCE(full_name,NULLIF(trim(concat_ws(' ',$8,$9)),'')),
         biometric_status=CASE WHEN $11 THEN 'NONE' ELSE biometric_status END,
         biometric_session_id=CASE WHEN $11 THEN NULL ELSE biometric_session_id END,
         biometric_reason=CASE WHEN $11 THEN NULL ELSE biometric_reason END,
         updated_at=now()
       WHERE id=$1`,
      [row.id, nationalCode, birthDateToIso(birthDate), cardSerial, gender, shahkarMatched, identityMatched,
        identity?.firstName ?? null, identity?.lastName ?? null, identity?.fatherName ?? null, identityChanged]);
    await this.pool.query(
      `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DRIVER_IDENTITY_CHECKED','DRIVER',$2,$3::jsonb)`,
      [user.sub, row.id, JSON.stringify({ shahkarMatched, identityMatched, nationalCode: maskedCode })]);

    if (!shahkarMatched) {
      throw new ConflictException('شمارهٔ موبایلی که با آن وارد شدی به نام این کد ملی ثبت نشده. اگر شماره به نام خودت نیست، با همان شمارهٔ خودت وارد شو.');
    }
    if (identity?.matched !== true) {
      throw new ConflictException('با این کد ملی و تاریخ تولد، اطلاعاتی در ثبت احوال پیدا نشد؛ تاریخ تولد و کد ملی رو دوباره چک کن.');
    }
    if (identity.alive === false) {
      throw new ConflictException('این کد ملی در ثبت احوال «فوت‌شده» ثبت شده؛ با پشتیبانی تماس بگیر.');
    }
    return this.view(await this.driverRow(user));
  }

  /** Upload the selfie video and open a liveness session; the verdict arrives by polling. */
  async submitBiometric(user: Principal, bytes: Uint8Array, mimeInput: string) {
    const mime = String(mimeInput || '').split(';')[0].trim();
    assertVideo(bytes, mime);
    await this.rateLimit.enforce(`driver.biometric:${user.sub}`, 3, 3600, 'ارسال ویدئو زیاد تکرار شده');
    const row = await this.driverRow(user);
    if (row.status !== 'ACTIVE' && row.status !== 'PENDING') throw new ForbiddenException('حساب پیک شما فعال نیست.');
    if (row.shahkar_matched !== true || row.identity_matched !== true || !row.national_code || !row.birth_date || !row.national_card_serial || row.gender === null) {
      throw new ConflictException('اول استعلام هویت (کد ملی، تاریخ تولد و سریال کارت) را انجام بده؛ بعد ویدئو بفرست.');
    }
    if (row.biometric_status === 'PENDING') {
      const recent = await this.pool.query(
        `SELECT 1 FROM identity_checks WHERE driver_id=$1 AND kind='BIOMETRIC_SESSION' AND created_at > now() - interval '10 minutes' LIMIT 1`,
        [row.id]);
      if (recent.rowCount) throw new ConflictException('ویدئوی قبلی‌ات هنوز در حال بررسیه؛ چند دقیقهٔ دیگه نتیجه رو ببین.');
    }
    const birthIso = typeof row.birth_date === 'string' ? row.birth_date.slice(0, 10) : new Date(row.birth_date as unknown as string).toISOString().slice(0, 10);
    const [gy, gm, gd] = birthIso.split('-').map(Number);
    const [bjy, bjm, bjd] = gregorianToJalali(gy, gm, gd);
    const birthText = `${bjy}/${String(bjm).padStart(2, '0')}/${String(bjd).padStart(2, '0')}`;
    let mediaId = '';
    let sessionId = '';
    try {
      const media = await this.zohal.uploadSelfieVideo(bytes, mime);
      mediaId = media.mediaId;
      await this.record({
        driverId: row.id, userId: user.sub, kind: 'BIOMETRIC_UPLOAD', ok: true,
        providerRef: mediaId, latencyMs: media.latencyMs, metadata: { bytes: bytes.length, mime },
      });
      const session = await this.zohal.startLiveness({
        mediaId,
        nationalCode: row.national_code,
        birthDate: birthText,
        cardSerial: row.national_card_serial,
        gender: row.gender === 1 ? 1 : 0,
      });
      sessionId = session.sessionId;
      await this.record({
        driverId: row.id, userId: user.sub, kind: 'BIOMETRIC_SESSION', ok: true,
        providerRef: sessionId, latencyMs: session.latencyMs, metadata: { status: session.status },
      });
    } catch (error) {
      await this.record({
        driverId: row.id, userId: user.sub, kind: sessionId ? 'BIOMETRIC_SESSION' : 'BIOMETRIC_UPLOAD', ok: false,
        reason: (error as ZohalError).code?.slice(0, 80) ?? 'PROVIDER_ERROR', providerRef: sessionId || mediaId || null,
        metadata: { message: (error as Error).message },
      });
      await this.pool.query(`UPDATE drivers SET biometric_status='FAILED',biometric_reason=$2,updated_at=now() WHERE id=$1`,
        [row.id, (error as ZohalError).code?.slice(0, 60) ?? 'PROVIDER_ERROR']);
      this.rethrow(error);
    }
    await this.pool.query(
      `UPDATE drivers SET biometric_status='PENDING',biometric_session_id=$2,biometric_reason=NULL,updated_at=now() WHERE id=$1`,
      [row.id, sessionId]);
    await this.pool.query(
      `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DRIVER_BIOMETRIC_SUBMITTED','DRIVER',$2,$3::jsonb)`,
      [user.sub, row.id, JSON.stringify({ sessionId, bytes: bytes.length })]);
    return this.view(await this.driverRow(user));
  }

  /**
   * Ask the provider what the reviewer decided. Polls are quiet for ten seconds after the last
   * question so a reloaded page cannot burn a paid call per render.
   */
  private async refresh(row: DriverRow, actorId?: string) {
    if (!row.biometric_session_id) return this.view(row);
    const last = await this.pool.query(
      `SELECT created_at FROM identity_checks WHERE driver_id=$1 AND kind='BIOMETRIC_RESULT' ORDER BY created_at DESC LIMIT 1`,
      [row.id]);
    const lastAt = last.rows[0]?.created_at ? new Date(last.rows[0].created_at as string).getTime() : 0;
    if (Date.now() - lastAt < BIOMETRIC_POLL_QUIET_MS) return this.view(row);

    let answer: Awaited<ReturnType<ZohalService['livenessResult']>>;
    try {
      answer = await this.zohal.livenessResult(row.biometric_session_id);
    } catch (error) {
      await this.record({
        driverId: row.id, userId: actorId ?? row.user_id, kind: 'BIOMETRIC_RESULT', ok: false,
        reason: (error as ZohalError).code?.slice(0, 80) ?? 'PROVIDER_ERROR', providerRef: row.biometric_session_id,
        metadata: { message: (error as Error).message },
      });
      this.rethrow(error);
    }
    const finished = answer.status === 'completed' || answer.status === 'failed';
    const matched = finished && answer.result === 'matched' && answer.reason === 'ACCEPT';
    await this.record({
      driverId: row.id, userId: actorId ?? row.user_id, kind: 'BIOMETRIC_RESULT', ok: matched,
      reason: answer.reason || answer.status, providerRef: row.biometric_session_id,
      latencyMs: answer.latencyMs, metadata: { status: answer.status, result: answer.result },
    });
    if (!finished) return this.view(row);
    const status = matched ? 'MATCHED' : 'REJECTED';
    await this.pool.query(
      `UPDATE drivers SET biometric_status=$2,biometric_reason=$3,biometric_checked_at=now(),updated_at=now() WHERE id=$1`,
      [row.id, status, answer.reason || null]);
    if (actorId) {
      await this.pool.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DRIVER_BIOMETRIC_CHECKED','DRIVER',$2,$3::jsonb)`,
        [actorId, row.id, JSON.stringify({ status, reason: answer.reason })]);
    }
    await notify(
      this.pool,
      row.user_id,
      matched ? 'DRIVER_BIOMETRIC_MATCHED' : 'DRIVER_BIOMETRIC_REJECTED',
      matched ? 'احراز هویت بیومتریک تأیید شد' : 'احراز هویت بیومتریک تأیید نشد',
      matched ? 'ویدئوی سلفی‌ات با هویتت مطابقت کرد؛ حالا پرونده‌ات کامل‌تره.' : describeBiometricReason(answer.reason),
      { driverId: row.id },
    ).catch(() => undefined);
    return this.view(await this.driverRow({ sub: row.user_id }));
  }

  /** The courier's own poll: same refresh, scoped to the caller's driver row. */
  async poll(user: Principal) {
    return this.refresh(await this.driverRow(user));
  }

  /** Staff can force one fresh question when a courier calls in stuck on «در حال بررسی». */
  async adminRefresh(driverId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(driverId)) {
      throw new BadRequestException('شناسهٔ پیک معتبر نیست.');
    }
    const result = await this.pool.query(
      `SELECT d.id,d.user_id,d.status,d.national_code,d.birth_date,d.national_card_serial,d.gender,
              d.shahkar_matched,d.identity_matched,d.identity_first_name,d.identity_last_name,
              d.identity_father_name,d.identity_checked_at,d.full_name,
              d.biometric_status,d.biometric_session_id,d.biometric_reason,d.biometric_checked_at,u.phone
       FROM drivers d JOIN users u ON u.id=d.user_id WHERE d.id=$1`, [driverId]);
    if (!result.rowCount) throw new NotFoundException('پیک پیدا نشد.');
    return this.refresh(result.rows[0] as DriverRow, driverId);
  }
}
