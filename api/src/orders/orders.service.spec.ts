import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';

function service(connect: () => void) {
  return new OrdersService({ connect: () => { connect(); throw new Error('database should not be reached'); } } as never);
}

function transactionalService(onQuery: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
  const client = { query: onQuery, release() {} };
  return new OrdersService({ connect: async () => client } as never);
}

describe('OrdersService order placement acceptance',()=>{
  it('recalculates a cash order server-side and writes order, history and notification atomically',async()=>{
    const statements:Array<{sql:string;values?:unknown[]}> = [];
    const userId='123e4567-e89b-12d3-a456-426614174001';
    const businessId='123e4567-e89b-12d3-a456-426614174002';
    const addressId='123e4567-e89b-12d3-a456-426614174003';
    const productId='123e4567-e89b-12d3-a456-426614174004';
    const orderId='123e4567-e89b-12d3-a456-426614174005';
    const service=transactionalService(async(sql,values)=>{
      statements.push({sql,values});
      if(sql.startsWith('SELECT id,request_hash'))return{rows:[],rowCount:0};
      if(sql.startsWith('SELECT b.id,b.name'))return{rows:[{id:businessId,name:'کسب‌وکار نمونه',owner_id:'owner-1',commission_bps:1000,region_id:'region-1',region_name:'بندر خمیر',delivery_fee_rial:'500'}],rowCount:1};
      if(sql.startsWith('SELECT a.id,a.label'))return{rows:[{id:addressId,label:'خانه',address_text:'نشانی نمونه',instructions:null,latitude:'27.2',longitude:'55.7',region_id:'region-1'}],rowCount:1};
      if(sql.startsWith('SELECT p.id,p.name'))return{rows:[{id:productId,name:'غذای نمونه',price_rial:'1000',business_id:businessId}],rowCount:1};
      if(sql.startsWith('SELECT value_int'))return{rows:[{value_int:1000}],rowCount:1};
      if(sql.startsWith('INSERT INTO orders('))return{rows:[{id:orderId}],rowCount:1};
      if(sql.startsWith('SELECT o.id,o.customer_id'))return{rows:[{id:orderId,customer_id:userId,business_id:businessId,status:'PENDING_BUSINESS',payment_method:'CASH',payment_status:'PENDING',subtotal_rial:'2000',delivery_fee_rial:'500',commission_rial:'200',commission_bps:1000,total_rial:'2500',estimated_prep_minutes:null,delivery_address_snapshot:'نشانی نمونه',delivery_instructions_snapshot:null,delivery_latitude_snapshot:'27.2',delivery_longitude_snapshot:'55.7',created_at:new Date('2026-11-17T10:00:00Z'),updated_at:new Date('2026-11-17T10:00:00Z'),business_name:'کسب‌وکار نمونه'}],rowCount:1};
      if(sql.startsWith('SELECT product_name'))return{rows:[{product_name:'غذای نمونه',unit_price_rial:'1000',quantity:2,line_total_rial:'2000'}],rowCount:1};
      if(sql.startsWith('SELECT from_status'))return{rows:[{from_status:null,to_status:'PENDING_BUSINESS',reason:'Order created',created_at:new Date('2026-11-17T10:00:00Z')}],rowCount:1};
      return{rows:[],rowCount:1};
    });

    const result=await service.create({sub:userId},{businessId,addressId,paymentMethod:'CASH',items:[{productId,quantity:2}]},'acceptance-key-1');
    assert.equal(result.id,orderId);
    assert.equal(result.currency,'IRR');
    assert.equal(result.amounts.subtotalRial,'2000');
    assert.equal(result.amounts.deliveryFeeRial,'500');
    assert.equal(result.amounts.totalRial,'2500');
    assert.equal(result.payment.method,'CASH');
    assert.equal(result.delivery.latitude,27.2);
    assert.ok(statements.some(entry=>entry.sql.startsWith('INSERT INTO order_status_history')));
    const notice=statements.find(entry=>entry.sql.startsWith('INSERT INTO notifications'))!;
    assert.equal(notice.values?.[0],'owner-1');
    assert.equal(JSON.parse(String(notice.values?.[4])).orderId,orderId);
    assert.equal(statements.at(-1)?.sql,'COMMIT');
  });
});

describe('OrdersService idempotent placement',()=>{
  it('replays the stored order for the same key and payload without inserting again',async()=>{
    const statements:Array<{sql:string;values?:unknown[]}> = [];
    const userId='123e4567-e89b-12d3-a456-426614174001';
    const businessId='123e4567-e89b-12d3-a456-426614174002';
    const addressId='123e4567-e89b-12d3-a456-426614174003';
    const productId='123e4567-e89b-12d3-a456-426614174004';
    const orderId='123e4567-e89b-12d3-a456-426614174005';
    const requestHash=createHash('sha256').update(JSON.stringify({businessId,addressId,items:[{productId,quantity:2}],paymentMethod:'CASH'})).digest('hex');
    const service=transactionalService(async(sql,values)=>{
      statements.push({sql,values});
      if(sql.startsWith('SELECT id,request_hash'))return{rows:[{id:orderId,request_hash:requestHash}],rowCount:1};
      if(sql.startsWith('SELECT o.id,o.customer_id'))return{rows:[{id:orderId,customer_id:userId,business_id:businessId,status:'PENDING_BUSINESS',payment_method:'CASH',payment_status:'PENDING',subtotal_rial:'2000',delivery_fee_rial:'500',commission_rial:'200',commission_bps:1000,total_rial:'2500',estimated_prep_minutes:null,delivery_address_snapshot:'نشانی نمونه',delivery_instructions_snapshot:null,delivery_latitude_snapshot:null,delivery_longitude_snapshot:null,created_at:new Date('2026-11-17T10:00:00Z'),updated_at:new Date('2026-11-17T10:00:00Z'),business_name:'کسب‌وکار نمونه'}],rowCount:1};
      if(sql.startsWith('SELECT product_name'))return{rows:[{product_name:'غذای نمونه',unit_price_rial:'1000',quantity:2,line_total_rial:'2000'}],rowCount:1};
      if(sql.startsWith('SELECT from_status'))return{rows:[],rowCount:0};
      return{rows:[],rowCount:1};
    });
    const result=await service.create({sub:userId},{businessId,addressId,items:[{productId,quantity:2}]},'repeat-key');
    assert.equal(result.replayed,true);
    assert.equal(result.id,orderId);
    assert.equal(statements[1].sql,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))');
    assert.equal(statements[1].values?.[0],`${userId}:repeat-key`);
    assert.ok(!statements.some(entry=>entry.sql.startsWith('INSERT INTO orders')));
    assert.ok(!statements.some(entry=>entry.sql.includes('FROM businesses b')));
    assert.equal(statements.at(-1)?.sql,'COMMIT');
  });

  it('rejects key reuse for a different basket and rolls the transaction back',async()=>{
    const statements:Array<{sql:string;values?:unknown[]}> = [];
    const service=transactionalService(async(sql,values)=>{
      statements.push({sql,values});
      if(sql.startsWith('SELECT id,request_hash'))return{rows:[{id:'order-1',request_hash:'a-different-hash'}],rowCount:1};
      return{rows:[],rowCount:0};
    });
    await assert.rejects(service.create({sub:'123e4567-e89b-12d3-a456-426614174001'},{businessId:'123e4567-e89b-12d3-a456-426614174002',addressId:'123e4567-e89b-12d3-a456-426614174003',items:[{productId:'123e4567-e89b-12d3-a456-426614174004',quantity:1}]},'repeat-key'),ConflictException);
    assert.ok(!statements.some(entry=>entry.sql.startsWith('INSERT INTO orders')));
    assert.equal(statements.at(-1)?.sql,'ROLLBACK');
  });

  it('refuses non-cash payment and missing idempotency keys before touching the database',async()=>{
    const noCard=service(()=>assert.fail('online payment must not reach the database'));
    await assert.rejects(noCard.create({sub:'user'},{businessId:'123e4567-e89b-12d3-a456-426614174002',addressId:'123e4567-e89b-12d3-a456-426614174003',items:[{productId:'123e4567-e89b-12d3-a456-426614174004',quantity:1}],paymentMethod:'CARD'},'valid-key'),BadRequestException);
    const noKey=service(()=>assert.fail('missing key must not reach the database'));
    await assert.rejects(noKey.create({sub:'user'},{businessId:'123e4567-e89b-12d3-a456-426614174002',addressId:'123e4567-e89b-12d3-a456-426614174003',items:[{productId:'123e4567-e89b-12d3-a456-426614174004',quantity:1}]}),BadRequestException);
  });
});

describe('OrdersService customer cancellation window',()=>{
  it('cancels while the business has not answered and notifies the owner',async()=>{
    const statements:Array<{sql:string;values?:unknown[]}> = [];
    const service=transactionalService(async(sql,values)=>{
      statements.push({sql,values});
      if(sql.startsWith('SELECT o.id,o.status,b.owner_id'))return{rows:[{id:'order-1',status:'PENDING_BUSINESS',owner_id:'owner-1'}],rowCount:1};
      return{rows:[],rowCount:1};
    });
    assert.deepEqual(await service.cancel({sub:'customer-1'},'123e4567-e89b-12d3-a456-426614174006'),{id:'123e4567-e89b-12d3-a456-426614174006',status:'CANCELLED'});
    assert.ok(statements.some(entry=>entry.sql.startsWith(`UPDATE orders SET status='CANCELLED'`)));
    const notice=statements.find(entry=>entry.sql.startsWith('INSERT INTO notifications'))!;
    assert.equal(notice.values?.[0],'owner-1');
    assert.equal(notice.values?.[1],'ORDER_CANCELLED');
    assert.equal(statements.at(-1)?.sql,'COMMIT');
  });

  it('files a request for the queue instead of rewriting an order the business already answered',async()=>{
    const statements:Array<{sql:string;values?:unknown[]}> = [];
    const service=transactionalService(async(sql,values)=>{
      statements.push({sql,values});
      if(sql.startsWith('SELECT o.id,o.status,b.owner_id'))return{rows:[{id:'order-1',status:'CONFIRMED',owner_id:'owner-1',created_at:new Date()}],rowCount:1};
      if(sql.startsWith('SELECT id FROM cancellation_requests'))return{rows:[],rowCount:0};
      if(sql.startsWith('SELECT DISTINCT ur.user_id'))return{rows:[{user_id:'ops-1'}],rowCount:1};
      if(sql.startsWith('INSERT INTO cancellation_requests'))return{rows:[{id:'request-1'}],rowCount:1};
      return{rows:[],rowCount:1};
    });
    const result=await service.cancel({sub:'customer-1'},'123e4567-e89b-12d3-a456-426614174006',{reason:'غذای اشتباه سفارش داده شد'});
    assert.deepEqual(result,{id:'123e4567-e89b-12d3-a456-426614174006',status:'CONFIRMED',outcome:'PENDING',requestId:'request-1',message:'لغو این سفارش نیاز به تأیید کادر عملیات دارد؛ درخواست شما ثبت شد.'});
    assert.ok(!statements.some(entry=>entry.sql.startsWith('UPDATE orders')),'the order status must stay untouched');
    const request=statements.find(entry=>entry.sql.startsWith('INSERT INTO cancellation_requests'))!;
    assert.deepEqual(request.values,['123e4567-e89b-12d3-a456-426614174006','customer-1','غذای اشتباه سفارش داده شد']);
    const notices=statements.filter(entry=>entry.sql.startsWith('INSERT INTO notifications')).map(entry=>entry.values?.[0]);
    assert.deepEqual(notices,['owner-1','ops-1']);
    assert.equal(statements.at(-1)?.sql,'COMMIT');
  });

  it('asks for a reason before it queues anything, and never doubles an open request',async()=>{
    const statements:Array<{sql:string;values?:unknown[]}> = [];
    const withoutReason=transactionalService(async(sql,values)=>{
      statements.push({sql,values});
      if(sql.startsWith('SELECT o.id,o.status,b.owner_id'))return{rows:[{id:'order-1',status:'CONFIRMED',owner_id:'owner-1',created_at:new Date()}],rowCount:1};
      return{rows:[],rowCount:1};
    });
    await assert.rejects(withoutReason.cancel({sub:'customer-1'},'123e4567-e89b-12d3-a456-426614174006',{reason:'؟'}),/دلیل لغو/);
    assert.ok(!statements.some(entry=>entry.sql.startsWith('INSERT INTO')),'a rejected request must not write anything');
    assert.equal(statements.at(-1)?.sql,'ROLLBACK');

    const second=transactionalService(async(sql,values)=>{
      if(sql.startsWith('SELECT o.id,o.status,b.owner_id'))return{rows:[{id:'order-1',status:'PREPARING',owner_id:'owner-1',created_at:new Date()}],rowCount:1};
      if(sql.startsWith('SELECT id FROM cancellation_requests'))return{rows:[{id:'request-1'}],rowCount:1};
      if(sql.startsWith('INSERT')||sql.startsWith('UPDATE'))throw new Error(`nothing may be written: ${sql}`);
      return{rows:[],rowCount:1};
    });
    await assert.rejects(second.cancel({sub:'customer-1'},'123e4567-e89b-12d3-a456-426614174006',{reason:'دیر آماده می‌شود'}),ConflictException);
  });

  it('refuses to cancel an order that already reached an outcome',async()=>{
    const service=transactionalService(async(sql,values)=>{
      if(sql.startsWith('SELECT o.id,o.status,b.owner_id'))return{rows:[{id:'order-1',status:'DELIVERED',owner_id:'owner-1',created_at:new Date()}],rowCount:1};
      return{rows:[],rowCount:1};
    });
    await assert.rejects(service.cancel({sub:'customer-1'},'123e4567-e89b-12d3-a456-426614174006',{reason:'سرویس اشتباه بود'}),/بازپرداخت/);
  });

  it('scopes cancellation to the order owner',async()=>{
    const statements:Array<{sql:string;values?:unknown[]}> = [];
    const service=transactionalService(async(sql,values)=>{
      statements.push({sql,values});
      if(sql.startsWith('SELECT o.id,o.status,b.owner_id'))return{rows:[],rowCount:0};
      return{rows:[],rowCount:1};
    });
    await assert.rejects(service.cancel({sub:'other-customer'},'123e4567-e89b-12d3-a456-426614174006'),NotFoundException);
    assert.deepEqual(statements[1].values,['123e4567-e89b-12d3-a456-426614174006','other-customer']);
    assert.match(statements[1].sql,/o.customer_id=\$2 FOR UPDATE OF o/);
  });
});

describe('OrdersService preparation estimate validation', () => {
  it('persists the selected estimate and customer notification in the status transaction', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const orderId = '123e4567-e89b-12d3-a456-426614174000';
    const service = transactionalService(async (sql, values) => {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT o.id,o.status')) return { rows: [{ id: orderId, status: 'PENDING_BUSINESS', customer_id: 'customer-1', owner_id: 'owner-1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const result = await service.businessTransition({ sub: 'owner-1' }, orderId, 'CONFIRMED', 45);
    assert.equal(result.estimatedPrepMinutes, 45);
    const update = statements.find((entry) => entry.sql.startsWith('UPDATE orders'))!;
    assert.match(update.sql, /estimated_prep_minutes=COALESCE\(\$3,estimated_prep_minutes\)/);
    assert.deepEqual(update.values, [orderId, 'CONFIRMED', 45]);
    const notice = statements.find((entry) => entry.sql.startsWith('INSERT INTO notifications'))!;
    assert.match(String(notice.values?.[3]), /45 دقیقه/);
    assert.deepEqual(JSON.parse(String(notice.values?.[4])), { orderId, status: 'CONFIRMED', preparationMinutes: 45 });
    assert.equal(statements.at(-1)?.sql, 'COMMIT');
  });

  it('rejects preparation estimates below five minutes before opening a transaction', async () => {
    let connected = false;
    await assert.rejects(
      service(() => { connected = true; }).businessTransition({ sub: 'owner-1' }, '123e4567-e89b-12d3-a456-426614174000', 'CONFIRMED', 4),
      BadRequestException,
    );
    assert.equal(connected, false);
  });

  it('rejects non-integer preparation estimates before opening a transaction', async () => {
    let connected = false;
    await assert.rejects(
      service(() => { connected = true; }).businessTransition({ sub: 'owner-1' }, '123e4567-e89b-12d3-a456-426614174000', 'CONFIRMED', 12.5),
      BadRequestException,
    );
    assert.equal(connected, false);
  });

  it('rejects preparation estimates above four hours before opening a transaction', async () => {
    let connected = false;
    await assert.rejects(
      service(() => { connected = true; }).businessTransition({ sub: 'owner-1' }, '123e4567-e89b-12d3-a456-426614174000', 'CONFIRMED', 241),
      BadRequestException,
    );
    assert.equal(connected, false);
  });
});
