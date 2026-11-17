import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

type Principal = { sub: string };
type BusinessStatus = 'PENDING'|'ACTIVE'|'PAUSED'|'REJECTED';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AdminBusinessesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(statusInput?: string) {
    const allowed: BusinessStatus[] = ['PENDING','ACTIVE','PAUSED','REJECTED'];
    if (statusInput && !allowed.includes(statusInput as BusinessStatus)) throw new BadRequestException('فیلتر وضعیت معتبر نیست.');
    const status = statusInput || null;
    const result = await this.pool.query(
      `SELECT b.id,b.name,b.description,b.status,b.created_at AS "createdAt",r.name AS "regionName",u.phone AS "ownerPhone"
       FROM businesses b JOIN regions r ON r.id=b.region_id JOIN users u ON u.id=b.owner_id
       WHERE ($1::business_status IS NULL OR b.status=$1::business_status)
       ORDER BY CASE b.status WHEN 'PENDING' THEN 0 ELSE 1 END,b.created_at DESC LIMIT 100`, [status],
    );
    return result.rows;
  }

  async setStatus(actor: Principal, idInput: unknown, statusInput: unknown) {
    if (typeof idInput !== 'string' || !uuidPattern.test(idInput)) throw new BadRequestException('شناسهٔ کسب‌وکار معتبر نیست.');
    if (!['ACTIVE','REJECTED','PAUSED'].includes(String(statusInput))) throw new BadRequestException('وضعیت جدید معتبر نیست.');
    const next = statusInput as BusinessStatus;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT status FROM businesses WHERE id=$1 FOR UPDATE', [idInput]);
      if (!current.rowCount) throw new NotFoundException('کسب‌وکار پیدا نشد.');
      const before = current.rows[0].status as BusinessStatus;
      const allowed: Record<BusinessStatus, BusinessStatus[]> = {
        PENDING:['ACTIVE','REJECTED'], ACTIVE:['PAUSED'], PAUSED:['ACTIVE'], REJECTED:[],
      };
      if (!allowed[before].includes(next)) throw new ConflictException(`گذار از ${before} به ${next} مجاز نیست.`);
      const result = await client.query('UPDATE businesses SET status=$2 WHERE id=$1 RETURNING id,name,status', [idInput,next]);
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'BUSINESS_STATUS_CHANGED','BUSINESS',$2,$3::jsonb)`,
        [actor.sub,idInput,JSON.stringify({from:before,to:next})],
      );
      await client.query('COMMIT'); return result.rows[0];
    } catch(error) { try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ } throw error; }
    finally { client.release(); }
  }
}
