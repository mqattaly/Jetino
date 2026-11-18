import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdminReportsService } from './admin-reports.service';

describe('AdminReportsService',()=>{
 it('returns aggregate order and cash metrics without exposing order-level rows',async()=>{
  let sql='';
  const service=new AdminReportsService({query:async(text:string)=>{sql=text;return{rows:[{totalOrders:'12',ordersLast24Hours:'3',awaitingBusiness:'2',inDelivery:'1',deliveredOrders:'7',grossOrderValueRial:'9500000',cashCollectedRial:'7200000'}],rowCount:1};}} as never);
  const result=await service.summary();
  assert.equal(result.currency,'IRR');
  assert.equal(result.totalOrders,'12');
  assert.equal(result.cashCollectedRial,'7200000');
  assert.match(sql,/COUNT\(\*\) FILTER/);
  assert.match(sql,/payment_status='PAID'/);
  assert.equal('items' in result,false);
  assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
 });
});
