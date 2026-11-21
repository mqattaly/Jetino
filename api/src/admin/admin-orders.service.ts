import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';
import { missingDriverFields } from '../security/security.util';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES=['PENDING_BUSINESS','CONFIRMED','PREPARING','READY_FOR_PICKUP','DRIVER_ASSIGNED','OUT_FOR_DELIVERY','DELIVERED','REJECTED','CANCELLED','UNDER_REVIEW'];
const MAX_PAGE_SIZE=100; const DEFAULT_PAGE_SIZE=25;

type OrderFilters={status:string|null;search:string|null;limit:number;offset:number};

@Injectable()
export class AdminOrdersService {
 constructor(@Inject(PG_POOL)private readonly pool:Pool){}

 private parseFilters(statusInput?:string,searchInput?:string,limitInput?:string,offsetInput?:string):OrderFilters{
  if(statusInput&&!STATUSES.includes(statusInput))throw new BadRequestException('فیلتر وضعیت سفارش معتبر نیست.');
  let search:string|null=null;
  if(searchInput!==undefined&&searchInput!==''){
   const trimmed=searchInput.trim();
   if(trimmed.length<2||trimmed.length>40)throw new BadRequestException('جستجو باید بین ۲ تا ۴۰ نویسه باشد.');
   if(/[\u0000-\u001f]/.test(trimmed))throw new BadRequestException('جستجو شامل نویسهٔ غیرقابل قبول است.');
   search=trimmed;
  }
  const limit=limitInput===undefined?DEFAULT_PAGE_SIZE:Number(limitInput);
  if(!Number.isInteger(limit)||limit<1||limit>MAX_PAGE_SIZE)throw new BadRequestException(`تعداد سطر باید بین ۱ و ${MAX_PAGE_SIZE} باشد.`);
  const offset=offsetInput===undefined?0:Number(offsetInput);
  if(!Number.isInteger(offset)||offset<0)throw new BadRequestException('صفحهٔ درخواستی معتبر نیست.');
  return {status:statusInput??null,search,limit,offset};
 }

 async list(statusInput?:string,searchInput?:string,limitInput?:string,offsetInput?:string){
  const {status,search,limit,offset}=this.parseFilters(statusInput,searchInput,limitInput,offsetInput);
  const escaped=search?search.replace(/[%_\\]/g,match=>`\\${match}`):null;
  const idPrefix=search&&/^[0-9a-f]{1,8}$/i.test(search.replace(/-/g,''))?search.replace(/-/g,'').toLowerCase():null;
  const where=`WHERE ($1::order_status IS NULL OR o.status=$1)
     AND ($2::text IS NULL OR u.phone LIKE '%'||$2||'%' ESCAPE '\\' OR b.name LIKE '%'||$2||'%' ESCAPE '\\'${idPrefix?' OR left(o.id::text,8)=$3::text':''})`;
  const values:unknown[]=[status,escaped,...(idPrefix?[idPrefix]:[])];
  const rows=await this.pool.query(
    `SELECT o.id,o.status,o.payment_status AS "paymentStatus",o.total_rial AS "totalRial",o.created_at AS "createdAt",o.delivery_address_snapshot AS "deliveryAddress",o.delivery_latitude_snapshot::float8 AS "deliveryLatitude",o.delivery_longitude_snapshot::float8 AS "deliveryLongitude",b.name AS "businessName",u.phone AS "customerPhone",d.id AS "driverId",du.phone AS "driverPhone",d.full_name AS "driverName",d.plate_number AS "driverPlate",d.vehicle_type AS "driverVehicleType" FROM orders o JOIN businesses b ON b.id=o.business_id JOIN users u ON u.id=o.customer_id LEFT JOIN delivery_assignments da ON da.order_id=o.id LEFT JOIN drivers d ON d.id=da.driver_id LEFT JOIN users du ON du.id=d.user_id ${where} ORDER BY o.created_at DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,
    [...values,limit,offset],
  );
  const total=await this.pool.query(
    `SELECT COUNT(*)::text AS "totalMatches" FROM orders o JOIN businesses b ON b.id=o.business_id JOIN users u ON u.id=o.customer_id ${where}`,
    values,
  );
  return {items:rows.rows,totalMatches:Number(total.rows[0]?.totalMatches??0),limit,offset};
 }

 async assign(actor:string,orderId:string,driverId:unknown){if(!uuid.test(orderId)||typeof driverId!=='string'||!uuid.test(driverId))throw new BadRequestException('شناسهٔ سفارش یا راننده معتبر نیست.');const client=await this.pool.connect();try{await client.query('BEGIN');const order=await client.query(`SELECT o.id,o.status,o.customer_id,b.name AS business_name,b.region_id FROM orders o JOIN businesses b ON b.id=o.business_id WHERE o.id=$1 FOR UPDATE OF o`,[orderId]);if(!order.rowCount)throw new NotFoundException('سفارش پیدا نشد.');const current=order.rows[0];if(current.status!=='READY_FOR_PICKUP'&&current.status!=='DRIVER_ASSIGNED')throw new ConflictException('راننده فقط برای سفارش آمادهٔ تحویل قابل تخصیص است.');const driver=await client.query(`SELECT id,user_id,full_name,vehicle_type,plate_number,photo_url,verification_status,shahkar_matched,identity_matched,biometric_status FROM drivers WHERE id=$1 AND region_id=$2 AND status='ACTIVE' FOR UPDATE`,[driverId,current.region_id]);if(!driver.rowCount)throw new ConflictException('راننده فعال و متعلق به منطقهٔ سفارش پیدا نشد.');
  // Snapp-style door check: never send a courier whose name, plate and photo the customer cannot see.
  const missing=missingDriverFields(driver.rows[0]??{});if(missing.length)throw new ConflictException('پروفایل این راننده ناقص است (نام، نوع وسیله، پلاک و عکس). ابتدا از راننده بخواهید پروفایلش را کامل کند.');
  // When operations switches the gate on, only reviewed couriers may take a mission.
  const gate=await client.query(`SELECT value_int FROM platform_settings WHERE key='require_driver_verification'`);
  if(Number(gate.rows[0]?.value_int??0)===1&&driver.rows[0].verification_status!=='APPROVED')throw new ConflictException('این راننده هنوز مدارکش تأیید نشده است؛ تا تأیید مدارک، تخصیص مأموریت مجاز نیست.');
  // The stronger gate, off by default: phone↔national code, the registry and the liveness video must all agree.
  const identityGate=await client.query(`SELECT value_int FROM platform_settings WHERE key='require_driver_identity'`);
  if(Number(identityGate.rows[0]?.value_int??0)===1&&!(driver.rows[0].shahkar_matched===true&&driver.rows[0].identity_matched===true&&driver.rows[0].biometric_status==='MATCHED'))throw new ConflictException('احراز هویت این راننده هنوز کامل نیست؛ شاهکار، استعلام ثبت احوال و ویدئوی بیومتریک باید تأیید شده باشند.');
  await client.query(`INSERT INTO delivery_assignments(order_id,driver_id,assigned_by) VALUES($1,$2,$3) ON CONFLICT(order_id) DO UPDATE SET driver_id=EXCLUDED.driver_id,assigned_by=EXCLUDED.assigned_by,assigned_at=now()`,[orderId,driverId,actor]);
  await client.query(`INSERT INTO driver_assignment_history(order_id,driver_id,assigned_by) VALUES($1,$2,$3)`,[orderId,driverId,actor]);
  if(current.status==='READY_FOR_PICKUP'){await client.query(`UPDATE orders SET status='DRIVER_ASSIGNED',updated_at=now() WHERE id=$1`,[orderId]);await client.query(`INSERT INTO order_status_history(order_id,from_status,to_status,actor_id) VALUES($1,'READY_FOR_PICKUP','DRIVER_ASSIGNED',$2)`,[orderId,actor]);await notify(client,current.customer_id,'ORDER_DRIVER_ASSIGNED','پیک سفارش مشخص شد','سفارش شما به پیک تخصیص داده شد.',{orderId});}
  await notify(client,driver.rows[0].user_id,'DELIVERY_ASSIGNED','ماموریت جدید','یک سفارش برای ارسال به شما تخصیص داده شد.',{orderId,businessName:current.business_name});
  await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DRIVER_ASSIGNED','ORDER',$2,$3::jsonb)`,[actor,orderId,JSON.stringify({driverId})]);await client.query('COMMIT');return {orderId,driverId,status:current.status==='READY_FOR_PICKUP'?'DRIVER_ASSIGNED':current.status};
 }catch(error){try{await client.query('ROLLBACK');}catch{/* closed */}throw error;}finally{client.release();}}
}
