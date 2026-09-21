'use strict';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { pool } = require('../src/db');

test('未登录时静态页面可访问且后台壳层受 hidden 规则保护', async () => {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    const html = await response.text();
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(html, /id="appShell" class="app-shell" hidden/);
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
    assert.match(html, /class="sidebar tabs"/);
    assert.match(html, /id="navToggle"/);
    assert.match(html, /name="color-scheme" content="light"/);
  assert.match(html, /data-view="security"/);
  assert.match(html, /data-view="settings"/);
    assert.match(html, /data-modal-close/);
    assert.match(html, /styles\.css\?v=11/);
  assert.match(html, /app\.js\?v=19/);
    const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(script, /normalizeModalMarkup\(body\)/);
    assert.match(script, /focusTitle:false/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});

test('Linux 运维脚本使用 LF 换行，避免 systemd 读取到 bash 回车', () => {
  const files = [
    'infra/gcp/bootstrap.sh',
    'infra/gcp/configure-production.sh',
    'infra/gcp/deploy-control-center.sh',
    'infra/gcp/inspect-control-center.sh',
    'infra/gcp/control-center-backup'
  ];

  for (const file of files) {
    const content = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(content, /\r\n/, `${file} 必须使用 LF 换行`);
  }
});
