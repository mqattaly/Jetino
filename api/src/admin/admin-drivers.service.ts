import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { notify } from '../notifications/notifications.util';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class AdminDriversService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async list(){const result=await this.pool.query(`SELECT d.id,d.status,d.created_at AS "createdAt",u.phone,r.name AS "regionName",d.full_name AS "fullName",d.plate_number AS "plateNumber",d.vehicle_type AS "vehicleType",d.photo_url AS "photoUrl",d.verification_status AS "verificationStatus",d.verification_submitted_at AS "verificationSubmittedAt",(d.full_name IS NOT NULL AND d.plate_number IS NOT NULL AND d.photo_url IS NOT NULL AND d.vehicle_type IS NOT NULL) AS "profileComplete" FROM drivers d JOIN users u ON u.id=d.user_id JOIN regions r ON r.id=d.region_id ORDER BY d.status,d.created_at DESC`);return result.rows;}
  async create(actor:string,body:{phone?:unknown;regionSlug?:unknown}){
    if(typeof body?.phone!=='string')throw new BadRequestException('شمارهٔ موبایل معتبر نیست.');
    const raw=body.phone.replace(/[\s()-]/g,'');const phone=/^09\d{9}$/.test(raw)?`+98${raw.slice(1)}`:raw;
    if(!/^\+989\d{9}$/.test(phone))throw new BadRequestException('شمارهٔ موبایل معتبر ایران را وارد کنید.');
    const regionSlug=typeof body.regionSlug==='string'?body.regionSlug:'bandar-khamir';const client=await this.pool.connect();
    try{await client.query('BEGIN');const user=await client.query('SELECT id FROM users WHERE phone=$1 FOR UPDATE',[phone]);if(!user.rowCount)throw new NotFoundException('کاربر باید ابتدا با OTP وارد شود.');const region=await client.query('SELECT id FROM regions WHERE slug=$1 AND is_active=true',[regionSlug]);if(!region.rowCount)throw new NotFoundException('منطقهٔ فعال پیدا نشد.');
      const driver=await client.query(`INSERT INTO drivers(user_id,region_id,status) VALUES($1,$2,'ACTIVE') RETURNING id,status,created_at AS "createdAt"`,[user.rows[0].id,region.rows[0].id]);
      await client.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'DRIVER') ON CONFLICT DO NOTHING`,[user.rows[0].id]);
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DRIVER_REGISTERED','DRIVER',$2,$3::jsonb)`,[actor,driver.rows[0].id,JSON.stringify({userId:user.rows[0].id,regionSlug})]);
      await client.query('COMMIT');return {...driver.rows[0],phone,regionSlug};
    }catch(error:unknown){try{await client.query('ROLLBACK');}catch{/* closed */}if((error as {code?:string}).code==='23505')throw new ConflictException('این کاربر قبلاً راننده شده است.');throw error;}finally{client.release();}
  }

  /** Everything waiting for a human: newest submission first, with the documents attached. */
  async verificationQueue(statusInput?: string) {
    const status = statusInput || 'PENDING';
    if (!['PENDING', 'APPROVED', 'REJECTED', 'UNVERIFIED'].includes(status)) throw new BadRequestException('وضعیت تأیید معتبر نیست.');
    const result = await this.pool.query(
      `SELECT d.id,d.full_name AS "fullName",d.plate_number AS "plateNumber",d.vehicle_type AS "vehicleType",
              d.photo_url AS "photoUrl",d.id_card_url AS "idCardUrl",d.selfie_url AS "selfieUrl",
              d.verification_status AS "verificationStatus",d.verification_note AS "verificationNote",
              d.verification_submitted_at AS "submittedAt",u.phone,r.name AS "regionName"
       FROM drivers d JOIN users u ON u.id=d.user_id JOIN regions r ON r.id=d.region_id
       WHERE d.verification_status=$1 ORDER BY d.verification_submitted_at NULLS LAST,d.created_at DESC LIMIT 100`,
      [status],
    );
    return result.rows;
  }

  /**
   * Approving means a person compared the selfie with the profile photo and the ID
   * card and ticked `selfieMatch`. There is no automatic face comparison here, and
   * the API refuses to approve without that tick so the record never claims one.
   */
  async decideVerification(actor: string, id: string, body: { status?: unknown; note?: unknown; selfieMatch?: unknown }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('شناسهٔ راننده معتبر نیست.');
    const status = body?.status;
    if (status !== 'APPROVED' && status !== 'REJECTED') throw new BadRequestException('نتیجهٔ بررسی معتبر نیست.');
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 300) throw new BadRequestException('توضیح بررسی حداکثر ۳۰۰ نویسه است.');
    const selfieMatch = body.selfieMatch === true;
    if (status === 'APPROVED' && !selfieMatch) throw new BadRequestException('برای تأیید، ابتدا تطبیق چهرهٔ سلفی با عکس پروفایل و کارت ملی را تأیید کنید.');
    if (status === 'REJECTED' && note.length < 3) throw new BadRequestException('برای رد مدارک، دلیل را دست‌کم در ۳ نویسه بنویسید.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`SELECT id,user_id,verification_status,id_card_url,selfie_url FROM drivers WHERE id=$1 FOR UPDATE`, [id]);
      if (!current.rowCount) throw new NotFoundException('راننده پیدا نشد.');
      const row = current.rows[0];
      if (row.verification_status !== 'PENDING') throw new ConflictException('این راننده مدارکی در صف بررسی ندارد.');
      if (!row.id_card_url || !row.selfie_url) throw new ConflictException('مدارک این راننده کامل نیست؛ از او بخواهید دوباره ارسال کند.');
      const updated = await client.query(
        `UPDATE drivers SET verification_status=$2,verification_note=$3,verified_at=CASE WHEN $2='APPROVED' THEN now() ELSE NULL END,verified_by=$4,updated_at=now()
         WHERE id=$1 RETURNING id,verification_status AS "status",verification_note AS "note",verified_at AS "verifiedAt"`,
        [id, status, note || null, actor],
      );
      await client.query(`INSERT INTO driver_verification_history(driver_id,status,note,selfie_match,actor_id) VALUES($1,$2,$3,$4,$5)`, [id, status, note || null, selfieMatch, actor]);
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'DRIVER',$3,$4::jsonb)`, [actor, status === 'APPROVED' ? 'DRIVER_VERIFICATION_APPROVED' : 'DRIVER_VERIFICATION_REJECTED', id, JSON.stringify({ note, selfieMatch })]);
      await notify(
        client,
        row.user_id,
        status === 'APPROVED' ? 'DRIVER_VERIFICATION_APPROVED' : 'DRIVER_VERIFICATION_REJECTED',
        status === 'APPROVED' ? 'مدارک شما تأیید شد' : 'مدارک شما تأیید نشد',
        status === 'APPROVED' ? 'اکنون می‌توانید مأموریت بگیرید.' : `دلیل: ${note} — می‌توانید مدارک را دوباره ارسال کنید.`,
        { driverId: id, status },
      );
      await client.query('COMMIT');
      return { ...updated.rows[0], selfieMatch };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async setStatus(actor:string,id:string,status:unknown){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('شناسهٔ راننده معتبر نیست.');
    if(status!=='ACTIVE'&&status!=='SUSPENDED') throw new BadRequestException('وضعیت راننده معتبر نیست.');
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current=await client.query('SELECT id,user_id,status FROM drivers WHERE id=$1 FOR UPDATE',[id]);
      if(!current.rowCount) throw new NotFoundException('راننده پیدا نشد.');
      if(current.rows[0].status===status){await client.query('COMMIT');return {id,status};}
      if(status==='SUSPENDED'){
        const open=await client.query(`SELECT 1 FROM delivery_assignments da JOIN orders o ON o.id=da.order_id WHERE da.driver_id=$1 AND (o.status IN ('DRIVER_ASSIGNED','OUT_FOR_DELIVERY') OR (o.status='DELIVERED' AND o.payment_status='PENDING')) LIMIT 1`,[id]);
        if(open.rowCount) throw new ConflictException('ابتدا مأموریت جاری یا وصول نقدی این راننده را تعیین تکلیف کنید.');
      }
      const result=await client.query(`UPDATE drivers SET status=$2,updated_at=now() WHERE id=$1 RETURNING id,status`,[id,status]);
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DRIVER_STATUS_CHANGED','DRIVER',$2,$3::jsonb)`,[actor,id,JSON.stringify({from:current.rows[0].status,status})]);
      await notify(client,current.rows[0].user_id,'DRIVER_STATUS_CHANGED',status==='ACTIVE'?'حساب راننده فعال شد':'حساب راننده تعلیق شد',status==='ACTIVE'?'اکنون می‌توانید از پنل راننده استفاده کنید.':'برای راهنمایی با پشتیبانی تماس بگیرید.',{driverId:id,status});
      await client.query('COMMIT');return result.rows[0];
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }
}
