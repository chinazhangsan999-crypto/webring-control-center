#!/usr/bin/env bash
set -euo pipefail

root=/opt/webring-control-center
app_dir=$root/app
release=/tmp/control-center-release.tgz
staging=/tmp/control-center-release-$(date +%s)
stamp=$(TZ=Asia/Shanghai date '+%Y%m%d-%H%M%S')
code_backup=$root/backups/code-$stamp.tgz
service_user=${CONTROL_CENTER_SERVICE_USER:-$(stat -c '%U' "$app_dir")}
service_group=${CONTROL_CENTER_SERVICE_GROUP:-$(stat -c '%G' "$app_dir")}

test -f "$release"
mkdir -p "$staging" "$root/backups"
tar -xzf "$release" -C "$staging"
cd "$staging"
npm ci --no-audit --no-fund
npm run test:local

cd "$app_dir"
tar -czf "$code_backup" package.json package-lock.json compose.yaml assets public src packages scripts infra test 2>/dev/null || true

rollback() {
  echo 'CONTROL_CENTER_DEPLOYMENT_FAILED_ROLLING_BACK' >&2
  tar -xzf "$code_backup" -C "$app_dir" || true
  chown -R "$service_user:$service_group" "$app_dir"
  systemctl restart control-center.service || true
}
trap rollback ERR

for directory in assets public src packages scripts infra test; do
  rsync -a --delete "$staging/$directory/" "$app_dir/$directory/"
done
install -m 644 "$staging/package.json" "$app_dir/package.json"
install -m 644 "$staging/package-lock.json" "$app_dir/package-lock.json"
install -m 644 "$staging/compose.yaml" "$app_dir/compose.yaml"
chown -R "$service_user:$service_group" "$app_dir"
cd "$app_dir"
sudo -u "$service_user" npm ci --no-audit --no-fund
install -d -o "$service_user" -g "$service_group" -m 700 \
  "$app_dir/var" \
  "$app_dir/.wrangler" \
  "$app_dir/node_modules/.cache/wrangler" \
  "$root/var" \
  "$root/var/wrangler" \
  "$root/var/wrangler/.wrangler" \
  "$root/var/wrangler/cache"

sed -e "s/^User=.*/User=$service_user/" -e "s/^Group=.*/Group=$service_group/" \
  "$app_dir/infra/gcp/control-center.service" > /etc/systemd/system/control-center.service
chmod 644 /etc/systemd/system/control-center.service
install -m 755 "$app_dir/infra/gcp/control-center-backup" /usr/local/sbin/control-center-backup
install -m 644 "$app_dir/infra/gcp/control-center-backup.service" /etc/systemd/system/control-center-backup.service
install -m 644 "$app_dir/infra/gcp/control-center-backup.timer" /etc/systemd/system/control-center-backup.timer
systemctl daemon-reload
systemctl enable --now control-center-backup.timer
systemctl restart control-center.service

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3100/api/ready >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:3100/api/ready >/dev/null
systemctl start control-center-backup.service

trap - ERR
rm -rf "$staging"
rm -f "$release" /tmp/import-site-nodes.mjs /tmp/navigation-nodes.json
echo "CONTROL_CENTER_DEPLOYED code_backup=$code_backup"
