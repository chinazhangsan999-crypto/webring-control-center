'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('初始迁移覆盖第一阶段核心持久化实体', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '001_initial.sql'), 'utf8');
  for (const table of ['admins', 'admin_sessions', 'sites', 'site_credentials', 'site_groups', 'nodes', 'ads', 'ad_slot_policies', 'publish_pages', 'jobs', 'audit_logs']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
});

test('共享协议迁移记录 Agent 协议能力和已应用修订号', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '002_shared_protocol.sql'), 'utf8');
  for (const column of ['protocol_version', 'capabilities', 'applied_revision']) assert.match(sql, new RegExp(`\\b${column}\\b`));
});

test('共享协议的 JSON Schema 都是可解析的机器可读文档', () => {
  const directory = path.join(__dirname, '..', 'packages', 'shared-protocol', 'schemas');
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
  assert.ok(files.length >= 5);
  for (const name of files) {
    const schema = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /\/protocol\/v1\//);
  }
});

test('第三阶段迁移在数据库层强制单超级管理员和发布任务幂等', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '003_single_super_admin.sql'), 'utf8');
  assert.match(sql, /ux_admins_singleton/);
  assert.match(sql, /UNIQUE INDEX[\s\S]+admins\(singleton_key\)/i);
  assert.match(sql, /user_agent/);
  assert.match(sql, /ux_jobs_active_publish_site/);
  assert.match(sql, /status IN \('queued', 'running'\)/);
});

test('第五阶段迁移增加统一节点排序索引', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '004_unified_nodes.sql'), 'utf8');
  assert.match(sql, /sort_order\s+INTEGER\s+NOT NULL\s+DEFAULT 0/i);
  assert.match(sql, /idx_nodes_delivery_order/);
});

test('第六阶段迁移增加广告下发排序索引', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '005_ad_mix_indexes.sql'), 'utf8');
  assert.match(sql, /idx_ads_delivery_order/);
  assert.match(sql, /priority DESC/);
});

test('第十阶段迁移增加队列优先级、进度、心跳与错误码', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '006_job_queue_alerts.sql'), 'utf8');
  for (const column of ['priority', 'progress_current', 'progress_total', 'heartbeat_at', 'error_code']) {
    assert.match(sql, new RegExp(`\\b${column}\\b`));
  }
  assert.match(sql, /idx_jobs_claim_priority/);
  assert.match(sql, /jobs_progress_valid/);
});

test('npm 发布页迁移增加启用状态和包名', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '007_npm_publish_page.sql'), 'utf8');
  assert.match(sql, /npm_enabled\s+BOOLEAN\s+NOT NULL\s+DEFAULT FALSE/i);
  assert.match(sql, /npm_package_name\s+TEXT\s+NOT NULL\s+DEFAULT ''/i);
});

test('站点级发布平台迁移隔离账号模式与加密凭据', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '011_site_publish_platform_accounts.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS site_publish_platforms/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS site_publish_secrets/);
  assert.match(sql, /UNIQUE|PRIMARY KEY \(site_id, platform\)/i);
  assert.match(sql, /credential_version/);
  assert.match(sql, /WHEN platform='github'.*THEN 'global'/s);
});

test('npm 首次发布迁移只保存流程状态，不保存临时 Token', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '012_npm_bootstrap.sql'), 'utf8');
  assert.match(sql, /npm_bootstrap_status/);
  assert.match(sql, /npm_bootstrap_version/);
  assert.match(sql, /npm_oidc_verified_at/);
  assert.doesNotMatch(sql, /token/i);
});

test('永久发布页排序迁移保存独立权重配置', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '014_publish_link_sorting.sql'), 'utf8');
  assert.match(sql, /publish_link_weights\s+JSONB\s+NOT NULL/i);
});
