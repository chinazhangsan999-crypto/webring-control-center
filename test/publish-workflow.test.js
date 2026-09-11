'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  DeploymentError,
  deploymentCredentials,
  deployGithubPages,
  deployCloudflarePages,
  redactSecret,
  verifyPublishedManifest,
  deployDualPlatform
} = require('../src/services/publishDeploymentService');

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function bundleDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-workflow-'));
  const files = ['index.html', '404.html', '.nojekyll', '_headers', 'publish-manifest.json'];
  await Promise.all(files.map(name => fs.writeFile(path.join(directory, name), name === 'publish-manifest.json' ? '{"sha256":"abc"}' : name)));
  return { directory, files };
}

test('发布凭据只来自环境变量并提供稳定默认分支', () => {
  const credentials = deploymentCredentials({ PUBLISH_GITHUB_TOKEN: 'gh-secret', PUBLISH_CLOUDFLARE_API_TOKEN: 'cf-secret', PUBLISH_CLOUDFLARE_ACCOUNT_ID: 'account' });
  assert.equal(credentials.githubToken, 'gh-secret');
  assert.equal(credentials.githubBranch, 'gh-pages');
  assert.equal(credentials.cloudflareBranch, 'main');
  assert.equal(redactSecret('failed token-secret request', 'token-secret'), 'failed [REDACTED] request');
});

test('GitHub 工作流建立完整静态树并启用 Pages 分支', async () => {
  const bundle = await bundleDirectory();
  let blob = 0;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET' && /\/repos\/owner\/publish$/.test(url)) return jsonResponse({ default_branch: 'main' });
    if (method === 'GET' && /git\/ref\/heads\/gh-pages$/.test(url)) return jsonResponse({ message: 'Not Found' }, 404);
    if (method === 'GET' && /git\/ref\/heads\/main$/.test(url)) return jsonResponse({ object: { sha: 'parent' } });
    if (method === 'POST' && /git\/blobs$/.test(url)) return jsonResponse({ sha: `blob-${blob += 1}` }, 201);
    if (method === 'POST' && /git\/trees$/.test(url)) return jsonResponse({ sha: 'tree-sha' }, 201);
    if (method === 'POST' && /git\/commits$/.test(url)) return jsonResponse({ sha: 'commit-sha' }, 201);
    if (method === 'POST' && /git\/refs$/.test(url)) return jsonResponse({ ref: 'refs/heads/gh-pages' }, 201);
    if (method === 'GET' && /\/pages$/.test(url)) return jsonResponse({ message: 'Not Found' }, 404);
    if (method === 'POST' && /\/pages$/.test(url)) return jsonResponse({ status: 'built' }, 201);
    if (method === 'POST' && /\/pages\/builds$/.test(url)) return jsonResponse({ status: 'queued' }, 201);
    throw new Error(`未覆盖请求：${method} ${url}`);
  };
  const result = await deployGithubPages({ ...bundle, sha256: 'a'.repeat(64), githubRepo: 'owner/publish', githubPagesUrl: 'https://owner.github.io/publish/', credentials: { githubToken: 'secret', githubBranch: 'gh-pages' } }, { fetchImpl });
  assert.equal(result.commit_sha, 'commit-sha');
  const treeCall = calls.find(call => /git\/trees$/.test(call.url));
  assert.equal(treeCall.body.tree.length, 5);
  assert.ok(calls.some(call => call.method === 'POST' && /\/pages$/.test(call.url)));
});

test('Cloudflare 工作流确认项目和自定义域名后调用官方 Wrangler', async () => {
  const bundle = await bundleDirectory();
  const calls = [];
  let command = null;
  const fetchImpl = async url => {
    calls.push(String(url));
    if (/\/domains\//.test(url)) return jsonResponse({ success: true, result: { status: 'active' } });
    return jsonResponse({ success: true, result: { name: 'publish-project' } });
  };
  const execFileImpl = async (file, args, options) => {
    command = { file, args, options };
    return { stdout: 'Deployment complete! https://abc.publish-project.pages.dev', stderr: '' };
  };
  const result = await deployCloudflarePages({ directory: bundle.directory, sha256: 'b'.repeat(64), cloudflareProject: 'publish-project', permanentUrl: 'https://go.example.com/', credentials: { cloudflareToken: 'secret', cloudflareAccountId: 'account', cloudflareBranch: 'main' } }, { fetchImpl, execFileImpl });
  assert.equal(result.domain_status, 'active');
  assert.match(result.deployment_url, /pages\.dev/);
  assert.ok(command.args.includes('pages'));
  assert.ok(command.args.includes('deploy'));
  assert.equal(command.options.env.CLOUDFLARE_API_TOKEN, 'secret');
  assert.ok(calls.some(url => url.includes('/domains/go.example.com')));
});

test('双平台独立执行，失败平台不会阻止另一平台完成', async () => {
  const progressSnapshots = [];
  await assert.rejects(() => deployDualPlatform({ githubPagesUrl: 'https://owner.github.io/publish/', permanentUrl: 'https://go.example.com/', sha256: 'c'.repeat(64) }, {}, {
    deployGithub: async () => { throw new DeploymentError('GitHub 拒绝', { retryable: false }); },
    deployCloudflare: async () => ({ deployment_url: 'https://deploy.pages.dev' }),
    verify: async url => ({ verified: true, manifest_url: `${url}publish-manifest.json` }),
    onProgress: async progress => progressSnapshots.push(structuredClone(progress))
  }), error => {
    assert.equal(error.progress.github.status, 'failed');
    assert.equal(error.progress.cloudflare.status, 'succeeded');
    return true;
  });
  assert.equal(progressSnapshots.at(-1).cloudflare.status, 'succeeded');
});

test('任务重试只执行上次失败的平台', async () => {
  let githubCalls = 0;
  let cloudflareCalls = 0;
  const previous = { github: { status: 'succeeded', commit_sha: 'existing' }, cloudflare: { status: 'failed', error: 'timeout' } };
  const result = await deployDualPlatform({ githubPagesUrl: 'https://owner.github.io/publish/', permanentUrl: 'https://go.example.com/', sha256: 'd'.repeat(64) }, previous, {
    deployGithub: async () => { githubCalls += 1; },
    deployCloudflare: async () => { cloudflareCalls += 1; return { deployment_url: 'https://deploy.pages.dev' }; },
    verify: async () => ({ verified: true })
  });
  assert.equal(githubCalls, 0);
  assert.equal(cloudflareCalls, 1);
  assert.equal(result.github.commit_sha, 'existing');
  assert.equal(result.cloudflare.status, 'succeeded');
});

test('远端 manifest 摘要一致才通过发布后校验', async () => {
  let calls = 0;
  const result = await verifyPublishedManifest('https://go.example.com/', 'expected', {
    attempts: 2,
    intervalMs: 1,
    wait: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ sha256: calls === 1 ? 'old' : 'expected' });
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.verified, true);
});
