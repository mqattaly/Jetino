import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { notify } from '../notifications/notifications.util';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class AdminDriversService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async list(){const result=await this.pool.query(`SELECT d.id,d.status,d.created_at AS "createdAt",u.phone,r.name AS "regionName" FROM drivers d JOIN users u ON u.id=d.user_id JOIN regions r ON r.id=d.region_id ORDER BY d.status,d.created_at DESC`);return result.rows;}
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
