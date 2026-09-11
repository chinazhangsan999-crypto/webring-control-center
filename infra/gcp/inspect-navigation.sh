#!/usr/bin/env bash
set -euo pipefail

app_dir=/home/niaiwo/app
cd "$app_dir"

echo "app_dir=$app_dir"
echo "git_commit=$(git rev-parse --short HEAD 2>/dev/null || echo unavailable)"
echo "git_branch=$(git branch --show-current 2>/dev/null || echo unavailable)"
if pm2 describe webring 2>/dev/null | grep -q 'online'; then
  echo 'pm2_status=online'
else
  echo 'pm2_status=missing_or_offline'
fi
echo "caddy_status=$(systemctl is-active caddy 2>/dev/null || true)"
echo "node_version=$(node --version)"

pm2 jlist > /tmp/webring-pm2.json
node <<'NODE'
const fs = require('fs');
const processes = JSON.parse(fs.readFileSync('/tmp/webring-pm2.json', 'utf8'));
const item = processes.find(entry => entry.name === 'webring');
const env = item?.pm2_env || {};
console.log(`pm2_script=${env.pm_exec_path || 'missing'}`);
console.log(`pm2_cwd=${env.pm_cwd || 'missing'}`);
console.log(`pm2_mode=${env.exec_mode || 'missing'}`);
for (const key of ['NODE_ENV','ADMIN_JWT_SECRET','SESSION_SECRET','GUEST_JWT_SECRET','CONTROL_CENTER_ENABLED','CONTROL_CENTER_URL','CONTROL_CENTER_SITE_CREDENTIAL']) {
  console.log(`env_${key}=${env[key] ? 'present' : 'missing'}`);
}
NODE
rm -f /tmp/webring-pm2.json

node <<'NODE'
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('webring.db');
const queries = {
  mirrors: 'SELECT COUNT(*) AS count FROM mirrors',
  ads: 'SELECT COUNT(*) AS count FROM ads',
  enabled_mirrors: 'SELECT COUNT(*) AS count FROM mirrors WHERE status=1',
  enabled_ads: 'SELECT COUNT(*) AS count FROM ads WHERE status=1',
  central_mirrors: "SELECT COUNT(*) AS count FROM mirrors WHERE managed_by='central'",
  local_mirrors: "SELECT COUNT(*) AS count FROM mirrors WHERE managed_by<>'central'",
  central_ads: "SELECT COUNT(*) AS count FROM ads WHERE managed_by='central'",
  local_ads: "SELECT COUNT(*) AS count FROM ads WHERE managed_by<>'central'"
};
let pending = Object.keys(queries).length;
for (const [name, sql] of Object.entries(queries)) {
  db.get(sql, (error, row) => {
    console.log(`db_${name}=${error ? 'error' : Number(row.count)}`);
    if (--pending === 0) db.close();
  });
}
NODE
