'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('导航站本地广告统一回传，代码广告仍由独立 API 安全加载', async () => {
  const [agentRoute, adminRoute, edgeService, metadataMigration, localAdsMigration, positionsMigration, client] = await Promise.all([
    fs.readFile(path.join(root, 'src', 'routes', 'agent.js'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'routes', 'admin.js'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'services', 'adEdgeService.js'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'migrations', '016_site_ad_payload_metadata.sql'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'migrations', '017_site_local_ads.sql'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'migrations', '018_site_local_ad_positions.sql'), 'utf8'),
    fs.readFile(path.join(root, 'public', 'app.js'), 'utf8')
  ]);
  assert.match(agentRoute, /ad_position,priority,sandbox_options/);
  assert.match(agentRoute, /\['top_float', 'bottom_float', 'icon_float'\]/);
  assert.match(agentRoute, /router\.put\('\/local-ads\/:localAdId'/);
  assert.match(metadataMigration, /ADD COLUMN IF NOT EXISTS ad_position/);
  assert.match(localAdsMigration, /ADD COLUMN IF NOT EXISTS ad_type/);
  assert.match(positionsMigration, /'banner','icon','top_float','bottom_float','icon_float'/);
  assert.match(adminRoute, /router\.get\('\/site-local-ads'/);
  assert.match(adminRoute, /router\.get\('\/site-code-ads'/);
  assert.match(edgeService, /ad_type='code'/);
  assert.match(client, /导航站本地广告/);
  assert.match(client, /本站直接输出/);
});
