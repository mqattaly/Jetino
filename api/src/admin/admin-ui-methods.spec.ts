import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adminApiMethod } from '../../../src/adminApiMethod';

describe('admin login request contract',()=>{
 it('uses the actual POST endpoints for OTP and retains PATCH for settings',()=>{
  assert.equal(adminApiMethod('/api/v1/auth/otp/request',true),'POST');
  assert.equal(adminApiMethod('/api/v1/auth/otp/verify',true),'POST');
  assert.equal(adminApiMethod('/api/v1/admin/settings',true),'PATCH');
  assert.equal(adminApiMethod('/api/v1/admin/settings',false),'GET');
  const admin=readFileSync(resolve(process.cwd(),'../src/AdminApp.tsx'),'utf8');
  assert.match(admin,/method:\s*adminApiMethod\(path, body !== undefined\)/);
 });
});
