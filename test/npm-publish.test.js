'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePackageName, npmVersionForJob, npmPageUrl, npmPackageFiles, npmWorkflow } = require('../src/services/npmPublishService');
const { deployDualPlatform, triggerNpmPublish } = require('../src/services/publishDeploymentService');

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
  assert.equal(files['.github/workflows/publish-npm.yml'], undefined);
  assert.match(npmWorkflow(), /id-token: write/);
  assert.match(npmWorkflow(), /npm publish --access public/);
  assert.match(npmWorkflow(), /repository_dispatch/);
  assert.match(npmWorkflow(), /github\.event\.client_payload\.publish_ref/);
});

test('npm 工作流固定安装到默认分支并通过仓库事件检出发布分支', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method, body });
    if (method === 'GET' && /\/repos\/owner\/publish$/.test(url)) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    if (method === 'GET' && /contents\/.github\/workflows\/publish-npm\.yml/.test(url)) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    if (method === 'PUT' && /contents\/.github\/workflows\/publish-npm\.yml/.test(url)) return new Response(JSON.stringify({ content: { sha: 'workflow' } }), { status: 201 });
    if (method === 'POST' && /\/dispatches$/.test(url)) return new Response(null, { status: 204 });
    throw new Error(`未覆盖请求：${method} ${url}`);
  };
  const result = await triggerNpmPublish({
    githubRepo: 'owner/publish', npmVersion: '0.0.33', sha256: 'f'.repeat(64),
    credentials: { githubToken: 'secret', githubBranch: 'gh-pages' }
  }, { fetchImpl, wait: async () => {} });
  assert.equal(result.workflow_branch, 'main');
  assert.equal(result.publish_ref, 'gh-pages');
  assert.equal(result.workflow_updated, true);
  const dispatch = calls.find(call => call.method === 'POST' && /\/dispatches$/.test(call.url));
  assert.deepEqual(dispatch.body, { event_type: 'publish-npm-landing-page', client_payload: { publish_ref: 'gh-pages', version: '0.0.33', sha256: 'f'.repeat(64) } });
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
