import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readCronLimit } from './dispatch-cron';
import { DISPATCH_BATCH_LIMIT } from './notification-delivery.util';

describe('cron dispatch limit', () => {
  it('defaults to the batch limit when nothing is configured', () => {
    assert.equal(readCronLimit(undefined), DISPATCH_BATCH_LIMIT);
    assert.equal(readCronLimit(''), DISPATCH_BATCH_LIMIT);
  });

  it('accepts a smaller limit so a cautious install can send fewer at a time', () => {
    assert.equal(readCronLimit('10'), 10);
    assert.equal(readCronLimit(10), 10);
  });

  it('never lets one tick grow past the batch limit', () => {
    assert.equal(readCronLimit('5000'), DISPATCH_BATCH_LIMIT);
  });

  it('ignores junk instead of sending nothing', () => {
    assert.equal(readCronLimit('abc'), DISPATCH_BATCH_LIMIT);
    assert.equal(readCronLimit('0'), DISPATCH_BATCH_LIMIT);
    assert.equal(readCronLimit('-5'), DISPATCH_BATCH_LIMIT);
    assert.equal(readCronLimit('2.5'), DISPATCH_BATCH_LIMIT);
  });
});
