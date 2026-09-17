'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

test('第三阶段暴露单超级管理员安全与任务控制接口', () => {
  const adminRoutes = source('src/routes/admin.js');
  const app = source('src/app.js');

  assert.match(adminRoutes, /router\.get\('\/security'/);
  assert.match(adminRoutes, /router\.put\('\/security\/account'/);
  assert.match(adminRoutes, /router\.post\('\/security\/revoke-sessions'/);
  assert.match(adminRoutes, /router\.post\('\/jobs\/:id\/retry'/);
  assert.match(adminRoutes, /router\.post\('\/jobs\/:id\/cancel'/);
  assert.match(app, /app\.get\('\/api\/ready'/);
});

test('认证查询固定使用数据库中的唯一管理员标记', () => {
  const authRoutes = source('src/routes/auth.js');
  const authMiddleware = source('src/middleware/auth.js');

  assert.match(authRoutes, /singleton_key\s*=\s*TRUE/);
  assert.match(authMiddleware, /a\.singleton_key\s*=\s*TRUE/);
});

test('总后台只把 SSO 票据放入目标站 URL Fragment', () => {
  const controlService = source('src/services/controlService.js');
  assert.match(controlService, /control-center\/login/);
  assert.match(controlService, /url\.hash\s*=\s*`control-ticket=/);
  assert.doesNotMatch(controlService, /searchParams\.set\(['"]ticket/);
});

test('统一节点管理提供单站有效快照预览接口', () => {
  const adminRoutes = source('src/routes/admin.js');
  const controlService = source('src/services/controlService.js');
  assert.match(adminRoutes, /router\.get\('\/sites\/:id\/nodes'/);
  assert.match(adminRoutes, /ORDER BY n\.sort_order DESC,n\.id ASC/);
  assert.doesNotMatch(controlService, /WHERE n\.enabled=TRUE/);
});

test('广告混合管理提供策略总览和单站有效快照', () => {
  const adminRoutes = source('src/routes/admin.js');
  const adminApp = source('public/app.js');
  assert.match(adminRoutes, /router\.get\('\/ad-policies'/);
  assert.match(adminRoutes, /router\.get\('\/sites\/:id\/ads'/);
  assert.match(adminRoutes, /parseAdPolicies/);
  assert.match(adminApp, /广告混合管理/);
  assert.match(adminApp, /ad-site-preview/);
  assert.match(adminApp, /五个广告位策略/);
});

test('永久发布页生成独立静态包并支持 npm 第三发布地址', () => {
  const adminRoutes = source('src/routes/admin.js');
  const worker = source('src/services/jobWorker.js');
  const adminApp = source('public/app.js');
  assert.match(adminRoutes, /请同时填写自定义永久发布域名和 GitHub Pages 地址/);
  assert.match(adminRoutes, /自定义永久发布域名不能使用 pages\.dev 原生地址/);
  assert.match(adminRoutes, /GitHub Pages 地址必须使用 github\.io 原生地址/);
  assert.match(adminRoutes, /parsePublishPayload/);
  assert.match(worker, /renderPublishBundle/);
  assert.match(worker, /site\.public_url/);
  assert.match(adminApp, /发布完整页面到三平台/);
  assert.match(adminApp, /npm CDN 完整发布页/);
  assert.match(adminApp, /publish-open/);
  assert.match(adminApp, /打开页面/);
  assert.match(adminApp, /npm_package_name/);
  assert.match(adminApp, /page_title/);
});

test('三平台工作流独立记录状态并执行远端摘要校验', () => {
  const deployment = source('src/services/publishDeploymentService.js');
  const worker = source('src/services/jobWorker.js');
  const environment = source('.env.example');
  assert.match(deployment, /deployGithubPages/);
  assert.match(deployment, /deployCloudflarePages/);
  assert.match(deployment, /deployNpmPackage/);
  assert.match(deployment, /verifyPublishedManifest/);
  assert.match(deployment, /Promise\.all\(/);
  assert.match(worker, /previous\.platforms/);
  assert.match(worker, /publish\.deploy\.succeeded/);
  assert.match(source('src/services/controlService.js'), /bumpRevisions\('publish', \[id\], client\)/);
  assert.match(environment, /PUBLISH_GITHUB_TOKEN/);
  assert.match(environment, /PUBLISH_CLOUDFLARE_API_TOKEN/);
});

test('第九阶段提供发布预览、单站历史与失败平台重试', () => {
  const adminRoutes = source('src/routes/admin.js');
  const worker = source('src/services/jobWorker.js');
  const adminApp = source('public/app.js');
  assert.match(adminRoutes, /router\.get\('\/sites\/:id\/publish\/preview'/);
  assert.match(adminRoutes, /router\.get\('\/sites\/:id\/publish\/history'/);
  assert.match(adminRoutes, /style-src 'unsafe-inline'; script-src 'unsafe-inline'/);
  assert.match(worker, /renderPublishPreview/);
  assert.match(adminApp, /站点发布流水线/);
  assert.match(adminApp, /publish-preview/);
  assert.match(adminApp, /publish-history/);
  assert.match(adminApp, /publish-retry/);
  assert.match(adminApp, /重试失败平台/);
});

test('第十阶段提供持久任务进度、恢复和 Telegram 到 Bark 告警链路', () => {
  const adminRoutes = source('src/routes/admin.js');
  const worker = source('src/services/jobWorker.js');
  const alerts = source('src/services/alertService.js');
  const adminApp = source('public/app.js');
  assert.match(adminRoutes, /router\.get\('\/jobs\/overview'/);
  assert.match(adminRoutes, /router\.post\('\/alerts\/test'/);
  assert.match(worker, /recoverStaleJobs/);
  assert.match(worker, /heartbeat_at/);
  assert.match(alerts, /sendTelegram/);
  assert.match(alerts, /sendBark/);
  assert.match(alerts, /attempt <= 2/);
  assert.match(adminApp, /24 小时告警成功率/);
  assert.match(adminApp, /最近告警失败/);
});
