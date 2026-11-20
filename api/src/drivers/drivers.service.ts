import { Inject, Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';
import { MAX_DELIVERY_CODE_ATTEMPTS, isDriverProfileComplete, missingDriverFields, normalizePlate, parseImageUrl, verifyDeliveryCode } from '../security/security.util';

type Principal={sub:string};const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
@Injectable()
export class DriversService{
 constructor(@Inject(PG_POOL)private readonly pool:Pool){}
 private async driverId(user:Principal){const result=await this.pool.query(`SELECT id FROM drivers WHERE user_id=$1 AND status='ACTIVE'`,[user.sub]);if(!result.rowCount)throw new ForbiddenException('حساب رانندهٔ فعال پیدا نشد.');return result.rows[0].id as string;}
 /** What the courier has on file, so the app can block a mission until the door-check identity is complete. */
 async profile(user:Principal){const result=await this.pool.query(`SELECT d.id,d.status,d.full_name AS "fullName",d.plate_number AS "plateNumber",d.vehicle_type AS "vehicleType",d.photo_url AS "photoUrl",d.region_id AS "regionId",r.name AS "regionName",u.phone FROM drivers d JOIN users u ON u.id=d.user_id LEFT JOIN regions r ON r.id=d.region_id WHERE d.user_id=$1`,[user.sub]);if(!result.rowCount)throw new NotFoundException('پروفایل راننده پیدا نشد.');const row=result.rows[0] as {fullName:string|null;plateNumber:string|null;vehicleType:string|null;photoUrl:string|null};return {...result.rows[0],complete:isDriverProfileComplete({full_name:row.fullName,plate_number:row.plateNumber,vehicle_type:row.vehicleType,photo_url:row.photoUrl}),missing:missingDriverFields({full_name:row.fullName,plate_number:row.plateNumber,vehicle_type:row.vehicleType,photo_url:row.photoUrl})};}
 /** The name, vehicle, plate and photo a customer checks at the door. Every value is required. */
 async saveProfile(user:Principal,body:{fullName?:unknown;vehicleType?:unknown;plateNumber?:unknown;photoUrl?:unknown}){
  if(!body||(body.fullName===undefined&&body.vehicleType===undefined&&body.plateNumber===undefined&&body.photoUrl===undefined))throw new BadRequestException('برای ذخیرهٔ پروفایل حداقل نام، نوع وسیله، پلاک و عکس را کامل کنید.');
  const fullName=body.fullName===undefined?undefined:typeof body.fullName==='string'?body.fullName.trim():'';
  if(fullName!==undefined&&(fullName.length<3||fullName.length>120))throw new BadRequestException('نام و نام خانوادگی باید بین ۳ تا ۱۲۰ نویسه باشد.');
  const vehicleType=body.vehicleType===undefined?undefined:body.vehicleType;
  if(vehicleType!==undefined&&!['MOTORCYCLE','CAR','BICYCLE','OTHER'].includes(vehicleType as string))throw new BadRequestException('نوع وسیله معتبر نیست.');
  const plateNumber=body.plateNumber===undefined?undefined:normalizePlate(body.plateNumber);
  const photoUrl=body.photoUrl===undefined?undefined:parseImageUrl(body.photoUrl,'عکس راننده');
  if(photoUrl===null)throw new BadRequestException('عکس راننده الزامی است.');
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   const current=await client.query('SELECT id FROM drivers WHERE user_id=$1 FOR UPDATE',[user.sub]);
   if(!current.rowCount)throw new NotFoundException('پروفایل راننده پیدا نشد.');
   const result=await client.query(
    `UPDATE drivers SET full_name=COALESCE($2,full_name),vehicle_type=COALESCE($3,vehicle_type),plate_number=COALESCE($4,plate_number),photo_url=COALESCE($5,photo_url),updated_at=now()
     WHERE user_id=$1 RETURNING id,full_name AS "fullName",plate_number AS "plateNumber",vehicle_type AS "vehicleType",photo_url AS "photoUrl"`,
    [user.sub,fullName??null,vehicleType??null,plateNumber??null,photoUrl??null]);
   const changed=['fullName','vehicleType','plateNumber','photoUrl'].filter(key=>body[key as keyof typeof body]!==undefined);
   await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DRIVER_PROFILE_UPDATED','DRIVER',$2,$3::jsonb)`,[user.sub,result.rows[0].id,JSON.stringify({changed})]);
   await client.query('COMMIT');
   const row=result.rows[0] as {id:string;fullName:string|null;plateNumber:string|null;vehicleType:string|null;photoUrl:string|null};
   return {...row,complete:isDriverProfileComplete({full_name:row.fullName,plate_number:row.plateNumber,vehicle_type:row.vehicleType,photo_url:row.photoUrl}),missing:missingDriverFields({full_name:row.fullName,plate_number:row.plateNumber,vehicle_type:row.vehicleType,photo_url:row.photoUrl})};
  }catch(error){
   try{await client.query('ROLLBACK');}catch{/* closed */}
   if((error as {code?:string}).code==='23505')throw new ConflictException('این پلاک قبلاً برای رانندهٔ دیگری ثبت شده است.');
   throw error;
  }finally{client.release();}
 }
 async deliveries(user:Principal){const driverId=await this.driverId(user);const result=await this.pool.query(`SELECT o.id,o.status,o.payment_status AS "paymentStatus",o.total_rial AS "totalRial",o.created_at AS "createdAt",o.delivery_address_snapshot AS "deliveryAddress",o.delivery_instructions_snapshot AS "deliveryInstructions",o.delivery_latitude_snapshot::float8 AS "deliveryLatitude",o.delivery_longitude_snapshot::float8 AS "deliveryLongitude",b.name AS "businessName",bu.phone AS "businessPhone",cu.phone AS "customerPhone" FROM delivery_assignments da JOIN orders o ON o.id=da.order_id JOIN drivers d ON d.id=da.driver_id JOIN businesses b ON b.id=o.business_id JOIN users bu ON bu.id=b.owner_id JOIN users cu ON cu.id=o.customer_id WHERE d.id=$1 AND o.status IN('DRIVER_ASSIGNED','OUT_FOR_DELIVERY','DELIVERED') ORDER BY o.created_at DESC LIMIT 100`,[driverId]);return result.rows;}
 async cashSummary(user:Principal){const driverId=await this.driverId(user);const result=await this.pool.query(
  `SELECT COALESCE((SELECT SUM(amount_rial) FROM cash_collections WHERE collected_by=d.user_id AND settlement_id IS NULL),0)::text AS "openCashRial",
          (SELECT COUNT(*) FROM cash_collections WHERE collected_by=d.user_id AND settlement_id IS NULL)::int AS "openCount",
          COALESCE((SELECT SUM(amount_rial) FROM cash_settlements WHERE driver_id=d.id),0)::text AS "settledTotalRial",
          (SELECT COUNT(*) FROM cash_settlements WHERE driver_id=d.id)::int AS "settledCount",
          (SELECT MAX(settled_at) FROM cash_settlements WHERE driver_id=d.id) AS "lastSettledAt"
   FROM drivers d WHERE d.id=$1`,[driverId]);
  return result.rows[0];}
 async transition(user:Principal,orderId:string,status:unknown,code?:unknown){
  if(!uuid.test(orderId))throw new BadRequestException('شناسهٔ سفارش معتبر نیست.');
  if(status!=='OUT_FOR_DELIVERY'&&status!=='DELIVERED')throw new BadRequestException('وضعیت جدید مجاز نیست.');
  if(code!==undefined&&typeof code!=='string')throw new BadRequestException('کد تحویل معتبر نیست.');
  const client=await this.pool.connect();
  let settled=false;
  try{
   await client.query('BEGIN');
   const result=await client.query(`SELECT o.id,o.status,o.customer_id,o.delivery_code_hash,o.delivery_code_attempts,o.delivery_code_locked_at,da.driver_id,d.user_id FROM orders o JOIN delivery_assignments da ON da.order_id=o.id JOIN drivers d ON d.id=da.driver_id WHERE o.id=$1 AND d.status='ACTIVE' FOR UPDATE OF o`,[orderId]);
   if(!result.rowCount||result.rows[0].user_id!==user.sub)throw new NotFoundException('مأموریت پیدا نشد یا به شما تخصیص ندارد.');
   if(result.rows[0].driver_id===null)throw new ForbiddenException();
   const from=result.rows[0].status as string;const to=status as string;
   const allowed:Record<string,string[]>={DRIVER_ASSIGNED:['OUT_FOR_DELIVERY'],OUT_FOR_DELIVERY:['DELIVERED']};
   if(!allowed[from]?.includes(to))throw new ConflictException(`گذار از ${from} به ${to} مجاز نیست.`);
   // Handover proof: the customer reads a four-digit code to the courier at the door. Failed
   // attempts are stored (and survive the rollback) so a courier cannot walk through codes.
   if(to==='DELIVERED'&&result.rows[0].delivery_code_hash){
    if(result.rows[0].delivery_code_locked_at)throw new ConflictException('کد تحویل به دلیل تلاش‌های ناموفق قفل شده است؛ با پشتیبانی تماس بگیرید.');
    const entered=typeof code==='string'?code.trim().replace(/[۰-۹]/g,digit=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))):'';
    if(!/^\d{4}$/.test(entered)||!verifyDeliveryCode(orderId,entered,result.rows[0].delivery_code_hash)){
     const attempts=Number(result.rows[0].delivery_code_attempts??0)+1;
     const locked=attempts>=MAX_DELIVERY_CODE_ATTEMPTS;
     await client.query(`UPDATE orders SET delivery_code_attempts=$2,delivery_code_locked_at=CASE WHEN $3 THEN now() ELSE delivery_code_locked_at END,updated_at=now() WHERE id=$1`,[orderId,attempts,locked]);
     await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DELIVERY_CODE_REJECTED','ORDER',$2,$3::jsonb)`,[user.sub,orderId,JSON.stringify({attempts,locked})]);
     if(locked)await notify(client,result.rows[0].customer_id,'DELIVERY_CODE_LOCKED','کد تحویل قفل شد','کسی چند بار کد تحویل اشتباه وارد کرد. اگر پیک در محل است، کد را از این صفحه بخوانید یا با پشتیبانی تماس بگیرید.',{orderId,status:to});
     await client.query('COMMIT');
     settled=true;
     throw new BadRequestException(locked?'کد تحویل اشتباه بود و دسترسی قفل شد؛ با پشتیبانی تماس بگیرید.':`کد تحویل اشتباه است؛ ${MAX_DELIVERY_CODE_ATTEMPTS-attempts} تلاش دیگر باقی مانده است.`);
    }
   }
   await client.query('UPDATE orders SET status=$2,delivery_code_attempts=0,updated_at=now() WHERE id=$1',[orderId,to]);
   await client.query('INSERT INTO order_status_history(order_id,from_status,to_status,actor_id) VALUES($1,$2,$3,$4)',[orderId,from,to,user.sub]);
   const message=to==='OUT_FOR_DELIVERY'?'پیک سفارش را برای ارسال تحویل گرفته است.':'سفارش به مشتری تحویل داده شد.';
   await notify(client,result.rows[0].customer_id,to==='OUT_FOR_DELIVERY'?'ORDER_OUT_FOR_DELIVERY':'ORDER_DELIVERED',to==='OUT_FOR_DELIVERY'?'سفارش در مسیر است':'سفارش تحویل شد',message,{orderId,status:to});
   await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DRIVER_ORDER_STATUS_CHANGED','ORDER',$2,$3::jsonb)`,[user.sub,orderId,JSON.stringify({from,to,codeVerified:to==='DELIVERED'})]);
   await client.query('COMMIT');
   return{id:orderId,fromStatus:from,status:to};
  }catch(error){if(!settled){try{await client.query('ROLLBACK');}catch{/* closed */}}throw error;}finally{client.release();}
 }
 async collectCash(user:Principal,orderId:string,confirmReceived:unknown){if(!uuid.test(orderId))throw new BadRequestException('شناسهٔ سفارش معتبر نیست.');if(confirmReceived!==true)throw new BadRequestException('برای ثبت وصول وجه، تأیید صریح لازم است.');const client=await this.pool.connect();try{await client.query('BEGIN');const result=await client.query(`SELECT o.id,o.status,o.payment_method,o.payment_status,o.total_rial,o.customer_id,d.user_id FROM orders o JOIN delivery_assignments da ON da.order_id=o.id JOIN drivers d ON d.id=da.driver_id WHERE o.id=$1 AND d.status='ACTIVE' FOR UPDATE OF o`,[orderId]);if(!result.rowCount||result.rows[0].user_id!==user.sub)throw new NotFoundException('مأموریت پیدا نشد یا به شما تخصیص ندارد.');const row=result.rows[0];if(row.payment_method!=='CASH')throw new ConflictException('این سفارش نقدی نیست.');if(row.payment_status==='PAID'){const old=await client.query('SELECT amount_rial,collected_at FROM cash_collections WHERE order_id=$1',[orderId]);await client.query('COMMIT');return{id:orderId,alreadyCollected:true,amountRial:String(old.rows[0]?.amount_rial??row.total_rial),collectedAt:old.rows[0]?.collected_at??null};}if(row.status!=='DELIVERED')throw new ConflictException('وصول نقدی فقط پس از تحویل سفارش ثبت می‌شود.');if(row.payment_status!=='PENDING')throw new ConflictException('وضعیت پرداخت قابل ثبت نیست.');const collection=await client.query(`INSERT INTO cash_collections(order_id,amount_rial,collected_by) VALUES($1,$2,$3) RETURNING amount_rial,collected_at`,[orderId,row.total_rial,user.sub]);await client.query(`UPDATE orders SET payment_status='PAID',payment_collected_at=$2,payment_collected_by=$3,updated_at=now() WHERE id=$1`,[orderId,collection.rows[0].collected_at,user.sub]);await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'CASH_PAYMENT_COLLECTED','ORDER',$2,$3::jsonb)`,[user.sub,orderId,JSON.stringify({amountRial:String(row.total_rial)})]);await notify(client,row.customer_id,'CASH_PAYMENT_CONFIRMED','پرداخت نقدی ثبت شد','وصول وجه سفارش شما ثبت شد.',{orderId,amountRial:String(row.total_rial)});await client.query('COMMIT');return{id:orderId,alreadyCollected:false,amountRial:String(collection.rows[0].amount_rial),collectedAt:collection.rows[0].collected_at};}catch(error){try{await client.query('ROLLBACK');}catch{/* closed */}throw error;}finally{client.release();}}
}
