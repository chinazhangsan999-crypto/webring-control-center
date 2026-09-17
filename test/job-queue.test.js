'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyJobError, retryDelaySeconds, completedPublishSteps } = require('../src/services/jobQueueService');

test('任务错误被归入稳定错误码', () => {
  assert.equal(classifyJobError({ message: 'request timed out' }), 'TIMEOUT');
  assert.equal(classifyJobError({ message: 'HTTP 429 rate limit', status: 429 }), 'RATE_LIMIT');
  assert.equal(classifyJobError({ message: 'GitHub token invalid', status: 401 }), 'AUTH');
  assert.equal(classifyJobError({ message: 'DNS ENOTFOUND' }), 'NETWORK');
  assert.equal(classifyJobError({ message: '发布版本 revision 已变化', retryable: false }), 'STALE_REVISION');
});

test('任务使用有上限的指数退避', () => {
  assert.equal(retryDelaySeconds(1), 30);
  assert.equal(retryDelaySeconds(2), 120);
  assert.equal(retryDelaySeconds(3), 480);
  assert.equal(retryDelaySeconds(4), 600);
});

test('双平台发布进度按完成平台计算', () => {
  assert.equal(completedPublishSteps({}), 1);
  assert.equal(completedPublishSteps({ cloudflare: { status: 'succeeded' } }), 2);
  assert.equal(completedPublishSteps({ cloudflare: { status: 'succeeded' }, github: { status: 'failed' } }), 3);
  assert.equal(completedPublishSteps({ cloudflare: { status: 'succeeded' }, github: { status: 'succeeded' }, npm: { status: 'succeeded' } }), 4);
});
