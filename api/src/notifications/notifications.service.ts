import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { NotificationDeliveryService } from './notification-delivery.service';
type Principal={sub:string;roles?:string[]};
@Injectable()
export class NotificationsService{
 constructor(@Inject(PG_POOL)private readonly pool:Pool,private readonly deliveries:NotificationDeliveryService){}
 async list(user:Principal){const [items,unread]=await Promise.all([this.pool.query(`SELECT id,event_type AS "eventType",title,body,data,dedupe_key AS "dedupeKey",read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[user.sub]),this.pool.query('SELECT count(*)::int AS count FROM notifications WHERE user_id=$1 AND read_at IS NULL',[user.sub])]);
  // §7.12: the inbox says what happened to the push as well, so a silent phone is visible in the app
  const states=await this.deliveries.pushStates((items.rows as {id:string}[]).map(row=>row.id));
  const enriched=(items.rows as Record<string,unknown>[]).map(row=>{const state=states.get(String(row.id));return{...row,pushState:state?.state??'NONE',pushError:state?.lastError??null};});
  return{items:enriched,unreadCount:unread.rows[0].count};}
 async markRead(user:Principal,id:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new BadRequestException('شناسهٔ اعلان معتبر نیست.');const result=await this.pool.query('UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at AS "readAt"',[id,user.sub]);if(!result.rowCount)throw new NotFoundException('اعلان پیدا نشد.');return result.rows[0];}
 async readAll(user:Principal){const result=await this.pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL',[user.sub]);return{updated:result.rowCount||0};}
}
