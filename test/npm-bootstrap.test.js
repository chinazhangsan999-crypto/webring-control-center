'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const {
  bootstrapNpmPackage,
  trustedPublisherInstructions
} = require('../src/services/npmBootstrapService');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-bootstrap-test-'));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'brand-new-page', version: '0.0.41', repository: { type: 'git', url: 'git+https://github.com/owner/repository.git' }
  }));
  await fs.writeFile(path.join(directory, 'publish-manifest.json'), JSON.stringify({ sha256: 'a'.repeat(64) }));
  return directory;
}

test('首次 npm 发布只把短效 Token 交给子进程环境且关闭 provenance', async t => {
  const directory = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let processInput;
  const result = await bootstrapNpmPackage({
    token: 'npm_short_lived_secret_token',
    expectedUsername: 'publisher',
    registry: 'https://registry.npmjs.org',
    packageName: 'brand-new-page',
    version: '0.0.41',
    expectedSha256: 'a'.repeat(64),
    directory,
    githubRepo: 'owner/repository',
    workflowFile: 'publish-npm.yml'
  }, {
    inspectPackage: async () => ({ exists: false }),
    verifyIdentity: async () => 'publisher',
    runProcess: async input => { processInput = input; return { stdout: 'published', stderr: '' }; },
    verifyRegistryVersion: async () => true,
    verifyManifest: async () => ({ verified: true, manifest_url: 'https://unpkg.test/manifest.json' })
  });

  assert.equal(result.status, 'published');
  assert.equal(processInput.env.NODE_AUTH_TOKEN, 'npm_short_lived_secret_token');
  assert.equal(processInput.args.includes('--provenance=false'), true);
  assert.equal(processInput.args.join(' ').includes('npm_short_lived_secret_token'), false);
  assert.equal(JSON.stringify(result).includes('npm_short_lived_secret_token'), false);
});

test('首次 npm 发布拒绝覆盖已经存在的其他版本包', async t => {
  const directory = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(() => bootstrapNpmPackage({
    token: 'npm_short_lived_secret_token', expectedUsername: 'publisher', registry: 'https://registry.npmjs.org',
    packageName: 'brand-new-page', version: '0.0.41', expectedSha256: 'a'.repeat(64), directory,
    githubRepo: 'owner/repository', workflowFile: 'publish-npm.yml'
  }, {
    inspectPackage: async () => ({ exists: true, exactVersionExists: false })
  }), /已经存在，不属于首次发布/);
});

test('Trusted Publisher 指引固定给出仓库、工作流和直接发布权限', () => {
  const guide = trustedPublisherInstructions('brand-new-page', 'owner/repository', 'publish-npm.yml');
  assert.equal(guide.organization, 'owner');
  assert.equal(guide.repository, 'repository');
  assert.equal(guide.workflow_file, 'publish-npm.yml');
  assert.equal(guide.environment, '留空');
  assert.equal(guide.allowed_action, 'npm publish');
  assert.match(guide.package_settings_url, /npmjs\.com\/package\/brand-new-page\/access/);
});
