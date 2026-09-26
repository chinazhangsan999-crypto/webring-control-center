# Webring Control Center

[中文文档](README.md)

The Control Center centrally manages site identities, heartbeats, SSO, configuration, advertising, and permanent publication pages for multiple navigation sites. It does not replace each site's local database; it controls only explicitly synchronized central state and jobs.

> Tokens, passwords, site credentials, and encryption keys belong only in server environment files or the encrypted settings store, never Git.

## 1. Features

- Single super administrator, sessions, CSRF, password changes, and session revocation.
- Site registration, groups, heartbeats, status, configuration snapshots, and credential rotation.
- Short-lived, single-use site SSO tickets with audit history.
- Global/selected-node configuration and coordinated central/local advertising.
- Image/code creatives, placement policy, integrity, sandbox/direct modes, and dedicated ad Edge profiles.
- Permanent publishing through GitHub Pages, Cloudflare Pages, npm, and Notion.
- Persistent jobs, retries, cancellation, target verification, immutable audit, and failure alerting.
- Global or site-level platform accounts; secrets encrypted with `SETTINGS_ENCRYPTION_KEY`.
- Telegram-first alerts with Bark only after final Telegram failure.

## 2. Placement

Run Control Center with IP Intelligence on server B:

| Service | Local listener | Public hostname |
|---|---|---|
| Control Center | `127.0.0.1:3100` | `control.example.com` |
| IP Intelligence | `127.0.0.1:3101` | `ip.example.com` |
| PostgreSQL | `127.0.0.1:5432` | never public |
| Routinator, optional | `127.0.0.1:8323` | never public |

Use one PostgreSQL instance but separate users and databases. Run one host Caddy; do not start the IP repository's full Caddy Compose unchanged because both would claim 80/443.

## 3. Clean-host installation

### 3.1 Packages

```bash
sudo apt update
sudo apt install -y ca-certificates curl git build-essential postgresql
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo useradd --system --create-home --home-dir /opt/apps --shell /usr/sbin/nologin apps
sudo mkdir -p /opt/webring-control-center /etc/webring-control-center /var/lib/webring-control-center
sudo chown -R apps:apps /opt/webring-control-center /var/lib/webring-control-center
sudo chmod 750 /etc/webring-control-center
```

Install Caddy 2 and manage Control plus IP in one `/etc/caddy/Caddyfile`.

### 3.2 Empty database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER control_center WITH ENCRYPTED PASSWORD 'REPLACE_WITH_RANDOM_DATABASE_PASSWORD';
CREATE DATABASE control_center OWNER control_center;
REVOKE ALL ON DATABASE control_center FROM PUBLIC;
SQL
```

Generate the database password. The control user must not own the IP database or have PostgreSQL superuser rights.

### 3.3 Clone and install

```bash
sudo -u apps git clone https://github.com/zhangsan4188/webring-control-center.git /opt/webring-control-center
cd /opt/webring-control-center
sudo -u apps npm ci --omit=dev
```

Mirror: `https://github.com/chinazhangsan999-crypto/webring-control-center.git`. A production Deploy Key needs `Contents: Read` only.

### 3.4 Environment

The requested bootstrap credentials are `admin` / `admin123`. Current source accepts 8–200 character passwords. Replace it immediately after first login.

```bash
openssl rand -hex 32  # SETTINGS_ENCRYPTION_KEY
```

Create `/etc/webring-control-center/control.env`:

```dotenv
NODE_ENV=production
PORT=3100
HOST=127.0.0.1
DATABASE_URL=postgres://control_center:<database-password>@127.0.0.1:5432/control_center
DATABASE_SSL=0
TRUST_PROXY=loopback
SESSION_COOKIE_NAME=cc_session
SESSION_TTL_HOURS=8
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=admin123
CONTROL_CENTER_PUBLIC_URL=https://control.example.com
SSO_TICKET_TTL_SECONDS=60
SETTINGS_ENCRYPTION_KEY=<64-hex-character-random-value>
PUBLISH_GITHUB_TOKEN=
PUBLISH_GITHUB_BRANCH=gh-pages
PUBLISH_CLOUDFLARE_API_TOKEN=
PUBLISH_CLOUDFLARE_ACCOUNT_ID=
PUBLISH_CLOUDFLARE_BRANCH=main
PUBLISH_WRANGLER_STATE_DIR=/var/lib/webring-control-center/wrangler
ALERT_SITE_NAME=Webring Control
ALERT_TELEGRAM_BOT_TOKEN=
ALERT_TELEGRAM_CHAT_ID=
ALERT_BARK_URL=
ALERT_TIMEOUT_MS=8000
ALERT_RETRY_DELAY_MS=1500
```

```bash
sudo chown root:apps /etc/webring-control-center/control.env
sudo chmod 640 /etc/webring-control-center/control.env
sudo -u apps mkdir -p /var/lib/webring-control-center/wrangler
```

The settings key decrypts stored platform credentials. Preserve it separately; losing it leaves unusable ciphertext.

### 3.5 systemd

```ini
[Unit]
Description=Webring Control Center
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=apps
Group=apps
WorkingDirectory=/opt/webring-control-center
EnvironmentFile=/etc/webring-control-center/control.env
ExecStartPre=/usr/bin/npm run migrate
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/webring-control-center /var/lib/webring-control-center

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webring-control-center
curl -fsS http://127.0.0.1:3100/api/ready
```

Migrations initialize an empty database and create `admin/admin123`; existing administrators are not overwritten.

### 3.6 Shared server-B Caddy

```caddyfile
control.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3100
}

ip.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3101
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -fsS https://control.example.com/api/ready
```

With Cloudflare proxying, use Full (strict), a valid origin certificate, and a correct trusted-proxy policy. Do not mistake visitor-controlled forwarding headers for an admin source restriction.

## 4. Third-party accounts and exact permissions

### 4.1 GitHub publishing identity

Pre-create repositories and use a fine-grained PAT limited to them:

- `Contents: Read and write` for generated pages, manifests, and workflow files.
- `Workflows: Read and write` for `.github/workflows/publish-npm.yml`.
- `Pages: Read and write` for Pages provisioning/status.
- `Actions: Read` for workflow-run verification; add write only if future code triggers/cancels runs.
- `Metadata: Read` is normally automatic.
- `Administration: Read and write` only if the application must change repository settings or enable Pages. Prefer manual pre-configuration.

Automatic `POST /user/repos` creation needs repository-creation authority and can conflict with fine-grained resource selection. Pre-creation is the least-privilege path. Avoid a broad classic `repo` token unless fine-grained tokens cannot satisfy the workflow.

No Issues, Pull requests, Codespaces, Secrets, or organization administration permission is required.

### 4.2 Cloudflare Pages

Use a dedicated token with Account `Cloudflare Pages: Edit`. Add selected-Zone `Zone: Read` and `DNS: Edit` only when the service binds custom domains/DNS. Restrict resources to the exact account/zones and do not reuse Navigation Worker/DNS tokens.

### 4.3 npm bootstrap and Trusted Publisher

For the first package version, use a short-lived npm Granular Access Token limited to the package/scope with `Read and write`. Apply the shortest expiry and optional server-IP restriction. Enable publish-time 2FA bypass only if npm requires it for this bootstrap token; revoke it immediately after success.

Then configure npm package Settings → Trusted Publisher:

- GitHub Actions provider.
- Exact owner, repository, and `publish-npm.yml` workflow filename.
- Environment only when the workflow uses that same GitHub Environment.

The workflow needs `permissions: id-token: write` and `contents: read`. OIDC removes the long-lived `NPM_TOKEN`. Registry propagation delays must be reconciled using exact package/version/manifest; never blindly republish the same version.

### 4.4 Notion

Create an Internal Integration, save its secret, and explicitly Share the target page with it. Minimum capabilities are `Read content` plus `Update content`/`Insert content`. User, comment, and workspace administration permissions are unnecessary. A correct token still gets 404/no access if the page was not shared.

### 4.5 Telegram and Bark

Use a dedicated Bot Token and Chat ID with send-only capability. Bark URL/Device Key is fallback after final Telegram failure. Do not reuse the risk or backup bot.

## 5. Navigation enrollment

1. Create a site with public URL and group.
2. Generate a site credential; plaintext is displayed once.
3. Enter the control HTTPS origin and credential in Navigation and verify/save.
4. Enable configuration/advertising synchronization only after a successful heartbeat.
5. SSO tickets default to 60 seconds and one use; issue a new ticket rather than extending one.

Each site has a unique credential. Rotation stops heartbeats until the site is updated but does not delete local site data.

## 6. Advertising and publishing cautions

- Keep `central_only` positions central-only to prevent duplicate central/local ads.
- Route third-party code through the isolated ad Edge with origin/signature checks; do not inject arbitrary code into the navigation document.
- Target-platform verification, not just process exit, determines job success.
- One platform's failure must not rewrite another platform's successful history.
- Before retrying, verify immutable package/version/manifest SHA and repository identity.

## 7. Backup and update

```bash
sudo -u postgres pg_dump -Fc control_center > /secure-backups/control-center-$(date +%F-%H%M).dump
cd /opt/webring-control-center
sudo -u apps git fetch --all --prune
sudo -u apps git pull --ff-only
sudo -u apps npm ci --omit=dev
sudo -u apps npm run check
sudo -u apps npm test
sudo systemctl restart webring-control-center
curl -fsS http://127.0.0.1:3100/api/ready
```

Preserve the database, environment, and current commit before upgrade. Migrations are forward operations; confirm database compatibility before code rollback. Encrypt and restore-test backups.

## 8. Acceptance checklist

- `/api/ready` reports app and database ready; port 3100 is not public.
- `admin/admin123` works once, then is changed and prior sessions are invalid.
- Test site creation, credential rotation, heartbeat, snapshot, and one-time SSO work.
- Image/code ads follow placement policy without central/local duplication.
- GitHub Pages, Cloudflare Pages, npm OIDC, and Notion each complete a test publish and readback.
- Bark is silent on Telegram success and fires once under simulated final failure.
- Logs, jobs, API responses, and Git contain no third-party token or plaintext site credential.

## 9. Troubleshooting

- **Initial password required:** an empty database requires `INITIAL_ADMIN_PASSWORD`, minimum 8 characters; existing admins are not overwritten.
- **Site offline:** inspect credential rotation, server clocks, URL, and proxy before recreating a site.
- **GitHub 403:** map the failed endpoint to `Contents`, `Workflows`, `Pages`, or `Administration`; do not jump to a full-access token.
- **npm 409:** query whether the exact package/version already propagated. An accepted version cannot be republished.
- **Notion 404:** verify page sharing, Page ID, and capabilities.
- **Cloudflare Pages failure:** verify Account ID, Pages Edit, resource scope, and whether DNS Edit is actually needed.

## 10. Security invariants

- Never commit the settings key, database password, PAT, npm token, Notion secret, or bot token.
- `admin/admin123` is bootstrap-only and must change immediately.
- Split platform tokens by account/site/purpose; track expiry and rotation ownership.
- PostgreSQL stays private; Control Center is available only through Caddy HTTPS.
- Site credentials and SSO tickets are non-reusable; logs show fingerprints only.

## 11. Licensing

GitHub, Cloudflare, npm, and Notion publishing remains subject to each platform's terms, naming rules, content license, and privacy requirements. Automation does not replace authorization review.

Official permission references: [GitHub fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens), [Cloudflare API-token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/), and [Notion authorization](https://developers.notion.com/docs/authorization).
