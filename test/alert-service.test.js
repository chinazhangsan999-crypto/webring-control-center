'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AlertService = require('../src/services/alertService');

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

const config = {
  siteName: '测试总控', telegramToken: 'token', telegramChatId: 'chat', barkUrl: 'https://bark.example/push', timeoutMs: 8000, retryDelayMs: 0
};

test('Bark 分片按 UTF-8 字节限制且不丢文字', () => {
  const input = `${'中文'.repeat(1600)}end`;
  const parts = AlertService.splitUtf8(input, 2500);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), input);
  assert.ok(parts.every(part => Buffer.byteLength(part, 'utf8') <= 2500));
});

test('Telegram 最多尝试两次，最终失败后转 Bark', async () => {
  const calls = [];
  const result = await AlertService.sendAlert({ title: '发布失败', body: '目标：https://example.com' }, {
    config,
    wait: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.includes('api.telegram.org')) return response({ ok: false, description: 'timeout' });
      return response({ code: 200, message: 'success' });
    }
  });
  assert.equal(calls.filter(call => call.url.includes('api.telegram.org')).length, 2);
  assert.equal(calls.filter(call => call.url.includes('bark.example')).length, 1);
  assert.equal(result.channel, 'bark');
  assert.match(result.title, /^【测试总控】发布失败$/);
  assert.match(calls.at(-1).body.markdown, /\[https:\/\/example\.com\]\(https:\/\/example\.com\)/);
});

test('Telegram 成功时不再调用 Bark', async () => {
  const calls = [];
  const result = await AlertService.sendAlert({ title: '完成', body: '任务完成' }, {
    config,
    fetchImpl: async url => { calls.push(url); return response({ ok: true, result: { message_id: 7 } }); }
  });
  assert.equal(result.channel, 'telegram');
  assert.equal(calls.length, 1);
});
