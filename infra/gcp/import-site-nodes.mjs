import fs from 'node:fs/promises';
import ControlService from '../../src/services/controlService.js';
import database from '../../src/db.js';

const [source, rawSiteId] = process.argv.slice(2);
const siteId = Number(rawSiteId);
if (!source || !Number.isSafeInteger(siteId) || siteId <= 0) {
  throw new Error('用法：node import-site-nodes.mjs <nodes.json> <site-id>');
}

const nodes = JSON.parse(await fs.readFile(source, 'utf8'));
if (!Array.isArray(nodes)) throw new Error('节点文件格式不正确');

try {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    await ControlService.saveNode(null, {
      speed_name: node.speed_name,
      partner_name: node.partner_name,
      url: node.url,
      enabled: Number(node.status) === 1,
      sort_order: nodes.length - index,
      scope_mode: 'selected',
      site_ids: [siteId],
      group_ids: []
    }, { type: 'system', id: 'initial-node-import' }, '127.0.0.1');
  }
  console.log(JSON.stringify({ imported: nodes.length, site_id: siteId }));
} finally {
  await database.pool.end();
}
