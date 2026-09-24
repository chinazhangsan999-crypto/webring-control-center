'use strict';

function normalizePart(value, label) {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(result)) throw new Error(`${label}仅支持字母、数字、点、横线和下划线`);
  return result;
}

function repositoryNameFromFull(value) {
  const parts = String(value || '').trim().split('/');
  return parts.length === 2 ? parts[1] : '';
}

function githubPublishTarget(ownerValue, repositoryValue) {
  const owner = normalizePart(ownerValue, 'GitHub 用户名或组织名');
  const repository = normalizePart(repositoryValue, 'GitHub 仓库名');
  const hostOwner = owner.toLowerCase();
  const userPageRepository = repository.toLowerCase() === `${hostOwner}.github.io`;
  return {
    owner,
    repository,
    fullRepository: `${owner}/${repository}`,
    pagesUrl: userPageRepository
      ? `https://${hostOwner}.github.io/`
      : `https://${hostOwner}.github.io/${repository}/`
  };
}

module.exports = { githubPublishTarget, repositoryNameFromFull };
