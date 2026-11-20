import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { PG_POOL } from '../database/database.module';

// Uses an isolated scratch schema, never the production database. Exercises the
// actual HTTP router, OTP, JWT guard, wallet query and transactional refund API.
const databaseUrl = process.env.DATABASE_URL_TEST ?? '';
const suite = databaseUrl ? describe : describe.skip;

suite('customer wallet through the real HTTP application', () => {
  const schema = `wallet_http_${randomUUID().replace(/-/g, '')}`;
  const customer = randomUUID(), other = randomUUID(), manager = randomUUID();
  const business = randomUUID(), paid = randomUUID(), unpaid = randomUUID();
  const phone = { customer: '+989120000101', other: '+989120000102', manager: '+989120000103' };
  const previous = { ...process.env };
  let app: INestApplication; let pool: Pool; let url: string;

  before(async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      const directory = resolve(process.cwd(), 'src/database/migrations');
      for (const file of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
        await client.query(await readFile(resolve(directory, file), 'utf8'));
      }
      await client.query(`INSERT INTO users(id,phone) VALUES($1,$2),($3,$4),($5,$6)`, [customer,phone.customer,other,phone.other,manager,phone.manager]);
      await client.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'OPERATIONS_MANAGER')`, [manager]);
      await client.query(`INSERT INTO businesses(id,owner_id,region_id,name,status) SELECT $1,$2,id,'آزمون','ACTIVE' FROM regions WHERE slug='bandar-khamir'`, [business,manager]);
      await client.query(`INSERT INTO orders(id,customer_id,business_id,status,payment_method,payment_status,subtotal_rial,delivery_fee_rial,commission_rial,commission_bps,total_rial) VALUES($1,$3,$4,'DELIVERED','CASH','PAID',100000,0,0,0,100000),($2,$3,$4,'REJECTED','CASH','PENDING',100000,0,0,0,100000)`, [paid,unpaid,customer,business]);
      await client.query(`INSERT INTO cash_collections(order_id,amount_rial,collected_by) VALUES($1,100000,$2)`, [paid,manager]);
      // A legacy payout must not show as wallet credit, but does count against the refundable ceiling.
      await client.query(`INSERT INTO order_refunds(order_id,amount_rial,kind,reason,created_by) VALUES($1,10000,'REFUND','بازپرداخت قدیمی',$2)`, [paid,manager]);
    } finally { await client.end(); }
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = scoped.toString();
    process.env.JWT_SECRET = 'jwt-secret-for-isolated-wallet-tests-only';
    process.env.OTP_HMAC_SECRET = 'otp-secret-for-isolated-wallet-tests-only';
    process.env.JETINO_ALLOW_TEST_OTP = 'yes';
    delete process.env.KAVENEGAR_API_KEY; delete process.env.KAVENEGAR_OTP_TEMPLATE;
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    pool = app.get<Pool>(PG_POOL);
    const address = app.getHttpServer().address() as { port: number };
    url = `http://127.0.0.1:${address.port}/api/v1`;
  });
  after(async () => {
    if (app) { await app.close(); await pool.end(); }
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await client.end(); }
    process.env = previous;
  });
  const json = (body: unknown, token?: string) => ({
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}) }, body: JSON.stringify(body),
  });
  const login = async (number: string) => {
    const requested = await fetch(`${url}/auth/otp/request`, json({phone:number}));
    assert.equal(requested.status, 201);
    const {testCode} = await requested.json() as {testCode:string};
    const verified = await fetch(`${url}/auth/otp/verify`, json({phone:number,code:testCode}));
    assert.equal(verified.status, 201);
    return (await verified.json() as {accessToken:string}).accessToken;
  };
  const wallet = async (token: string) => {
    const response = await fetch(`${url}/wallet/mine`, { headers: { Authorization:`Bearer ${token}` } });
    assert.equal(response.status, 200);
    return await response.json() as {balanceRial:string;items:Array<{amountRial:string;orderId:string}>};
  };

  it('authenticates each customer, credits only collected money and prevents duplicate credits', async () => {
    assert.equal((await fetch(`${url}/wallet/mine`)).status, 401);
    assert.equal((await fetch(`${url}/wallet/mine`, {headers:{Authorization:'Bearer invalid'}})).status, 401);
    const customerToken = await login(phone.customer), otherToken = await login(phone.other), staffToken = await login(phone.manager);
    assert.deepEqual(await wallet(customerToken), {balanceRial:'0',items:[]}, 'old external payouts do not silently become wallet credits');
    const body = {requestKey:randomUUID(),amountRial:40000,reason:'بازپرداخت آزمایشی'};
    const endpoint = `${url}/cancellations/orders/${paid}/refunds`;
    assert.equal((await fetch(endpoint, json(body, customerToken))).status, 403);
    assert.equal((await fetch(`${url}/cancellations/orders/${unpaid}/refunds`, json({...body,requestKey:randomUUID()},staffToken))).status, 409);
    assert.equal((await fetch(endpoint, json(body, staffToken))).status, 201);
    const retry = await fetch(endpoint, json(body, staffToken));
    assert.equal(retry.status, 201);
    assert.equal((await retry.json() as {duplicate:boolean}).duplicate, true);
    const result = await wallet(customerToken);
    assert.equal(result.balanceRial, '40000');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].orderId, paid);
    assert.equal(result.items[0].amountRial, '40000');
    assert.deepEqual(await wallet(otherToken), {balanceRial:'0',items:[]}, 'one customer cannot read another customer’s credit');
    assert.equal((await fetch(endpoint, json({...body,requestKey:randomUUID(),amountRial:50001},staffToken))).status, 409);
  });
});
