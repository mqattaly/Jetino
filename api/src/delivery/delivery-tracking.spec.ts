import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DeliveryService } from './delivery.service';

const orderId = '123e4567-e89b-12d3-a456-426614174010';
const customer = { sub: '223e4567-e89b-12d3-a456-426614174010' };

function serviceWithRow(row: Record<string, unknown> | null) {
  const pool = { query: async () => (row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }) };
  return new DeliveryService(pool as never);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    status: 'OUT_FOR_DELIVERY',
    destinationLatitude: 26.95,
    destinationLongitude: 55.58,
    driverId: '323e4567-e89b-12d3-a456-426614174010',
    driverName: 'رضا پیک',
    driverPhotoUrl: 'https://cdn.example.test/riders/reza.jpg',
    driverPlateNumber: '12ب34567',
    driverVehicleType: 'MOTORCYCLE',
    driverVerificationStatus: 'APPROVED',
    latitude: 26.952,
    longitude: 55.585,
    accuracyMeters: 12,
    locationUpdatedAt: new Date(),
    ...overrides,
  };
}

describe('DeliveryService live tracking', () => {
  it('refuses a malformed order id before touching the database', async () => {
    const service = serviceWithRow(null);
    await assert.rejects(service.trackingForOrder(customer, 'not-a-uuid'), BadRequestException);
  });

  it('answers the same 404 for an order of somebody else', async () => {
    const service = serviceWithRow(null);
    await assert.rejects(service.trackingForOrder(customer, orderId), NotFoundException);
  });

  it('says so when no courier is assigned yet', async () => {
    const result = await serviceWithRow(row({ driverId: null, latitude: null, locationUpdatedAt: null })).trackingForOrder(customer, orderId);
    assert.equal(result.driver, null);
    assert.equal(result.live, false);
    assert.match(result.message, /پیکی/);
  });

  it('returns the pin, the door-check identity and a rough ETA for a fresh fix', async () => {
    const result = await serviceWithRow(row()).trackingForOrder(customer, orderId);
    assert.equal(result.live, true);
    assert.equal(result.stale, false);
    assert.deepEqual(result.location && { latitude: result.location.latitude, longitude: result.location.longitude }, { latitude: 26.952, longitude: 55.585 });
    assert.equal(result.driver?.verified, true);
    assert.equal(result.driver?.plateNumber, '12ب34567');
    assert.ok((result.distanceMeters ?? 0) > 0);
    assert.ok((result.etaMinutes ?? 0) >= 1);
  });

  it('never draws a frozen pin: an old fix is reported as last-seen only', async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const result = await serviceWithRow(row({ locationUpdatedAt: old })).trackingForOrder(customer, orderId);
    assert.equal(result.live, false);
    assert.equal(result.stale, true);
    assert.equal(result.location, null);
    assert.equal(new Date(result.lastSeenAt as unknown as string).getTime(), old.getTime());
    assert.match(result.message, /قدیمی/);
  });
});
