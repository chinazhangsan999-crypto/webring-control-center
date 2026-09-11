#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

timedatectl set-timezone Asia/Shanghai

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  docker-compose-v2 \
  docker.io \
  fail2ban \
  git \
  unattended-upgrades

curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource-setup.sh
bash /tmp/nodesource-setup.sh
apt-get install -y --no-install-recommends nodejs
rm -f /tmp/nodesource-setup.sh

systemctl enable --now docker
systemctl enable --now fail2ban

install -d -m 0750 /opt/webring-control-center
install -d -m 0700 /opt/webring-control-center/secrets
install -d -m 0750 /opt/webring-control-center/backups

cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
JSON

systemctl restart docker
docker version >/var/log/webring-control-center-bootstrap.log 2>&1
docker compose version >>/var/log/webring-control-center-bootstrap.log 2>&1
touch /var/lib/webring-control-center-bootstrap-complete
