#!/usr/bin/env node

const hostname = String(process.argv[2] || '').trim().toLowerCase();
if (!hostname) throw new Error('请传入广告 API 域名');

const service = await import('../../src/services/adEdgeService.js');
const profiles = await service.default.listProfiles();
const profile = profiles.find(item => item.hostname === hostname);
if (!profile) throw new Error(`未找到广告 API 配置：${hostname}`);

const result = await service.default.deployProfile(profile.id);
process.stdout.write(`${JSON.stringify({
  id: result.id,
  hostname: result.hostname,
  worker_version: result.worker_version,
  health_status: result.health_status,
  last_error: result.last_error || ''
})}\n`);
process.exit(result.health_status === 'error' ? 1 : 0);
