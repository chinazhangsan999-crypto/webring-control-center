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
    assert.match(html, /styles\.css\?v=12/);
  assert.match(html, /app\.js\?v=24/);
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

test('部署与备份脚本沿用目标服务器服务用户且兼容单 Compose 文件', () => {
  const deploy = fs.readFileSync(path.join(__dirname, '..', 'infra', 'gcp', 'deploy-control-center.sh'), 'utf8');
  const backup = fs.readFileSync(path.join(__dirname, '..', 'infra', 'gcp', 'control-center-backup'), 'utf8');
  assert.match(deploy, /service_user=.*stat -c/);
  assert.match(deploy, /sudo -u "\$service_user"/);
  assert.match(backup, /service_user=.*stat -c/);
  assert.match(backup, /compose_project=.*control-center/);
  assert.match(backup, /compose_args=\(-p "\$compose_project"/);
  assert.match(backup, /\. "\$secret_dir\/control-center\.env"/);
  assert.match(backup, /runuser -u "\$service_user" --preserve-environment/);
  assert.match(backup, /if \[\[ -f compose\.production\.yaml \]\]/);
  assert.doesNotMatch(backup, /runuser -u webring/);
});
