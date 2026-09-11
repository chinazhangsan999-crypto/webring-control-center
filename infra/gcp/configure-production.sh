#!/usr/bin/env bash
set -euo pipefail

app_root=/opt/webring-control-center
app_dir=${app_root}/app
secret_dir=${app_root}/secrets

test -f /tmp/control-center.env
test -f /tmp/compose.production.yaml
test -f /tmp/control-center.service
test -f /tmp/Caddyfile

if grep -Eq '=(请填写|change-)' /tmp/control-center.env; then
  echo 'Production configuration still contains placeholders' >&2
  exit 2
fi

db_password="$(openssl rand -hex 32)"
awk -v password="${db_password}" '
  /^DATABASE_URL=/ {
    print "DATABASE_URL=postgres://control_center:" password "@127.0.0.1:5432/control_center"
    next
  }
  { print }
' /tmp/control-center.env >"${secret_dir}/control-center.env"
printf 'POSTGRES_PASSWORD=%s\n' "${db_password}" >"${secret_dir}/postgres.env"
unset db_password

install -m 0640 /tmp/compose.production.yaml "${app_dir}/compose.production.yaml"
install -m 0644 /tmp/control-center.service /etc/systemd/system/control-center.service
install -d -m 0755 /etc/caddy
install -m 0644 /tmp/Caddyfile /etc/caddy/Caddyfile.pending

chown -R webring:webring "${app_root}"
chmod 0700 "${secret_dir}"
chmod 0600 "${secret_dir}/control-center.env" "${secret_dir}/postgres.env"
install -d -o webring -g webring -m 0750 "${app_root}/var/wrangler"
install -d -o webring -g webring -m 0750 "${app_dir}/var"
install -d -o webring -g webring -m 0750 "${app_dir}/.wrangler/tmp"
install -d -o webring -g webring -m 0750 "${app_dir}/node_modules/.cache/wrangler"

docker compose \
  --env-file "${secret_dir}/postgres.env" \
  -f "${app_dir}/compose.yaml" \
  -f "${app_dir}/compose.production.yaml" \
  up -d postgres

for _ in $(seq 1 30); do
  if docker compose \
    --env-file "${secret_dir}/postgres.env" \
    -f "${app_dir}/compose.yaml" \
    -f "${app_dir}/compose.production.yaml" \
    exec -T postgres pg_isready -U control_center -d control_center >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

docker compose \
  --env-file "${secret_dir}/postgres.env" \
  -f "${app_dir}/compose.yaml" \
  -f "${app_dir}/compose.production.yaml" \
  exec -T postgres pg_isready -U control_center -d control_center >/dev/null

systemctl daemon-reload
systemctl enable --now control-center.service

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3100/api/ready >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -fsS http://127.0.0.1:3100/api/ready >/dev/null

rm -f \
  /tmp/control-center.env \
  /tmp/compose.production.yaml \
  /tmp/control-center.service

echo 'PRODUCTION_APP_READY'
