import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AddressesService } from './addresses.service';

const addressId='123e4567-e89b-12d3-a456-426614174000';

describe('AddressesService coordinate validation and ownership',()=>{
 it('rejects a partial GPS coordinate pair before opening a transaction',async()=>{
  let connected=false;
  const service=new AddressesService({connect:()=>{connected=true;throw new Error('unexpected connection');}} as never);
  await assert.rejects(service.create({sub:'user-1'},{label:'خانه',addressText:'نشانی نمونه',latitude:27.2}),BadRequestException);
  assert.equal(connected,false);
 });

 it('rejects out-of-range longitude before opening a transaction',async()=>{
  let connected=false;
  const service=new AddressesService({connect:()=>{connected=true;throw new Error('unexpected connection');}} as never);
  await assert.rejects(service.create({sub:'user-1'},{label:'خانه',addressText:'نشانی نمونه',latitude:27.2,longitude:181}),BadRequestException);
  assert.equal(connected,false);
 });

 it('scopes address updates to the owner and rolls back for another user',async()=>{
  const statements:Array<{sql:string;values?:unknown[]}> = [];
  const client={query:async(sql:string,values?:unknown[])=>{statements.push({sql,values});return sql.startsWith('SELECT label')?{rows:[],rowCount:0}:{rows:[],rowCount:1};},release(){}};
  const service=new AddressesService({connect:async()=>client} as never);
  await assert.rejects(service.update({sub:'user-2'},addressId,{label:'خانه'}),NotFoundException);
  const select=statements.find(entry=>entry.sql.startsWith('SELECT label'))!;
  assert.match(select.sql,/WHERE id=\$1 AND user_id=\$2 FOR UPDATE/);
  assert.deepEqual(select.values,[addressId,'user-2']);
  assert.equal(statements.at(-1)?.sql,'ROLLBACK');
 });
});
