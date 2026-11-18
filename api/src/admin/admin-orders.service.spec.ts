import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminOrdersService } from './admin-orders.service';

const orderId='123e4567-e89b-12d3-a456-426614174020';
const driverId='123e4567-e89b-12d3-a456-426614174021';
const actor='123e4567-e89b-12d3-a456-426614174022';

function poolWith(onQuery:(sql:string,values?:unknown[])=>Promise<{rows:unknown[];rowCount:number}>) {
  const statements:Array<{sql:string;values?:unknown[]}> = [];
  const client={query:async(sql:string,values?:unknown[])=>{statements.push({sql,values});return onQuery(sql,values);},release(){}};
  return {service:new AdminOrdersService({connect:async()=>client,query:async(sql:string,values?:unknown[])=>{statements.push({sql,values});return onQuery(sql,values);}} as never),statements};
}

describe('AdminOrdersService order monitor query',()=>{
  it('passes an empty filter as NULL so every status is listed',async()=>{
    const {service,statements}=poolWith(async()=>({rows:[{id:orderId,status:'DELIVERED'}],rowCount:1}));
    assert.deepEqual(await service.list(),[{id:orderId,status:'DELIVERED'}]);
    assert.deepEqual(statements[0].values,[null]);
    assert.match(statements[0].sql,/LIMIT 100/);
    assert.match(statements[0].sql,/LEFT JOIN delivery_assignments/);
  });

  it('rejects an unknown status filter before querying',async()=>{
    let queried=false;
    const service=new AdminOrdersService({query:async()=>{queried=true;return{rows:[],rowCount:0};}} as never);
    await assert.rejects(service.list('ANY'),BadRequestException);
    assert.equal(queried,false);
  });
});

describe('AdminOrdersService driver assignment',()=>{
  it('assigns only when the order is ready for pickup and informs the customer and driver',async()=>{
    const {service,statements}=poolWith(async(sql)=>{
      if(sql.startsWith('SELECT o.id,o.status,o.customer_id'))return{rows:[{id:orderId,status:'READY_FOR_PICKUP',customer_id:'customer-1',business_name:'کسب‌وکار نمونه',region_id:'region-1'}],rowCount:1};
      if(sql.startsWith('SELECT id,user_id FROM drivers'))return{rows:[{id:driverId,user_id:'driver-user'}],rowCount:1};
      return{rows:[],rowCount:1};
    });
    assert.deepEqual(await service.assign(actor,orderId,driverId),{orderId,driverId,status:'DRIVER_ASSIGNED'});
    assert.equal(statements[0].sql,'BEGIN');
    assert.match(statements[1].sql,/FOR UPDATE OF o/);
    assert.match(statements.find(entry=>entry.sql.startsWith('SELECT id,user_id FROM drivers'))!.sql,/region_id=\$2 AND status='ACTIVE'/);
    assert.ok(statements.some(entry=>entry.sql.startsWith(`UPDATE orders SET status='DRIVER_ASSIGNED'`)));
    const events=statements.filter(entry=>entry.sql.startsWith('INSERT INTO notifications')).map(entry=>entry.values?.[1]);
    assert.deepEqual(events,['ORDER_DRIVER_ASSIGNED','DELIVERY_ASSIGNED']);
    assert.equal(statements.at(-1)?.sql,'COMMIT');
  });

  it('reassigns an already assigned order without repeating the customer transition',async()=>{
    const {service,statements}=poolWith(async(sql)=>{
      if(sql.startsWith('SELECT o.id,o.status,o.customer_id'))return{rows:[{id:orderId,status:'DRIVER_ASSIGNED',customer_id:'customer-1',business_name:'کسب‌وکار نمونه',region_id:'region-1'}],rowCount:1};
      if(sql.startsWith('SELECT id,user_id FROM drivers'))return{rows:[{id:driverId,user_id:'driver-user'}],rowCount:1};
      return{rows:[],rowCount:1};
    });
    assert.deepEqual(await service.assign(actor,orderId,driverId),{orderId,driverId,status:'DRIVER_ASSIGNED'});
    assert.ok(statements.some(entry=>entry.sql.includes('ON CONFLICT(order_id) DO UPDATE')));
    assert.ok(!statements.some(entry=>entry.sql.startsWith('INSERT INTO order_status_history')));
    assert.equal(statements.filter(entry=>entry.sql.startsWith('INSERT INTO notifications')).length,1);
  });

  it('refuses to assign while the order is still being prepared and rolls back',async()=>{
    const {service,statements}=poolWith(async(sql)=>{
      if(sql.startsWith('SELECT o.id,o.status,o.customer_id'))return{rows:[{id:orderId,status:'PREPARING',customer_id:'customer-1',business_name:'کسب‌وکار نمونه',region_id:'region-1'}],rowCount:1};
      return{rows:[],rowCount:0};
    });
    await assert.rejects(service.assign(actor,orderId,driverId),ConflictException);
    assert.ok(!statements.some(entry=>entry.sql.startsWith('INSERT INTO delivery_assignments')));
    assert.equal(statements.at(-1)?.sql,'ROLLBACK');
  });

  it('rolls back when the driver is outside the order region',async()=>{
    const {service,statements}=poolWith(async(sql)=>{
      if(sql.startsWith('SELECT o.id,o.status,o.customer_id'))return{rows:[{id:orderId,status:'READY_FOR_PICKUP',customer_id:'customer-1',business_name:'کسب‌وکار نمونه',region_id:'region-1'}],rowCount:1};
      if(sql.startsWith('SELECT id,user_id FROM drivers'))return{rows:[],rowCount:0};
      return{rows:[],rowCount:1};
    });
    await assert.rejects(service.assign(actor,orderId,driverId),ConflictException);
    assert.ok(!statements.some(entry=>entry.sql.startsWith('INSERT INTO delivery_assignments')));
    assert.equal(statements.at(-1)?.sql,'ROLLBACK');
  });

  it('reports not found for an unknown order and validates ids before connecting',async()=>{
    const missing=poolWith(async(sql)=>sql.startsWith('SELECT o.id,o.status,o.customer_id')?{rows:[],rowCount:0}:{rows:[],rowCount:1});
    await assert.rejects(missing.service.assign(actor,orderId,driverId),NotFoundException);
    let connected=false;
    const guarded=new AdminOrdersService({connect:async()=>{connected=true;throw new Error('unreachable');},query:async()=>({rows:[],rowCount:0})} as never);
    await assert.rejects(guarded.assign(actor,'not-a-uuid',driverId),BadRequestException);
    await assert.rejects(guarded.assign(actor,orderId,'driver-1'),BadRequestException);
    assert.equal(connected,false);
  });
});
