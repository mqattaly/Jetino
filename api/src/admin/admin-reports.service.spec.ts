import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { AdminReportsService } from './admin-reports.service';

describe('AdminReportsService',()=>{
 it('returns aggregate metrics for the selected range without order-level rows',async()=>{
  let sql='';let values:unknown[]|undefined;
  const service=new AdminReportsService({query:async(text:string,params?:unknown[])=>{sql=text;values=params;return{rows:[{totalOrders:'12',ordersInPeriod:'3',awaitingBusiness:'2',inDelivery:'1',deliveredOrders:'7',grossOrderValueRial:'9500000',cashCollectedRial:'7200000'}],rowCount:1};}} as never);
  const result=await service.summary('7d');
  assert.equal(result.currency,'IRR');
  assert.equal(result.period,'7d');
  assert.equal(result.periodLabel,'۷ روز اخیر');
  assert.equal(result.ordersInPeriod,'3');
  assert.equal(result.cashCollectedRial,'7200000');
  assert.match(sql,/created_at >= now\(\) - \$1::interval/);
  assert.deepEqual(values,['7 days']);
  assert.match(sql,/payment_status='PAID'/);
  assert.equal('items' in result,false);
  assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
 });

 it('rejects an unsupported report period without querying the database',async()=>{
  let queried=false;
  const service=new AdminReportsService({query:async()=>{queried=true;return{rows:[],rowCount:0};}} as never);
  await assert.rejects(service.summary('year'),BadRequestException);
  assert.equal(queried,false);
 });
});
