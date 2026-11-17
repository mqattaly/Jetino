import { Inject, Injectable, ServiceUnavailableException, HttpException, HttpStatus, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class AuthService {
  private readonly jwt = new JwtService();
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private normalizePhone(input: unknown): string {
    if (typeof input !== 'string') throw new BadRequestException('شماره موبایل معتبر نیست.');
    const phone = input.replace(/[\s()-]/g, '');
    if (/^09\d{9}$/.test(phone)) return `+98${phone.slice(1)}`;
    if (/^\+989\d{9}$/.test(phone)) return phone;
    throw new BadRequestException('شماره موبایل معتبر ایران را وارد کنید.');
  }

  private digest(phone: string, code: string): string {
    const secret = process.env.OTP_HMAC_SECRET;
    if (!secret || secret.length < 32) throw new ServiceUnavailableException('سرویس ورود هنوز پیکربندی نشده است.');
    return createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex');
  }

  async requestOtp(input: unknown) {
    const phone = this.normalizePhone(input);
    const apiKey = process.env.KAVENEGAR_API_KEY;
    const template = process.env.KAVENEGAR_OTP_TEMPLATE;
    if (!apiKey || !template) throw new ServiceUnavailableException('ارسال پیامک هنوز پیکربندی نشده است.');
    const recent = await this.pool.query(
      `SELECT count(*)::int AS count FROM otp_challenges WHERE phone=$1 AND created_at > now() - interval '15 minutes'`, [phone],
    );
    if (recent.rows[0].count >= 3) throw new HttpException('تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.', HttpStatus.TOO_MANY_REQUESTS);

    const code = String(randomInt(100000, 1000000));
    const inserted = await this.pool.query(
      `INSERT INTO otp_challenges(phone,code_digest,expires_at) VALUES($1,$2,now()+interval '5 minutes') RETURNING id`,
      [phone, this.digest(phone, code)],
    );
    const url = new URL(`https://api.kavenegar.com/v1/${encodeURIComponent(apiKey)}/verify/lookup.json`);
    url.searchParams.set('receptor', phone);
    url.searchParams.set('token', code);
    url.searchParams.set('template', template);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const result = await response.json() as { return?: { status?: number } };
      if (!response.ok || result.return?.status !== 200) throw new Error('SMS provider rejected the request');
    } catch {
      await this.pool.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [inserted.rows[0].id]);
      throw new ServiceUnavailableException('ارسال پیامک انجام نشد؛ لطفاً کمی بعد دوباره تلاش کنید.');
    }
    return { message: 'اگر شماره معتبر باشد، کد ورود ارسال می‌شود.', expiresInSeconds: 300 };
  }

  async verifyOtp(phoneInput: unknown, codeInput: unknown) {
    const phone = this.normalizePhone(phoneInput);
    if (typeof codeInput !== 'string' || !/^\d{6}$/.test(codeInput)) throw new BadRequestException('کد ورود معتبر نیست.');
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret || jwtSecret.length < 32) throw new ServiceUnavailableException('ورود هنوز پیکربندی نشده است.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const challenge = await client.query(
        `SELECT id,code_digest,attempts FROM otp_challenges WHERE phone=$1 AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [phone],
      );
      if (!challenge.rowCount || challenge.rows[0].attempts >= 5) {
        await client.query('ROLLBACK');
        throw new UnauthorizedException('کد ورود نامعتبر یا منقضی شده است.');
      }
      const row = challenge.rows[0] as { id: string; code_digest: string; attempts: number };
      const candidate = Buffer.from(this.digest(phone, codeInput), 'hex');
      const expected = Buffer.from(row.code_digest, 'hex');
      const valid = candidate.length === expected.length && timingSafeEqual(candidate, expected);
      if (!valid) {
        await client.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [row.id]);
        await client.query('COMMIT');
        throw new UnauthorizedException('کد ورود نامعتبر یا منقضی شده است.');
      }
      await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [row.id]);
      const userResult = await client.query(
        `INSERT INTO users(phone) VALUES($1) ON CONFLICT(phone) DO UPDATE SET updated_at=now() RETURNING id,phone,display_name`, [phone],
      );
      const user = userResult.rows[0] as { id: string; phone: string; display_name: string | null };
      await client.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'CUSTOMER') ON CONFLICT DO NOTHING`, [user.id]);
      const roles = await client.query('SELECT role FROM user_roles WHERE user_id=$1 ORDER BY role', [user.id]);
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES($1,'AUTH_OTP_LOGIN','USER',$1)`, [user.id]);
      await client.query('COMMIT');
      const roleNames = roles.rows.map((item: { role: string }) => item.role);
      const accessToken = await this.jwt.signAsync(
        { sub: user.id, phone: user.phone, roles: roleNames },
        { secret: process.env.JWT_SECRET, expiresIn: '12h', issuer: 'jetino-api', audience: 'jetino-client' },
      );
      return { accessToken, tokenType: 'Bearer', expiresIn: 43200, user: { id: user.id, phone: user.phone, displayName: user.display_name, roles: roleNames } };
    } catch (error) {
      // Harmless after a transaction has already committed.
      try { await client.query('ROLLBACK'); } catch { /* connection is already outside a transaction */ }
      throw error;
    } finally {
      client.release();
    }
  }
}
