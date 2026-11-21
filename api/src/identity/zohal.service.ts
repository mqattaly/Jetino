import { ServiceUnavailableException } from '@nestjs/common';

/**
 * The Zohal side of courier verification: Shahkar (is this number on the same national code),
 * the national registry (does this national code + birthday exist, and whose name is on it) and
 * the biometric liveness session (does the face on a fresh selfie match that identity).
 *
 * Contract as published at https://zohal.io/documents (OpenAPI): POST JSON bodies under
 * `/api/v0/services/...`, `Authorization: Bearer <token>`, and every answer wrapped as
 * `{ result, response_body: { data, message, error_code } }`. `result === 1` with a null
 * `error_code` means the enquiry ran; the *answer* may still be "no match", which is never an error.
 */
export type ZohalConfig = {
  token: string;
  biometricToken: string;
  baseUrl: string;
  timeoutMs: number;
};

export function zohalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ZohalConfig {
  const baseUrl = (env.ZOHAL_BASE_URL || 'https://service.zohal.io').replace(/\/+$/, '');
  const timeout = Number(env.ZOHAL_TIMEOUT_MS ?? 12_000);
  const token = (env.ZOHAL_TOKEN ?? '').trim();
  const biometricToken = (env.ZOHAL_BIOMETRIC_TOKEN ?? '').trim();
  return {
    token,
    biometricToken: biometricToken || token,
    baseUrl,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1_000 ? Math.min(timeout, 30_000) : 12_000,
  };
}

export class ZohalError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'ZohalError';
  }
}

/** Provider failures become one sentence a courier or a support agent can act on. */
export function describeZohalFailure(code: string | null | undefined, message?: string | null): string {
  const key = String(code ?? '').toUpperCase();
  const known: Record<string, string> = {
    INVALID_TOKEN: 'کلید دسترسی سرویس استعلام معتبر نیست؛ با پشتیبانی جتینو تماس بگیر.',
    TOKEN_EXPIRED: 'کلید دسترسی سرویس استعلام منقضی شده؛ با پشتیبانی جتینو تماس بگیر.',
    IP_NOT_ALLOWED: 'این سرور اجازهٔ صدا زدن سرویس استعلام را ندارد؛ پشتیبانی باید IP را ثبت کند.',
    INSUFFICIENT_BALANCE: 'اعتبار حساب استعلام تمام شده؛ پشتیبانی جتینو باید شارژ کند.',
    SERVICE_UNAVAILABLE: 'سرویس استعلام الان در دسترس نیست؛ چند دقیقهٔ دیگه دوباره امتحان کن.',
    TIMEOUT: 'سرویس استعلام دیر جواب داد؛ دوباره امتحان کن.',
    ZOHAL_UNREACHABLE: 'به سرویس استعلام وصل نشدیم؛ اینترنت سرور یا دسترسی سرویس را چک کن.',
    ZOHAL_NOT_CONFIGURED: 'سرویس احراز هویت هنوز وصل نشده؛ پشتیبانی جتینو باید کلیدش را ثبت کند.',
    ZOHAL_BAD_RESPONSE: 'پاسخ سرویس استعلام قابل خواندن نبود؛ دوباره امتحان کن.',
  };
  if (known[key]) return known[key];
  // The provider answers in Persian for business errors; pass that through instead of inventing one.
  if (message && /[\u0600-\u06FF]/.test(message)) return message.trim();
  return 'استعلام انجام نشد؛ چند دقیقهٔ دیگه دوباره امتحان کن.';
}

type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
export type ZohalFetch = (url: string, init: RequestInit) => Promise<FetchResponse>;

type Envelope = {
  result?: number;
  response_body?: ({ data?: Record<string, unknown>; message?: string; error_code?: string | null } & Record<string, unknown>) | null;
};

export type ShahkarAnswer = { matched: boolean };
export type IdentityAnswer = {
  matched: boolean;
  firstName: string | null;
  lastName: string | null;
  fatherName: string | null;
  alive: boolean | null;
};
export type BiometricResult = {
  status: 'pending' | 'waiting' | 'processing' | 'completed' | 'failed' | string;
  result: string;
  reason: string;
  completedAt: string | null;
};

export class ZohalService {
  private readonly config: ZohalConfig;
  private readonly fetchImpl: ZohalFetch;

  constructor(env: NodeJS.ProcessEnv = process.env, fetchImpl?: ZohalFetch) {
    this.config = zohalConfigFromEnv(env);
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponse>);
  }

  configured(): boolean {
    return Boolean(this.config.token);
  }

  biometricConfigured(): boolean {
    return Boolean(this.config.biometricToken);
  }

  private requireConfig(biometric = false) {
    if (!this.configured() || (biometric && !this.biometricConfigured())) {
      throw new ServiceUnavailableException(describeZohalFailure('ZOHAL_NOT_CONFIGURED'));
    }
  }

  private async call(path: string, options: { method?: string; body?: unknown; form?: FormData; biometric?: boolean }): Promise<{ body: Record<string, unknown>; latencyMs: number; duration: number }> {
    this.requireConfig(Boolean(options.biometric));
    const startedAt = Date.now();
    const headers: Record<string, string> = { Authorization: `Bearer ${options.biometric ? this.config.biometricToken : this.config.token}` };
    const init: RequestInit = { method: options.method ?? 'POST', headers, signal: AbortSignal.timeout(this.config.timeoutMs) };
    if (options.form) init.body = options.form as unknown as BodyInit;
    else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let response: FetchResponse;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, init);
    } catch (error) {
      const timedOut = (error as { name?: string }).name === 'TimeoutError' || (error as { name?: string }).name === 'AbortError';
      throw new ZohalError(timedOut ? 'TIMEOUT' : 'ZOHAL_UNREACHABLE', describeZohalFailure(timedOut ? 'TIMEOUT' : 'ZOHAL_UNREACHABLE'));
    }
    const latencyMs = Date.now() - startedAt;
    const text = await response.text().catch(() => '');
    let envelope: Envelope;
    try {
      envelope = JSON.parse(text || '{}') as Envelope;
    } catch {
      throw new ZohalError('ZOHAL_BAD_RESPONSE', describeZohalFailure('ZOHAL_BAD_RESPONSE'), response.status);
    }
    const body = (envelope.response_body ?? {}) as Record<string, unknown>;
    const errorCode = (body.error_code ?? null) as string | null;
    if (!response.ok || envelope.result !== 1 || errorCode) {
      const code = errorCode ?? `HTTP_${response.status}`;
      throw new ZohalError(code, describeZohalFailure(code, body.message as string | null), response.status);
    }
    return { body, latencyMs, duration: latencyMs };
  }

  /** Shahkar: is this mobile number registered to this national code? */
  async shahkar(mobile: string, nationalCode: string): Promise<{ matched: boolean; latencyMs: number }> {
    const { body, latencyMs } = await this.call('/api/v0/services/inquiry/shahkar', { body: { mobile, national_code: nationalCode } });
    const data = (body.data ?? {}) as { matched?: unknown };
    return { matched: data.matched === true, latencyMs };
  }

  /** National registry: does this national code + birth date exist, and whose name is on it? */
  async identity(nationalCode: string, birthDate: string, male: boolean): Promise<IdentityAnswer & { latencyMs: number }> {
    const { body, latencyMs } = await this.call('/api/v0/services/inquiry/national_identity_inquiry', {
      body: { national_code: nationalCode, birth_date: birthDate, gender: male },
    });
    const data = (body.data ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    const decision = (value: unknown) => (typeof value === 'boolean' ? value : null);
    return {
      matched: data.matched === true,
      firstName: text(data.first_name),
      lastName: text(data.last_name),
      fatherName: text(data.father_name),
      alive: decision(data.alive) ?? (data.is_dead === true ? false : null),
      latencyMs,
    };
  }

  /** Step one of the biometric flow: park the selfie video and get a media id back. */
  async uploadSelfieVideo(bytes: Uint8Array, mime: string): Promise<{ mediaId: string; latencyMs: number }> {
    const form = new FormData();
    const extension = mime.includes('mp4') ? 'mp4' : mime.includes('quicktime') ? 'mov' : 'webm';
    form.append('type', 'selfie_video');
    form.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), `selfie.${extension}`);
    const { body, latencyMs } = await this.call('/api/v0/services/biometric/media/', { form, biometric: true });
    const mediaId = typeof body.id === 'string' ? body.id : '';
    if (!mediaId) throw new ZohalError('ZOHAL_BAD_RESPONSE', describeZohalFailure('ZOHAL_BAD_RESPONSE'));
    return { mediaId, latencyMs };
  }

  /** Step two: open a liveness session against that media and the claimed identity. */
  async startLiveness(input: { mediaId: string; nationalCode: string; birthDate: string; cardSerial: string; gender: 0 | 1 }): Promise<{ sessionId: string; status: string; latencyMs: number }> {
    const { body, latencyMs } = await this.call('/api/v0/services/biometric/session/liveness/', {
      biometric: true,
      body: {
        media: { selfie_video: input.mediaId },
        national_code: input.nationalCode,
        birth_date: input.birthDate,
        national_card_serial: input.cardSerial,
        gender: input.gender,
      },
    });
    const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
    if (!sessionId) throw new ZohalError('ZOHAL_BAD_RESPONSE', describeZohalFailure('ZOHAL_BAD_RESPONSE'));
    return { sessionId, status: typeof body.status === 'string' ? body.status : 'pending', latencyMs };
  }

  /** Step three: ask what the reviewer decided. Nothing is retried — every call is billed. */
  async livenessResult(sessionId: string): Promise<BiometricResult & { latencyMs: number }> {
    const { body, latencyMs } = await this.call(`/api/v0/services/biometric/session/${encodeURIComponent(sessionId)}/result/`, { method: 'GET', biometric: true });
    return {
      status: typeof body.status === 'string' ? body.status : 'pending',
      result: typeof body.result === 'string' ? body.result : '',
      reason: typeof body.reason === 'string' ? body.reason : '',
      completedAt: typeof body.completed_at === 'string' ? body.completed_at : null,
      latencyMs,
    };
  }
}
