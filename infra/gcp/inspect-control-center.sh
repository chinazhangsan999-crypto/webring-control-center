#!/usr/bin/env bash
set -euo pipefail

app_dir=/opt/webring-control-center/app
secret_dir=/opt/webring-control-center/secrets
cd "$app_dir"

echo "service=$(systemctl is-active control-center.service)"
echo "caddy=$(systemctl is-active caddy)"
echo "ready=$(curl -fsS http://127.0.0.1:3100/api/ready)"
sudo docker compose --env-file "$secret_dir/postgres.env" -f compose.yaml -f compose.production.yaml \
  exec -T postgres psql -U control_center -d control_center -Atc \
  "SELECT s.status||'|'||COALESCE(s.agent_version,'')||'|'||COALESCE(s.applied_revision,'')||'|'||COALESCE(to_char(s.last_seen_at,'YYYY-MM-DD HH24:MI:SS'),'')||'|'||r.nodes_revision||'|'||(SELECT count(*) FROM nodes)||'|'||(SELECT count(*) FROM ads) FROM sites s JOIN site_revisions r ON r.site_id=s.id WHERE s.id=1;"
