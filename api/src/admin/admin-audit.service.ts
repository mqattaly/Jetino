import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

/**
 * Read-only view over the trail the platform already writes for every sensitive
 * mutation. Two rules shape it: staff see who did what, but never a wider slice
 * of personal data than the operation needs — so phone numbers come back masked
 * and metadata keys that smell like credentials are dropped server side — and
 * each read is itself recorded, because an audit log that can be browsed
 * anonymously cannot be trusted.
 */

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actionName = /^[A-Z][A-Z0-9_]{2,119}$/;
const SENSITIVE_KEY = /(otp|code|token|secret|password|passwd|api[-_]?key|access[-_]?key|authorization|cookie|session)/i;
const MAX_PAGE = 100;
const MAX_OFFSET = 5_000;
const DEFAULT_PAGE = 25;

type Principal = { sub: string };
type RawAuditRow = { id: string; action: string; entityType: string; entityId: string | null; metadata: unknown; createdAt: Date; actorName: string | null; actorPhone: string | null };
export type AuditEntry = { id: string; action: string; entityType: string; entityId: string | null; createdAt: string; actorName: string | null; actorPhone: string | null; metadata: Record<string, unknown>; redacted: number };
type Filters = { action?: unknown; actorId?: unknown; entityId?: unknown; since?: unknown; until?: unknown; limit?: unknown; offset?: unknown };

export type AuditQuery = { where: string[]; values: unknown[]; applied: Record<string, string> };

@Injectable()
export class AdminAuditService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Pure so the exactness of every filter can be asserted without a database. */
  static buildFilters(filters: Filters): AuditQuery {
    const where: string[] = [];
    const values: unknown[] = [];
    const applied: Record<string, string> = {};
    const push = (field: string, clause: string, value: string) => { values.push(value); where.push(clause.replace('?', `$${values.length}`)); applied[field] = value; };

    if (filters.action !== undefined && filters.action !== '') {
      if (typeof filters.action !== 'string' || !actionName.test(filters.action)) throw new BadRequestException('نام عملیات حسابرسی معتبر نیست.');
      push('action', 'a.action = ?', filters.action);
    }
    if (filters.actorId !== undefined && filters.actorId !== '') {
      if (typeof filters.actorId !== 'string' || !uuid.test(filters.actorId)) throw new BadRequestException('شناسهٔ کاربر معتبر نیست.');
      push('actorId', 'a.actor_id = ?', filters.actorId);
    }
    if (filters.entityId !== undefined && filters.entityId !== '') {
      const entityId = typeof filters.entityId === 'string' ? filters.entityId.trim() : '';
      if (!entityId || entityId.length > 120) throw new BadRequestException('شناسهٔ موجودیت معتبر نیست.');
      push('entityId', 'a.entity_id = ?', entityId);
    }
    for (const key of ['since', 'until'] as const) {
      const raw = filters[key];
      if (raw === undefined || raw === '') continue;
      if (typeof raw !== 'string') throw new BadRequestException('تاریخ معتبر نیست.');
      const parsed = new Date(raw);
      if (!Number.isFinite(parsed.getTime())) throw new BadRequestException('تاریخ معتبر نیست.');
      const normalized = parsed.toISOString();
      values.push(normalized);
      where.push(`a.created_at ${key === 'since' ? '>=' : '<='} $${values.length}::timestamptz`);
      applied[key] = normalized;
    }
    return { where, values, applied };
  }

  static page(limitInput: unknown, offsetInput: unknown): { limit: number; offset: number } {
    const rawLimit = limitInput === undefined || limitInput === '' ? DEFAULT_PAGE : Number(limitInput);
    const rawOffset = offsetInput === undefined || offsetInput === '' ? 0 : Number(offsetInput);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || !Number.isInteger(rawOffset) || rawOffset < 0) throw new BadRequestException('صفحه‌بندی معتبر نیست.');
    // deep offsets are a free way to make the database walk the whole log, so paging stops at a window
    return { limit: Math.min(rawLimit, MAX_PAGE), offset: Math.min(rawOffset, MAX_OFFSET) };
  }

  /**
   * Metadata is written by the server, but it is still free-form JSON: strip any
   * key that could carry a credential and tell the caller something was hidden.
   */
  static redact(metadata: unknown): { value: Record<string, unknown>; redacted: number } {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { value: {}, redacted: 0 };
    const value: Record<string, unknown> = {};
    let redacted = 0;
    for (const [key, entry] of Object.entries(metadata as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) { redacted += 1; continue; }
      value[key] = entry;
    }
    return { value, redacted };
  }

  /** Enough to recognise the actor without handing the whole phone book over. */
  static maskPhone(phone: unknown): string | null {
    if (typeof phone !== 'string') return null;
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 4 ? `${'•'.repeat(Math.max(3, digits.length - 4))}${digits.slice(-4)}` : null;
  }

  async list(actor: Principal, filters: Filters) {
    const { where, values, applied } = AdminAuditService.buildFilters(filters);
    const { limit, offset } = AdminAuditService.page(filters.limit, filters.offset);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows, count] = await Promise.all([
      this.pool.query(
        `SELECT a.id,a.action,a.entity_type AS "entityType",a.entity_id AS "entityId",a.metadata,a.created_at AS "createdAt",
                u.display_name AS "actorName",u.phone AS "actorPhone"
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         ${clause}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset],
      ),
      this.pool.query(`SELECT COUNT(*)::int AS "totalMatches" FROM audit_logs a ${clause}`, values),
    ]);
    const items: AuditEntry[] = (rows.rows as RawAuditRow[]).map(row => {
      const { value, redacted } = AdminAuditService.redact(row.metadata);
      return {
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        actorName: row.actorName,
        actorPhone: AdminAuditService.maskPhone(row.actorPhone),
        metadata: value,
        redacted,
      };
    });
    // actor_id is a uuid and entity_id a varchar, so the same value needs two
    // placeholders — one parameter bound to both types makes PostgreSQL refuse the statement
    await this.pool.query(
      `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'ADMIN_AUDIT_READ','AUDIT_QUERY',$2,$3::jsonb)`,
      [actor.sub, actor.sub, JSON.stringify({ ...applied, rows: items.length, totalMatches: count.rows[0]?.totalMatches ?? 0 })],
    );
    return { items, totalMatches: count.rows[0]?.totalMatches ?? 0, limit, offset };
  }

  /** The vocabulary actually present in the log, so the UI never invents filters. */
  async actions() {
    const result = await this.pool.query(
      `SELECT a.action,COUNT(*)::int AS occurrences,MAX(a.created_at) AS "lastUsed"
       FROM audit_logs a GROUP BY a.action ORDER BY COUNT(*) DESC, a.action`,
    );
    return { items: result.rows };
  }
}
