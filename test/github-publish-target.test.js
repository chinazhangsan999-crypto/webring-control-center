'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { githubPublishTarget, repositoryNameFromFull } = require('../src/services/githubPublishTargetService');

test('仓库名自动生成完整仓库和项目 Pages 地址', () => {
  assert.deepEqual(githubPublishTarget('chinazhangsan999-crypto', 'xiaoxingxing-publish'), {
    owner: 'chinazhangsan999-crypto',
    repository: 'xiaoxingxing-publish',
    fullRepository: 'chinazhangsan999-crypto/xiaoxingxing-publish',
    pagesUrl: 'https://chinazhangsan999-crypto.github.io/xiaoxingxing-publish/'
  });
});

test('用户主页仓库不重复添加仓库路径', () => {
  const target = githubPublishTarget('OctoCat', 'octocat.github.io');
  assert.equal(target.pagesUrl, 'https://octocat.github.io/');
});

test('旧完整仓库可以迁移出仓库名，并拒绝带斜线的新输入', () => {
  assert.equal(repositoryNameFromFull('owner/repository'), 'repository');
  assert.equal(repositoryNameFromFull('repository'), '');
  assert.throws(() => githubPublishTarget('owner', 'owner/repository'), /GitHub 仓库名/);
});
