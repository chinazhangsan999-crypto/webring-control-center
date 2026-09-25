'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePackageName, npmVersionForJob, npmPageUrl, npmPackageFiles } = require('../src/services/npmPublishService');
const { deployDualPlatform, deployNpmPackage, verifyNpmCdnLine, waitForNpmWorkflow } = require('../src/services/publishDeploymentService');

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

test('npm 精确版本存在不同清单时立即停止，不触发覆盖发布', async () => {
  let triggered = false;
  await assert.rejects(() => deployNpmPackage({
    npmPackageName: 'link-status-page', npmVersion: '0.0.99', sha256: 'a'.repeat(64)
  }, {
    inspectNpmRegistry: async () => ({ manifest: { sha256: 'b'.repeat(64) }, tarball_url: 'https://registry.test/package.tgz' }),
    triggerNpm: async () => { triggered = true; }
  }), error => error.retryable === false && /版本内容冲突/.test(error.message));
  assert.equal(triggered, false);
});

test('npm 精确版本校验成功后，latest 传播延迟不会阻塞发布结果', async () => {
  const calls = [];
  const result = await deployNpmPackage({
    npmPackageName: 'link-status-page', npmVersion: '0.0.99', sha256: 'a'.repeat(64), npmCdnLines: ['unpkg'], npmPrimaryCdn: 'unpkg'
  }, {
    fetchImpl: async () => new Response('', { status: 404 }),
    inspectNpmRegistry: async () => null,
    triggerNpm: async () => ({ trigger_commit_sha: 'trigger' }),
    waitForNpmWorkflow: async () => ({ workflow_run_id: 123, workflow_conclusion: 'success' }),
    verifyNpmRegistry: async () => ({ verified: true, tarball_url: 'https://registry.test/package.tgz' }),
    verify: async url => {
      calls.push(url);
      if (url.includes('@latest')) throw new Error('远端清单版本尚未更新');
      return { verified: true, manifest_url: `${url}publish-manifest.json` };
    }
  });
  assert.equal(result.stable_status, 'syncing');
  assert.equal(result.exact_url, 'https://unpkg.com/link-status-page@0.0.99/index.html');
  assert.ok(calls.some(url => url.includes('@latest')));
});

test('npm 工作流成功后持久化已接收状态，Registry 延迟不会丢失幂等信息', async () => {
  let accepted;
  await assert.rejects(() => deployNpmPackage({
    npmPackageName: 'link-status-page', npmVersion: '0.0.101', sha256: 'c'.repeat(64)
  }, {
    inspectNpmRegistry: async () => null,
    triggerNpm: async () => ({ trigger_commit_sha: 'accepted-commit' }),
    waitForNpmWorkflow: async () => ({ workflow_run_id: 101, workflow_url: 'https://github.test/run/101', workflow_conclusion: 'success' }),
    verifyNpmRegistry: async () => { throw new Error('Registry 尚未出现版本'); },
    onNpmAccepted: async value => { accepted = value; }
  }), error => error.retryable === true
    && error.detail?.publication_accepted === true
    && error.detail?.registry_processing === true
    && error.detail?.version === '0.0.101');
  assert.equal(accepted.trigger_commit_sha, 'accepted-commit');
  assert.equal(accepted.manifest_sha256, 'c'.repeat(64));
});

test('npm 重试已接收版本时只等待 Registry，不再次触发 GitHub Actions', async () => {
  let triggered = 0;
  const result = await deployNpmPackage({
    npmPackageName: 'link-status-page', npmVersion: '0.0.102', sha256: 'd'.repeat(64), npmCdnLines: ['unpkg'], npmPrimaryCdn: 'unpkg'
  }, {
    previousNpm: {
      publication_accepted: true,
      package: 'link-status-page',
      version: '0.0.102',
      manifest_sha256: 'd'.repeat(64),
      trigger_commit_sha: 'previous-commit',
      workflow_run_id: 102,
      workflow_url: 'https://github.test/run/102',
      workflow_conclusion: 'success'
    },
    inspectNpmRegistry: async () => null,
    triggerNpm: async () => { triggered += 1; return {}; },
    verifyNpmRegistry: async () => ({ verified: true, tarball_url: 'https://registry.test/package.tgz' }),
    verify: async () => ({ verified: true, manifest_url: 'https://cdn.test/publish-manifest.json' }),
    fetchImpl: async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(triggered, 0);
  assert.equal(result.trigger_commit_sha, 'previous-commit');
  assert.equal(result.registry_processing, false);
});

test('三平台重试把上次 npm 已接收信息传给部署器', async () => {
  const previousNpm = { status: 'failed', publication_accepted: true, package: 'link-status-page', version: '0.0.103', manifest_sha256: 'e'.repeat(64) };
  let resumed;
  const result = await deployDualPlatform({
    githubPagesUrl: 'https://owner.github.io/publish/',
    npmPackageName: 'link-status-page', npmVersion: '0.0.103', sha256: 'e'.repeat(64),
    enabledPlatforms: { github: true, cloudflare: false, npm: true, notion: false }
  }, { github: { status: 'succeeded' }, npm: previousNpm }, {
    deployNpm: async (_input, options) => {
      resumed = options.previousNpm;
      await options.onNpmAccepted({ ...previousNpm, accepted_at: '2026-09-25T10:00:00.000Z' });
      return { package: 'link-status-page', version: '0.0.103' };
    }
  });
  assert.equal(resumed, previousNpm);
  assert.equal(result.npm.status, 'succeeded');
});

test('npm OIDC 工作流失败时直接显示 Trusted Publisher 错误，不再误报 CDN 404', async () => {
  await assert.rejects(() => deployNpmPackage({
    npmPackageName: 'link-status-page', npmVersion: '0.0.100', sha256: 'a'.repeat(64)
  }, {
    inspectNpmRegistry: async () => null,
    triggerNpm: async () => ({ trigger_commit_sha: 'trigger' }),
    waitForNpmWorkflow: async () => { throw Object.assign(new Error('npm GitHub Actions 发布失败，请检查 Trusted Publisher'), { retryable: false }); }
  }), error => error.retryable === false && /Trusted Publisher/.test(error.message));
});

test('GitHub Actions 失败会返回准确的 npm Trusted Publisher 提示', async () => {
  await assert.rejects(() => waitForNpmWorkflow({
    githubRepo: 'owner/repository', githubWorkflowFile: 'publish-npm.yml', credentials: { githubToken: 'secret' }
  }, 'commit-sha', {
    npmWorkflowAttempts: 1,
    fetchImpl: async () => new Response(JSON.stringify({ workflow_runs: [{ id: 42, head_sha: 'commit-sha', status: 'completed', conclusion: 'failure', html_url: 'https://github.test/run/42' }] }), { status: 200 })
  }), error => error.retryable === false && /Trusted Publisher/.test(error.message) && /run\/42/.test(error.message));
});

test('npm 包分发线路不会被误判为网页入口，npmmirror 不参与网页校验', async () => {
  const npmmirror = await verifyNpmCdnLine({ provider: 'npmmirror', label: '中国大陆 npm 镜像', page_entry: false, url: 'https://registry.npmmirror.com/link-status-page/0.0.99/files/index.html' }, 'a'.repeat(64));
  assert.equal(npmmirror.status, 'package_mirror');

  const jsdelivr = await verifyNpmCdnLine({ provider: 'jsdelivr', label: '静态文件分发', page_entry: false, url: 'https://cdn.jsdelivr.net/npm/link-status-page@0.0.99/index.html' }, 'a'.repeat(64), {
    verify: async () => ({ manifest_url: 'https://cdn.jsdelivr.net/npm/link-status-page@0.0.99/publish-manifest.json' }),
    fetchImpl: async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/plain' } })
  });
  assert.equal(jsdelivr.status, 'package_available');
});
