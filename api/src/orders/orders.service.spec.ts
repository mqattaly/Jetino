import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

function service(connect: () => void) {
  return new OrdersService({ connect: () => { connect(); throw new Error('database should not be reached'); } } as never);
}

describe('OrdersService preparation estimate validation', () => {
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
