import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminReportsService } from './admin-reports.service';

const driverId='123e4567-e89b-12d3-a456-426614174030';
const settlementId='123e4567-e89b-12d3-a456-426614174031';
const actor={sub:'123e4567-e89b-12d3-a456-426614174032'};

function transactionalService(onQuery:(sql:string,values?:unknown[])=>Promise<{rows:unknown[];rowCount:number}>) {
  const statements:Array<{sql:string;values?:unknown[]}> = [];
  const client={query:async(sql:string,values?:unknown[])=>{statements.push({sql,values});return onQuery(sql,values);},release(){}};
  return {service:new AdminReportsService({connect:async()=>client} as never),statements};
}

describe('AdminReportsService',()=>{
 it('returns aggregate metrics for the selected range without order-level rows',async()=>{
  let sql='';let values:unknown[]|undefined;
  const service=new AdminReportsService({query:async(text:string,params?:unknown[])=>{sql=text;values=params;return{rows:[{totalOrders:'12',ordersInPeriod:'3',awaitingBusiness:'2',inDelivery:'1',deliveredOrders:'7',grossOrderValueRial:'9500000',cashCollectedRial:'7200000',unsettledCashRial:'1500000',unsettledCollections:'4'}],rowCount:1};}} as never);
  const result=await service.summary('7d');
  assert.equal(result.currency,'IRR');
  assert.equal(result.period,'7d');
  assert.equal(result.periodLabel,'۷ روز اخیر');
  assert.equal(result.ordersInPeriod,'3');
  assert.equal(result.cashCollectedRial,'7200000');
  assert.equal(result.unsettledCashRial,'1500000');
  assert.match(sql,/created_at >= now\(\) - \$1::interval/);
  assert.deepEqual(values,['7 days']);
  assert.match(sql,/payment_status='PAID'/);
  assert.match(sql,/WHERE settlement_id IS NULL/);
  assert.equal('items' in result,false);
  assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
 });

 it('rejects an unsupported report period without querying the database',async()=>{
  let queried=false;
  const service=new AdminReportsService({query:async()=>{queried=true;return{rows:[],rowCount:0};}} as never);
  await assert.rejects(service.summary('year'),BadRequestException);
  assert.equal(queried,false);
 });

 it('aggregates revenue and commission per business for the selected period',async()=>{
  let sql='';let values:unknown[]|undefined;
  const service=new AdminReportsService({query:async(text:string,params?:unknown[])=>{sql=text;values=params;return{rows:[{id:'b-1',name:'کسب‌وکار نمونه',regionName:'بندر خمیر',status:'ACTIVE',orderCount:12,ordersInPeriod:4,revenueRial:'40000',commissionRial:'4000',awaitingResponse:1,avgPrepMinutes:25,unpaidDeliveredRial:'5000'}],rowCount:1};}} as never);
  const report=await service.businessPerformance('30d');
  assert.equal(report.period,'30d');
  assert.equal(report.periodLabel,'۳۰ روز اخیر');
  assert.equal(report.items.length,1);
  assert.equal(report.items[0].revenueRial,'40000');
  assert.deepEqual(values,['30 days'],'the period must arrive as a bound parameter');
  assert.match(sql,/SUM\(o\.total_rial\) FILTER \(WHERE o\.created_at >= now\(\) - \$1::interval\)/);
  assert.match(sql,/SUM\(o\.commission_rial\) FILTER/);
  assert.match(sql,/HAVING COUNT\(o\.id\) FILTER/);
  assert.match(sql,/LIMIT 50/);
  assert.ok(!/u\.phone|delivery_address/i.test(sql),'the performance report must not return customer-level data');
 });

 it('reads ratings without joining them so no money column is multiplied',async()=>{
  let sql='';let values:unknown[]|undefined;
  const service=new AdminReportsService({ query: async (text: string, params?: unknown[]) => { sql = text; values = params; return { rows: [] }; } } as never);
  await service.businessPerformance('7d');
  assert.match(sql,/SELECT COUNT\(\*\)::int FROM order_feedback f WHERE f\.business_id=b\.id AND f\.created_at >= now\(\) - \$1::interval/,'the feedback window must use the same bound period');
  assert.match(sql,/AVG\(f\.business_rating\)/,'the average must come from the ratings table');
  assert.ok(!/JOIN order_feedback/.test(sql),'a joined feedback table would multiply every revenue sum');
  assert.deepEqual(values,['7 days'],'the extra subqueries must not add parameters');
 });

 it('rejects an unsupported performance period before querying',async()=>{
  let queried=false;
  const service=new AdminReportsService({query:async()=>{queried=true;return{rows:[],rowCount:0};}} as never);
  await assert.rejects(service.businessPerformance('99y'),BadRequestException);
  assert.equal(queried,false);
 });

 it('lists open cash per driver using the settlement filter',async()=>{  let sql='';
  const service=new AdminReportsService({query:async(text:string)=>{sql=text;return{rows:[{driverId,driverPhone:'09120000000',regionName:'بندر خمیر',openCount:3,openCashRial:'750000',lastCollectedAt:new Date().toISOString()}],rowCount:1};}} as never);
  const rows=await service.cashOutstanding();
  assert.equal(rows.length,1);
  assert.equal(rows[0].openCashRial,'750000');
  assert.match(sql,/WHERE cc.settlement_id IS NULL/);
  assert.match(sql,/GROUP BY d\.id,u\.phone,r\.name/);
 });

 describe('cash settlement',()=>{
  it('settles every open collection for one driver and informs the driver',async()=>{
   const {service,statements}=transactionalService(async(sql)=>{
    if(sql.startsWith('SELECT d.id,d.user_id FROM drivers'))return{rows:[{id:driverId,user_id:'driver-user'}],rowCount:1};
    if(sql.startsWith('SELECT id,amount_rial FROM cash_collections'))return{rows:[{id:'c-1',amount_rial:'2500'},{id:'c-2',amount_rial:'3000'}],rowCount:2};
    if(sql.startsWith('INSERT INTO cash_settlements'))return{rows:[{id:settlementId,settled_at:new Date('2026-11-17T12:00:00Z')}],rowCount:1};
    return{rows:[],rowCount:1};
   });
   const result=await service.settle(actor,driverId,'5500','دستگردی صبح');
   assert.deepEqual(result,{id:settlementId,driverId,amountRial:'5500',orderCount:2,settledAt:new Date('2026-11-17T12:00:00Z')});
   assert.equal(statements[0].sql,'BEGIN');
   assert.match(statements[1].sql,/FROM drivers d WHERE d.id=\$1 FOR UPDATE/);
   assert.match(statements[2].sql,/settlement_id IS NULL AND collected_by=\$1/);
   assert.match(statements[2].sql,/FOR UPDATE/);
   const insert=statements.find(entry=>entry.sql.startsWith('INSERT INTO cash_settlements'))!;
   assert.deepEqual(insert.values,[driverId,'5500',2,actor.sub,'دستگردی صبح']);
   const link=statements.find(entry=>entry.sql.startsWith('UPDATE cash_collections SET settlement_id'))!;
   assert.deepEqual(link.values,[settlementId,['c-1','c-2']]);
   const notice=statements.find(entry=>entry.sql.startsWith('INSERT INTO notifications'))!;
   assert.equal(notice.values?.[0],'driver-user');
   assert.equal(notice.values?.[1],'CASH_SETTLED');
   assert.ok(statements.some(entry=>entry.sql.includes('CASH_SETTLEMENT_RECORDED')));
   assert.equal(statements.at(-1)?.sql,'COMMIT');
  });

  it('rejects a stale expected amount without writing a settlement',async()=>{
   const {service,statements}=transactionalService(async(sql)=>{
    if(sql.startsWith('SELECT d.id,d.user_id FROM drivers'))return{rows:[{id:driverId,user_id:'driver-user'}],rowCount:1};
    if(sql.startsWith('SELECT id,amount_rial FROM cash_collections'))return{rows:[{id:'c-1',amount_rial:'9000'}],rowCount:1};
    return{rows:[],rowCount:1};
   });
   await assert.rejects(service.settle(actor,driverId,'5500'),ConflictException);
   assert.ok(!statements.some(entry=>entry.sql.startsWith('INSERT INTO cash_settlements')));
   assert.ok(!statements.some(entry=>entry.sql.startsWith('UPDATE cash_collections')));
   assert.equal(statements.at(-1)?.sql,'ROLLBACK');
  });

  it('refuses to settle when nothing is outstanding',async()=>{
   const {service,statements}=transactionalService(async(sql)=>{
    if(sql.startsWith('SELECT d.id,d.user_id FROM drivers'))return{rows:[{id:driverId,user_id:'driver-user'}],rowCount:1};
    return{rows:[],rowCount:0};
   });
   await assert.rejects(service.settle(actor,driverId,'5500'),ConflictException);
   assert.ok(!statements.some(entry=>entry.sql.startsWith('INSERT INTO cash_settlements')));
   assert.equal(statements.at(-1)?.sql,'ROLLBACK');
  });

  it('hides drivers that do not exist instead of leaking their rows',async()=>{
   const {service,statements}=transactionalService(async()=>({rows:[],rowCount:0}));
   await assert.rejects(service.settle(actor,driverId,'5500'),NotFoundException);
   assert.ok(!statements.some(entry=>entry.sql.includes('cash_collections')));
   assert.equal(statements.at(-1)?.sql,'ROLLBACK');
  });

  it('validates ids and amounts before opening a transaction',async()=>{
   let connected=false;
   const service=new AdminReportsService({connect:async()=>{connected=true;throw new Error('unreachable');}} as never);
   await assert.rejects(service.settle(actor,'driver-1','5500'),BadRequestException);
   await assert.rejects(service.settle(actor,driverId,'۵۵۰۰'),BadRequestException);
   await assert.rejects(service.settle(actor,driverId,'0'),BadRequestException);
   await assert.rejects(service.settle(actor,driverId,'5500.5'),BadRequestException);
   assert.equal(connected,false);
  });
 });
});
