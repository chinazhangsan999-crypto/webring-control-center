'use strict';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadStoredPublishBuild } = require('../src/services/jobWorker');

test('重试只复用摘要一致的已保存发布包', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-snapshot-'));
  const sha256 = 'a'.repeat(64);
  const build = {
    files: ['index.html', 'publish-manifest.json'],
    manifest: { sha256 },
    npm_version: '0.0.99'
  };
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html>');
    await fs.writeFile(path.join(directory, 'publish-manifest.json'), JSON.stringify({ sha256 }));
    await fs.writeFile(path.join(directory, '.publish-build.json'), JSON.stringify(build));
    const stored = await loadStoredPublishBuild(directory);
    assert.equal(stored.manifest.sha256, sha256);
    assert.equal(stored.npm_version, '0.0.99');
    assert.equal(stored.output, path.join(directory, 'index.html'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
