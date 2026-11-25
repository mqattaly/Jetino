import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

describe('customer wallet', () => {
  it('requires authentication and never accepts a customer id from the caller', async () => {
    assert.ok((Reflect.getMetadata('__guards__', WalletController) as unknown[]).includes(JwtAuthGuard));
    let principal: unknown;
    const controller = new WalletController({ mine: async (user: unknown) => { principal = user; return {}; } } as never);
    await controller.mine({ user: { sub: 'customer-a' }, query: { userId: 'customer-b' } } as never);
    assert.deepEqual(principal, { sub: 'customer-a' });
  });
  it('queries only this principal and excludes historical external refunds', async () => {
    let sql = ''; let values: unknown[] = [];
    const service = new WalletService({ query: async (q: string, v: unknown[]) => { sql=q; values=v; return { rows: [{ balanceRial:'0',items:[] }] }; } } as never);
    assert.deepEqual(await service.mine({sub:'customer-a'}), {balanceRial:'0',items:[]});
    assert.deepEqual(values, ['customer-a']);
    assert.match(sql, /o\.customer_id=\$1 AND r\.destination='WALLET'/);
    assert.match(sql, /SUM\(amount_rial\)/);
  });
});
