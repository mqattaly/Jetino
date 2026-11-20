import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';
import { normalizePlate, parseImageUrl } from '../security/security.util';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const vehicles = ['MOTORCYCLE','CAR','BICYCLE','OTHER'];
type ApplicationInput = { fullName?: unknown; vehicleType?: unknown; note?: unknown; regionSlug?: unknown; plateNumber?: unknown; photoUrl?: unknown };
@Injectable()
export class PartnersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async myDriverApplications(userId: string) {
    const result = await this.pool.query(`SELECT a.id,a.full_name AS "fullName",a.vehicle_type AS "vehicleType",a.plate_number AS "plateNumber",a.photo_url AS "photoUrl",a.note,a.status,a.decision_note AS "decisionNote",a.created_at AS "createdAt",r.name AS "regionName",d.status AS "driverStatus" FROM driver_applications a JOIN regions r ON r.id=a.region_id LEFT JOIN drivers d ON d.user_id=a.user_id WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 30`, [userId]);
    return result.rows;
  }
  async applyDriver(userId: string, body: ApplicationInput) {
    const fullName = typeof body?.fullName === 'string' ? body.fullName.trim() : '';
    const vehicleType = typeof body?.vehicleType === 'string' ? body.vehicleType : '';
    const note = typeof body?.note === 'string' ? body.note.trim() : '';
    const slug = typeof body?.regionSlug === 'string' ? body.regionSlug.trim() : 'bandar-khamir';
    if (fullName.length < 2 || fullName.length > 120 || !vehicles.includes(vehicleType) || note.length > 500 || slug.length > 120) throw new BadRequestException('نام، نوع وسیله یا توضیحات معتبر نیست.');
    // The customer checks this identity at the door, so the plate and photo belong to the application itself.
    const plateNumber = normalizePlate(body?.plateNumber);
    const photoUrl = parseImageUrl(body?.photoUrl, 'عکس راننده');
    if (!photoUrl) throw new BadRequestException('عکس راننده برای ثبت درخواست الزامی است.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      if (!user.rowCount) throw new NotFoundException('کاربر پیدا نشد.');
      const driver = await client.query('SELECT status FROM drivers WHERE user_id=$1', [userId]);
      if (driver.rowCount) throw new ConflictException('این حساب از قبل راننده است؛ برای تغییر وضعیت با پشتیبانی تماس بگیرید.');
      const plateOwner = await client.query('SELECT 1 FROM drivers WHERE plate_number=$1', [plateNumber]);
      if (plateOwner.rowCount) throw new ConflictException('این پلاک قبلاً برای رانندهٔ دیگری ثبت شده است.');
      const pending = await client.query(`SELECT id FROM driver_applications WHERE user_id=$1 AND status='PENDING'`, [userId]);
      if (pending.rowCount) throw new ConflictException('درخواست قبلی شما در انتظار بررسی است.');
      const region = await client.query('SELECT id FROM regions WHERE slug=$1 AND is_active=true', [slug]);
      if (!region.rowCount) throw new NotFoundException('منطقهٔ فعال پیدا نشد.');
      const result = await client.query(`INSERT INTO driver_applications(user_id,region_id,full_name,vehicle_type,note,plate_number,photo_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status,created_at AS "createdAt"`, [userId,region.rows[0].id,fullName,vehicleType,note || null,plateNumber,photoUrl]);
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES($1,'DRIVER_APPLICATION_CREATED','DRIVER_APPLICATION',$2)`, [userId,result.rows[0].id]);
      await client.query('COMMIT'); return result.rows[0];
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); if ((error as {code?:string}).code === '23505') throw new ConflictException('درخواست قبلی شما در انتظار بررسی است.'); throw error; }
    finally { client.release(); }
  }
  async driverQueue(statusInput?: string) {
    const status = statusInput || 'PENDING';
    if (!['PENDING','APPROVED','REJECTED'].includes(status)) throw new BadRequestException('وضعیت درخواست معتبر نیست.');
    const result = await this.pool.query(`SELECT a.id,a.full_name AS "fullName",a.vehicle_type AS "vehicleType",a.plate_number AS "plateNumber",a.photo_url AS "photoUrl",a.note,a.status,a.decision_note AS "decisionNote",a.created_at AS "createdAt",u.phone,r.name AS "regionName" FROM driver_applications a JOIN users u ON u.id=a.user_id JOIN regions r ON r.id=a.region_id WHERE a.status=$1 ORDER BY a.created_at ASC,a.id ASC LIMIT 100`, [status]);
    return result.rows;
  }
  async decideDriver(actor: string, id: string, body: { decision?: unknown; note?: unknown }) {
    if (!uuid.test(id)) throw new BadRequestException('شناسهٔ درخواست معتبر نیست.');
    if (body?.decision !== 'APPROVED' && body?.decision !== 'REJECTED') throw new BadRequestException('تصمیم معتبر نیست.');
    const decision = body.decision; const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 300 || (decision === 'REJECTED' && note.length < 3)) throw new BadRequestException('برای رد درخواست دلیل دست‌کم ۳ نویسه لازم است.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(`SELECT id,user_id,region_id,status,full_name,vehicle_type,plate_number,photo_url FROM driver_applications WHERE id=$1 FOR UPDATE`, [id]);
      if (!found.rowCount) throw new NotFoundException('درخواست پیدا نشد.');
      const application = found.rows[0];
      if (application.status !== 'PENDING') throw new ConflictException('این درخواست قبلاً بررسی شده است.');
      // Serialize with submission and administrative driver creation; do not reactivate a suspended driver.
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [application.user_id]);
      if (decision === 'APPROVED') {
        const existing = await client.query('SELECT status FROM drivers WHERE user_id=$1', [application.user_id]);
        if (existing.rowCount) throw new ConflictException('این کاربر از قبل پروفایل راننده دارد؛ وضعیت آن را در مدیریت رانندگان بررسی کنید.');
        const activeRegion = await client.query('SELECT id FROM regions WHERE id=$1 AND is_active=true', [application.region_id]);
        if (!activeRegion.rowCount) throw new ConflictException('منطقهٔ درخواست دیگر فعال نیست.');
        // Approving carries the verified identity across, so the courier can take missions at once.
        await client.query(`INSERT INTO drivers(user_id,region_id,status,full_name,vehicle_type,plate_number,photo_url) VALUES($1,$2,'ACTIVE',$3,$4,$5,$6)`, [application.user_id,application.region_id,application.full_name,application.vehicle_type,application.plate_number,application.photo_url]);
        await client.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'DRIVER') ON CONFLICT DO NOTHING`, [application.user_id]);
      }
      await client.query(`UPDATE driver_applications SET status=$2,decision_note=$3,decided_by=$4,decided_at=now() WHERE id=$1`, [id,decision,note || null,actor]);
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DRIVER_APPLICATION_DECIDED','DRIVER_APPLICATION',$2,$3::jsonb)`, [actor,id,JSON.stringify({decision,note})]);
      await notify(client,application.user_id,'DRIVER_APPLICATION_DECIDED',decision === 'APPROVED'?'درخواست رانندگی تأیید شد':'درخواست رانندگی رد شد',decision === 'APPROVED'?'برای ورود به پنل راننده، دوباره وارد حساب شوید.':`دلیل: ${note}`,{applicationId:id,decision});
      await client.query('COMMIT'); return {id,status:decision};
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); if ((error as {code?:string}).code === '23505') throw new ConflictException('این کاربر از قبل پروفایل راننده دارد.'); throw error; }
    finally { client.release(); }
  }
}
