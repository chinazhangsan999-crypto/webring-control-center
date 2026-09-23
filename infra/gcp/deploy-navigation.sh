#!/usr/bin/env bash
set -euo pipefail

app_dir=/home/niaiwo/app
release=/tmp/webring-release.tgz
credential=/tmp/xiaoxingxing-site.env
config_dir=/home/niaiwo/.config/webring
backup_dir=/home/niaiwo/backups/deployments
stamp=$(TZ=Asia/Shanghai date '+%Y%m%d-%H%M%S')
staging=/tmp/webring-release-$stamp
code_backup=$backup_dir/code-$stamp.tgz
db_backup=$backup_dir/webring-$stamp.db

test -f "$release"
control_env="$config_dir/control-center.env"
if [ ! -f "$credential" ] && [ ! -f "$control_env" ]; then
  echo '缺少站点接入凭据，且服务器上没有可复用的总后台配置' >&2
  exit 1
fi
mkdir -p "$staging" "$backup_dir" "$config_dir"
chmod 700 "$backup_dir" "$config_dir"
tar -xzf "$release" -C "$staging"
cd "$staging"
npm ci --omit=dev --no-audit --no-fund
node --check server.js
node --check src/services/ControlCenterAgentService.js
node --test test/control-center-site.test.js

cd "$app_dir"
tar -czf "$code_backup" server.js package.json package-lock.json public src scripts ops 2>/dev/null || true
node "$staging/scripts/backup-sqlite.js" "$app_dir/webring.db" "$db_backup" >/dev/null

rollback() {
  echo 'DEPLOYMENT_FAILED_ROLLING_BACK' >&2
  tar -xzf "$code_backup" -C "$app_dir" || true
  set -a
  . "$config_dir/production.env"
  set +a
  export CONTROL_CENTER_ENABLED=0
  pm2 restart webring --update-env || true
}
trap rollback ERR

rsync -a --delete "$staging/src/" "$app_dir/src/"
rsync -a --delete "$staging/packages/" "$app_dir/packages/"
rsync -a --delete "$staging/scripts/" "$app_dir/scripts/"
rsync -a --delete "$staging/ops/" "$app_dir/ops/"
rsync -a --delete --exclude 'uploads/' "$staging/public/" "$app_dir/public/"
install -m 644 "$staging/server.js" "$app_dir/server.js"
install -m 644 "$staging/package.json" "$app_dir/package.json"
install -m 644 "$staging/package-lock.json" "$app_dir/package-lock.json"

cd "$app_dir"
npm ci --omit=dev --no-audit --no-fund

if [ -f "$credential" ]; then
  {
    echo 'CONTROL_CENTER_ENABLED=1'
    echo 'CONTROL_CENTER_URL=https://zonghoutai.chinazhangsan.ccwu.cc'
    cat "$credential"
    echo 'CONTROL_CENTER_SYNC_INTERVAL_MS=60000'
  } > "$control_env.tmp"
  chmod 600 "$control_env.tmp"
  mv "$control_env.tmp" "$control_env"
  rm -f "$credential"
fi

sudo install -m 755 "$app_dir/ops/webring-backup" /usr/local/sbin/webring-backup
sudo install -m 644 "$app_dir/ops/webring-backup.service" /etc/systemd/system/webring-backup.service
sudo install -m 644 "$app_dir/ops/webring-backup.timer" /etc/systemd/system/webring-backup.timer
sudo install -m 755 "$app_dir/ops/webring-health-monitor" /usr/local/sbin/webring-health-monitor
sudo install -m 644 "$app_dir/ops/webring-health-monitor.service" /etc/systemd/system/webring-health-monitor.service
sudo install -m 644 "$app_dir/ops/webring-health-monitor.timer" /etc/systemd/system/webring-health-monitor.timer
sudo install -m 755 "$app_dir/ops/webring-disk-monitor" /usr/local/sbin/webring-disk-monitor
sudo install -m 644 "$app_dir/ops/webring-disk-monitor.service" /etc/systemd/system/webring-disk-monitor.service
sudo install -m 644 "$app_dir/ops/webring-disk-monitor.timer" /etc/systemd/system/webring-disk-monitor.timer
sudo systemctl daemon-reload
sudo systemctl enable --now webring-backup.timer webring-health-monitor.timer webring-disk-monitor.timer

set -a
. "$config_dir/production.env"
. "$control_env"
set +a
pm2 restart webring --update-env
pm2 save

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:3001/api/health >/dev/null
grep -q '^CONTROL_CENTER_ENABLED=1$' "$control_env"
sudo systemctl start webring-backup.service
test -s "$db_backup"

trap - ERR
rm -rf "$staging"
rm -f "$release" /tmp/export-navigation-nodes.js /tmp/navigation-nodes.json
echo "NAVIGATION_DEPLOYED backup=$db_backup code_backup=$code_backup"
