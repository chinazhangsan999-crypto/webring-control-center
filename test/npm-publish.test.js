'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePackageName, npmVersionForJob, npmPageUrl, npmPackageFiles } = require('../src/services/npmPublishService');
const { deployDualPlatform } = require('../src/services/publishDeploymentService');

test('npm 包名支持安全的非 scoped 名称并生成稳定地址', () => {
  assert.equal(normalizePackageName('Link-Status-Page'), 'link-status-page');
  assert.equal(npmVersionForJob('33'), '0.0.33');
  assert.equal(npmPageUrl('link-status-page'), 'https://unpkg.com/link-status-page@latest/index.html');
  assert.equal(npmPageUrl('link-status-page', '0.0.33'), 'https://unpkg.com/link-status-page@0.0.33/index.html');
  assert.throws(() => normalizePackageName('../secret'), /格式不合法/);
});

test('npm 完整发布页包不含生命周期脚本并使用 OIDC 工作流发布', () => {
  const files = npmPackageFiles({ packageName: 'link-status-page', version: '0.0.33', githubRepo: 'owner/publish', siteName: '测试站' });
  const metadata = JSON.parse(files['package.json']);
  assert.equal(metadata.name, 'link-status-page');
  assert.equal(metadata.version, '0.0.33');
  assert.equal(metadata.scripts, undefined);
  assert.deepEqual(metadata.files, ['index.html', '404.html', 'publish-manifest.json', 'README.md']);
  assert.match(files['README.md'], /完整静态发布页/);
  assert.match(files['.github/workflows/publish-npm.yml'], /id-token: write/);
  assert.match(files['.github/workflows/publish-npm.yml'], /npm publish --access public/);
  assert.match(files['.github/workflows/publish-npm.yml'], /触发 npm 发布/);
});

test('npm 发布在 GitHub 成功后执行并计入三平台结果', async () => {
  const order = [];
  const result = await deployDualPlatform({
    githubPagesUrl: 'https://owner.github.io/publish/', permanentUrl: 'https://go.example.com/',
    npmPackageName: 'link-status-page', npmVersion: '0.0.33', sha256: 'e'.repeat(64)
  }, {}, {
    deployGithub: async () => { order.push('github'); return { commit_sha: 'commit' }; },
    deployCloudflare: async () => { order.push('cloudflare'); return { deployment_url: 'https://deploy.pages.dev' }; },
    deployNpm: async () => { order.push('npm'); return { package: 'link-status-page', version: '0.0.33' }; },
    verify: async () => ({ verified: true })
  });
  assert.equal(result.github.status, 'succeeded');
  assert.equal(result.cloudflare.status, 'succeeded');
  assert.equal(result.npm.status, 'succeeded');
  assert.ok(order.indexOf('npm') > order.indexOf('github'));
});
