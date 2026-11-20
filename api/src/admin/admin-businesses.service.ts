import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { notify } from '../notifications/notifications.util';
import { BusinessesService } from '../businesses/businesses.service';
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
      `SELECT b.id,b.name,b.description,b.status,b.created_at AS "createdAt",b.address_text AS "addressText",b.contact_phone AS "contactPhone",b.working_hours AS "workingHours",b.decision_note AS "decisionNote",b.admin_suspended AS "adminSuspended",r.name AS "regionName",u.phone AS "ownerPhone"
       FROM businesses b JOIN regions r ON r.id=b.region_id JOIN users u ON u.id=b.owner_id
       WHERE ($1::business_status IS NULL OR b.status=$1::business_status)
       ORDER BY CASE b.status WHEN 'PENDING' THEN 0 ELSE 1 END,b.created_at DESC LIMIT 100`, [status],
    );
    return result.rows;
  }

  async create(actor: Principal, body: {phone?:unknown;name?:unknown;description?:unknown;regionSlug?:unknown;addressText?:unknown;contactPhone?:unknown;workingHours?:unknown;applicationKey?:unknown}) {
    const raw=typeof body?.phone==='string'?body.phone.replace(/[\s()-]/g,''):'';
    const phone=/^09\d{9}$/.test(raw)?`+98${raw.slice(1)}`:raw;
    if (!/^\+989\d{9}$/.test(phone)) throw new BadRequestException('شمارهٔ مالک معتبر نیست.');
    const found=await this.pool.query('SELECT id FROM users WHERE phone=$1',[phone]);
    if (!found.rowCount) throw new NotFoundException('مالک باید ابتدا با شمارهٔ خود وارد سامانه شود.');
    return new BusinessesService(this.pool).create({sub:found.rows[0].id}, body, actor.sub);
  }

  async setStatus(actor: Principal, idInput: unknown, statusInput: unknown, noteInput?: unknown) {
    if (typeof idInput !== 'string' || !uuidPattern.test(idInput)) throw new BadRequestException('شناسهٔ کسب‌وکار معتبر نیست.');
    if (!['ACTIVE','REJECTED','PAUSED'].includes(String(statusInput))) throw new BadRequestException('وضعیت جدید معتبر نیست.');
    const next = statusInput as BusinessStatus;
    const note=typeof noteInput==='string'?noteInput.trim():'';
    if(note.length>300) throw new BadRequestException('دلیل بیش از حد طولانی است.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT status,owner_id,admin_suspended FROM businesses WHERE id=$1 FOR UPDATE', [idInput]);
      if (!current.rowCount) throw new NotFoundException('کسب‌وکار پیدا نشد.');
      const before = current.rows[0].status as BusinessStatus;
      const allowed: Record<BusinessStatus, BusinessStatus[]> = {
        PENDING:['ACTIVE','REJECTED'], ACTIVE:['PAUSED'], PAUSED:['ACTIVE'], REJECTED:[],
      };
      if (!allowed[before].includes(next) && !(before==='PAUSED' && next==='PAUSED' && !current.rows[0].admin_suspended)) throw new ConflictException(`گذار از ${before} به ${next} مجاز نیست.`);
      const result = await client.query("UPDATE businesses SET status=$2,admin_suspended=($2::business_status='PAUSED'),decision_note=$3 WHERE id=$1 RETURNING id,name,status", [idInput,next,note || null]);
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'BUSINESS_STATUS_CHANGED','BUSINESS',$2,$3::jsonb)`,
        [actor.sub,idInput,JSON.stringify({from:before,to:next,note})],
      );
      if (current.rows[0].owner_id) await notify(client,current.rows[0].owner_id,'BUSINESS_STATUS_CHANGED',next==='ACTIVE'?'کسب‌وکار فعال شد':next==='REJECTED'?'درخواست کسب‌وکار رد شد':'کسب‌وکار تعلیق شد',note || (next==='ACTIVE'?'می‌توانید از پنل کسب‌وکار استفاده کنید.':'برای راهنمایی با پشتیبانی تماس بگیرید.'),{businessId:idInput,status:next});
      await client.query('COMMIT'); return result.rows[0];
    } catch(error) { try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ } throw error; }
    finally { client.release(); }
  }
}
