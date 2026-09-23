'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('广告 Edge Worker 使用固定兼容日期，不随服务器日期漂移', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'adEdgeService.js'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, '..', 'assets', 'ad-edge-worker.js'), 'utf8');
  assert.match(source, /WORKER_COMPATIBILITY_DATE = '2024-12-01'/);
  assert.match(source, /WORKER_VERSION = '2.0.1'/);
  assert.match(source, /compatibility_date: WORKER_COMPATIBILITY_DATE/);
  assert.doesNotMatch(source, /compatibility_date:\s*new Date/);
  assert.match(source, /override_existing_origin: true/);
  assert.match(worker, /VERSION = '2.0.1'/);
});

test('广告 Edge Worker 将本地与中央广告来源纳入签名', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'assets', 'ad-edge-worker.js'), 'utf8');
  assert.match(worker, /ad_source/);
  assert.match(worker, /x-ad-edge-source/);
  assert.match(worker, /\$\{payload\.render_mode\}\\n\$\{source\}/);
});
