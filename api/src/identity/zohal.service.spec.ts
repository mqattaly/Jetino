import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import { ZohalError, ZohalService, describeZohalFailure, zohalConfigFromEnv } from './zohal.service';

type Call = { url: string; init: RequestInit };

function fakeFetch(reply: { status?: number; body?: unknown; text?: string; throws?: Error }, calls: Call[] = []) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (reply.throws) throw reply.throws;
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      text: async () => reply.text ?? JSON.stringify(reply.body ?? {}),
    };
  };
}

const env = { ZOHAL_TOKEN: 'token-1', ZOHAL_BIOMETRIC_TOKEN: 'bio-1', ZOHAL_BASE_URL: 'https://service.test/', ZOHAL_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv;

describe('ZohalService · the provider contract', () => {
  it('reads the published defaults and falls back to the main token for biometric calls', () => {
    assert.deepEqual(zohalConfigFromEnv({} as NodeJS.ProcessEnv), {
      token: '', biometricToken: '', baseUrl: 'https://service.zohal.io', timeoutMs: 12_000,
    });
    const config = zohalConfigFromEnv(env);
    assert.equal(config.baseUrl, 'https://service.test', 'a trailing slash is trimmed, never doubled');
    assert.equal(config.biometricToken, 'bio-1');
    assert.equal(zohalConfigFromEnv({ ZOHAL_TOKEN: 'only-main' } as NodeJS.ProcessEnv).biometricToken, 'only-main');
  });

  it('treats a Shahkar “no match” as an answer, not a failure', async () => {
    const calls: Call[] = [];
    const service = new ZohalService(env, fakeFetch({
      body: { result: 1, response_body: { data: { matched: false }, message: 'موفق', error_code: null } },
    }, calls));
    const answer = await service.shahkar('09123456789', '0012345678');
    assert.equal(answer.matched, false);
    assert.equal(typeof answer.latencyMs, 'number');
    assert.equal(calls[0].url, 'https://service.test/api/v0/services/inquiry/shahkar');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer token-1');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { mobile: '09123456789', national_code: '0012345678' });
  });

  it('returns the registry name and refuses to call an error a “no match”', async () => {
    const service = new ZohalService(env, fakeFetch({
      body: { result: 1, response_body: { data: { matched: true, first_name: 'مریم', last_name: 'رضایی', father_name: 'حسن', alive: true }, message: 'موفق', error_code: null } },
    }));
    const answer = await service.identity('0012345678', '1377/06/30', false);
    assert.equal(answer.firstName, 'مریم');
    assert.equal(answer.lastName, 'رضایی');
    assert.equal(answer.alive, true);

    const failing = new ZohalService(env, fakeFetch({
      status: 200,
      body: { result: 1, response_body: { data: {}, message: 'اعتبار کافی نیست', error_code: 'INSUFFICIENT_BALANCE' } },
    }));
    await assert.rejects(failing.identity('0012345678', '1377/06/30', true), (error: unknown) => {
      assert.ok(error instanceof ZohalError);
      assert.equal(error.code, 'INSUFFICIENT_BALANCE');
      assert.match(error.message, /اعتبار/);
      return true;
    });
  });

  it('turns a timeout and an unreadable body into words a person can act on', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const offline = new ZohalService(env, fakeFetch({ throws: timeout }));
    await assert.rejects(offline.shahkar('09123456789', '0012345678'), (error: unknown) => {
      assert.equal((error as ZohalError).code, 'TIMEOUT');
      assert.match((error as Error).message, /دیر جواب داد/);
      return true;
    });
    const garbage = new ZohalService(env, fakeFetch({ text: '<html>502</html>' }));
    await assert.rejects(garbage.shahkar('09123456789', '0012345678'), (error: unknown) => {
      assert.equal((error as ZohalError).code, 'ZOHAL_BAD_RESPONSE');
      return true;
    });
  });

  it('refuses to call the provider at all when no token is set', async () => {
    const service = new ZohalService({} as NodeJS.ProcessEnv, fakeFetch({}));
    await assert.rejects(service.shahkar('09123456789', '0012345678'), ServiceUnavailableException);
    assert.equal(service.configured(), false);
  });

  it('uploads the selfie as multipart with the biometric token', async () => {
    const calls: Call[] = [];
    const service = new ZohalService(env, fakeFetch({ body: { result: 1, response_body: { id: 'media-1', type: 'selfie_video' } } }, calls));
    const answer = await service.uploadSelfieVideo(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]), 'video/webm');
    assert.equal(answer.mediaId, 'media-1');
    assert.equal(calls[0].url, 'https://service.test/api/v0/services/biometric/media/');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer bio-1');
    const form = calls[0].init.body as FormData;
    assert.equal(form.get('type'), 'selfie_video');
    assert.ok(form.get('file'));
  });

  it('opens the session with the identity the courier claims', async () => {
    const calls: Call[] = [];
    const service = new ZohalService(env, fakeFetch({ body: { result: 1, response_body: { session_id: 's-1', status: 'pending' } } }, calls));
    const session = await service.startLiveness({ mediaId: 'media-1', nationalCode: '0012345678', birthDate: '1377/06/30', cardSerial: '1234567890', gender: 0 });
    assert.equal(session.sessionId, 's-1');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      media: { selfie_video: 'media-1' }, national_code: '0012345678', birth_date: '1377/06/30',
      national_card_serial: '1234567890', gender: 0,
    });
  });

  it('reads the final verdict, including the reason code', async () => {
    const calls: Call[] = [];
    const service = new ZohalService(env, fakeFetch({
      body: { result: 1, response_body: { result: 'rejected', reason: 'REJECT_VIDEO_NOT_LIVE', type: 'Liveness', status: 'failed', completed_at: '2026-11-17T10:00:00' } },
    }, calls));
    const answer = await service.livenessResult('s-1');
    assert.equal(answer.reason, 'REJECT_VIDEO_NOT_LIVE');
    assert.equal(answer.status, 'failed');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].url, 'https://service.test/api/v0/services/biometric/session/s-1/result/');
  });

  it('keeps the provider’s Persian business message instead of inventing one', () => {
    assert.match(describeZohalFailure('X_UNKNOWN', 'کد ملی یافت نشد'), /کد ملی یافت نشد/);
    assert.match(describeZohalFailure('IP_NOT_ALLOWED', null), /IP/);
    assert.match(describeZohalFailure('X_UNKNOWN', 'not found'), /دوباره امتحان کن/);
  });
});
