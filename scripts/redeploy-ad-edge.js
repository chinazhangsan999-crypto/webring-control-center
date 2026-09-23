'use strict';

const { query, pool } = require('../src/db');
const AdEdgeService = require('../src/services/adEdgeService');

async function main() {
  const { rows } = await query('SELECT id,hostname,worker_name FROM ad_edge_profiles WHERE enabled=TRUE ORDER BY id');
  const results = [];
  for (const profile of rows) {
    try {
      const deployed = await AdEdgeService.deployProfile(profile.id);
      results.push({ id: profile.id, hostname: profile.hostname, worker: profile.worker_name, ok: true, health: deployed.health_status });
    } catch (error) {
      results.push({ id: profile.id, hostname: profile.hostname, worker: profile.worker_name, ok: false, error: String(error.message || error) });
    }
  }
  console.log(JSON.stringify({ total: results.length, succeeded: results.filter(item => item.ok).length, results }));
  if (results.some(item => !item.ok)) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => pool.end());
