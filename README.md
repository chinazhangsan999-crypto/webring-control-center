# 星环控制中心（Webring Control Center）

[English documentation](README.en.md)

控制中心用于统一管理多个导航站的站点身份、心跳、SSO、配置、广告和永久发布页面。它不是导航站数据库的替代品：站点本地内容仍由站点自身管理，控制中心只管理明确同步的中央配置和任务。

> 所有 Token、密码、站点凭据和加密主密钥必须留在服务器环境文件或后台加密库中，不得提交到 Git。

## 1. 功能总览

- 单一超级管理员、Session、CSRF、密码变更和会话撤销。
- 多导航站登记、分组、心跳、在线状态、配置快照和凭据轮换。
- 一次性站点 SSO Ticket；短有效期并可审计。
- 全局/选定节点配置下发，中央广告与站点本地广告协作。
- 图片/代码广告、位置策略、代码完整性、沙箱/直连模式和独立广告 Edge Profile。
- 永久发布页：GitHub Pages、Cloudflare Pages、npm 和 Notion。
- 持久化发布任务、重试、取消、状态核验、不可变审计与失败告警。
- 全局或站点级平台账号；敏感字段由 `SETTINGS_ENCRYPTION_KEY` 加密。
- Telegram 主告警，Bark 只在 Telegram 最终失败时兜底。

## 2. 推荐部署位置

控制中心与 IP 情报部署在服务器 B：

| 服务 | 本机监听 | 公网域名 |
|---|---|---|
| 控制中心 | `127.0.0.1:3100` | `control.example.com` |
| IP 情报 | `127.0.0.1:3101` | `ip.example.com` |
| PostgreSQL | `127.0.0.1:5432` | 不公开 |
| Routinator（可选） | `127.0.0.1:8323` | 不公开 |

两套系统使用同一 PostgreSQL 实例但不同数据库和用户。Caddy 只运行一份；不要直接启动 IP 仓库中会占用 80/443 的完整 Caddy Compose。

## 3. 从空服务器安装

### 3.1 基础软件

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

安装 Caddy 2 后由同一 `/etc/caddy/Caddyfile` 管理控制中心与 IP 域名。

### 3.2 空数据库

```bash
sudo -u postgres psql <<'SQL'
CREATE USER control_center WITH ENCRYPTED PASSWORD 'REPLACE_WITH_RANDOM_DATABASE_PASSWORD';
CREATE DATABASE control_center OWNER control_center;
REVOKE ALL ON DATABASE control_center FROM PUBLIC;
SQL
```

用 `openssl rand -base64 36` 生成数据库密码。不要让控制中心数据库用户拥有 IP 数据库或 PostgreSQL 超级用户权限。

### 3.3 获取代码

```bash
sudo -u apps git clone https://github.com/zhangsan4188/webring-control-center.git /opt/webring-control-center
cd /opt/webring-control-center
sudo -u apps npm ci --omit=dev
```

镜像仓库为 `https://github.com/chinazhangsan999-crypto/webring-control-center.git`。生产 Deploy Key 只需 `Contents: Read`。

### 3.4 环境文件

首次约定账号为 `admin`，密码为 `admin123`；当前源码允许 8–200 位密码。此密码仅用于首次登录，登录后立即替换。

```bash
openssl rand -hex 32  # SETTINGS_ENCRYPTION_KEY
```

创建 `/etc/webring-control-center/control.env`：

```dotenv
NODE_ENV=production
PORT=3100
HOST=127.0.0.1
DATABASE_URL=postgres://control_center:<数据库密码>@127.0.0.1:5432/control_center
DATABASE_SSL=0
TRUST_PROXY=loopback
SESSION_COOKIE_NAME=cc_session
SESSION_TTL_HOURS=8
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=admin123
CONTROL_CENTER_PUBLIC_URL=https://control.example.com
SSO_TICKET_TTL_SECONDS=60
SETTINGS_ENCRYPTION_KEY=<64 位十六进制随机值>
PUBLISH_GITHUB_TOKEN=
PUBLISH_GITHUB_BRANCH=gh-pages
PUBLISH_CLOUDFLARE_API_TOKEN=
PUBLISH_CLOUDFLARE_ACCOUNT_ID=
PUBLISH_CLOUDFLARE_BRANCH=main
PUBLISH_WRANGLER_STATE_DIR=/var/lib/webring-control-center/wrangler
ALERT_SITE_NAME=星环总控
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

`SETTINGS_ENCRYPTION_KEY` 用于解密已保存的平台凭据，必须长期保留且单独备份。丢失它后，数据库仍在但密文无法使用。

### 3.5 迁移和首次管理员

由下一节 systemd 的 `ExecStartPre=/usr/bin/npm run migrate` 在受控环境中执行迁移。首次空库迁移创建 `admin/admin123`；已有管理员时不会覆盖。不要使用 `env $(cat .env)` 一类命令，因为它可能破坏包含特殊字符的密码并把敏感值暴露给进程检查或 shell 历史。

### 3.6 systemd

创建 `/etc/systemd/system/webring-control-center.service`：

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
sudo systemctl status webring-control-center --no-pager
curl -fsS http://127.0.0.1:3100/api/ready
```

### 3.7 服务器 B 的统一 Caddy

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

若域名经 Cloudflare 代理，使用 Full (strict)，并正确配置源站证书和可信代理；不要把后台来源限制误写成允许任意 `X-Forwarded-For`。

## 4. 第三方账号和精确权限

### 4.1 GitHub 发布账号

控制中心会创建/更新发布仓库内容、管理 Pages 并读取 Actions 运行状态。推荐预先创建仓库，然后使用 Fine-grained PAT：

- Repository access：只选发布仓库。
- `Contents: Read and write`：提交静态页面、manifest 和发布工作流。
- `Workflows: Read and write`：创建/更新 `.github/workflows/publish-npm.yml`。
- `Pages: Read and write`：创建、更新并读取 Pages 状态。
- `Actions: Read`：读取 workflow run；若未来需要手动触发/取消，再单独增加写权限。
- `Metadata: Read`：GitHub 自动要求。
- `Administration: Read and write` 只在代码必须修改仓库设置/启用 Pages 时授予；能预先人工启用就不要给。

如果启用“自动创建仓库”，`POST /user/repos` 需要账号级仓库创建能力；Fine-grained PAT 对新仓库创建存在资源选择限制。最小权限方案是人工预建仓库并选择它们。Classic PAT 的 `repo` 范围过大，只在无法使用 Fine-grained Token 且理解风险时使用。

Token 不需要 Issues、Pull requests、Codespaces、Secrets 或组织管理权限。

### 4.2 Cloudflare Pages

需要 Cloudflare Account ID 和专用 API Token：

- Account：`Cloudflare Pages: Edit`。
- Zone：`Zone: Read`、`DNS: Edit`（仅当系统自动绑定自定义域和 DNS）。
- 资源只选目标 Account 和目标 Zone。

不要复用导航站 Worker/DNS Token。若只发布 `*.pages.dev` 且不自动改 DNS，可不授予 Zone DNS Edit。

### 4.3 npm 首次发布与 Trusted Publisher

首次建立包需要 npm 账号、目标 package name，以及短期 Granular Access Token：

- Packages and scopes：只选择目标 package/scope；尚不存在时仅在首次引导窗口使用。
- Permissions：`Read and write`。
- 设置最短到期时间，可按服务器出口 IP 限制。
- 若 npm UI 要求发布时绕过 2FA，只对这枚短期引导 Token 启用；首次发布完成立即撤销。

首次版本成功后，在 npm 包 Settings → Trusted Publisher 绑定：

- Provider：GitHub Actions。
- Organization/User、Repository、Workflow filename：必须与发布仓库和 `publish-npm.yml` 完全一致。
- Environment：仅在 workflow 使用同名 GitHub Environment 时填写。

工作流必须包含 `permissions: id-token: write` 和 `contents: read`。之后使用 OIDC 发布，不再保存长期 `NPM_TOKEN`。Registry 暂时延迟时，控制中心会核验已接受的 package/version/manifest，不能盲目重复发布同一版本。

### 4.4 Notion

创建 Notion Internal Integration，保存 Internal Integration Secret，并把目标页面明确分享给该 Integration。

最小 capabilities：

- `Read content`：读取目标 page/block。
- `Update content` / `Insert content`：创建、更新或归档发布块。
- 不需要读取用户、评论或工作区管理权限。

后台填写 Token、Page ID/URL 和公开页面 URL。未把页面 Share 给 Integration 时，即使 Token 正确也会 404/无权限。

### 4.5 Telegram 与 Bark

- Telegram Bot Token + Chat ID，只授予向目标会话发消息。
- Bark URL/Device Key 作为 Telegram 最终失败后的兜底。
- 不复用风险中心或备份 Bot。

## 5. 导航站接入

1. 控制中心创建站点，填写站点名称、公开 URL 和分组。
2. 生成站点凭据；明文只显示一次，立即保存到对应导航站后台。
3. 导航站填写控制中心 HTTPS Origin、站点凭据并测试。
4. 首次心跳成功后再启用配置/广告同步。
5. SSO Ticket 有效期默认 60 秒，只能使用一次；失败时重新签发，不延长旧 Ticket。

每个站点使用独立凭据。轮换后必须尽快更新站点；旧凭据失效会造成心跳和同步停止，但不会自动删除站点本地数据。

## 6. 广告和发布注意事项

- 中央广告与本地广告的位置策略必须明确；`central_only` 不应被站点本地重复渲染。
- 第三方代码广告优先经独立广告 Edge，带 Origin/签名校验；不要直接把任意 HTML/JS 注入导航页面。
- 发布任务状态以目标平台核验为准，不以进程退出码单独判断成功。
- GitHub Pages、Cloudflare Pages、npm、Notion 任一平台失败不应篡改其他平台已成功历史。
- 重试前核对不可变的版本、包名、manifest SHA 和目标仓库，避免重复发布或覆盖错误站点。

## 7. 数据库、备份和更新

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

升级前保存数据库、环境文件和当前 commit。迁移为前向操作；回滚代码前确认数据库是否仍兼容。备份必须加密、离线复制并定期恢复演练。

## 8. 上线验收

- `api/ready` 显示应用和数据库正常，3100 不直接公网开放。
- 首次 `admin/admin123` 可登录，随后已更换密码，旧会话失效。
- 创建测试站点、轮换凭据、心跳、快照和一次性 SSO 正常。
- 图片广告与代码广告按位置策略显示，无中央/本地重复。
- GitHub Pages、Cloudflare Pages、npm OIDC、Notion 各自完成一次测试发布和状态回读。
- Telegram 成功时 Bark 不发送；模拟最终失败时 Bark 仅发送一次。
- 日志、任务明细、API 响应和 Git 中没有第三方 Token 或站点明文凭据。

## 9. 故障排查

- **首次启动要求密码**：空库必须设置 `INITIAL_ADMIN_PASSWORD`，当前最低 8 位；已有管理员不会被覆盖。
- **站点离线**：检查站点凭据是否轮换、站点时间、控制中心 URL 和反向代理；不要先重建站点。
- **GitHub 发布 403**：按失败 API 对照 `Contents`、`Workflows`、`Pages`、`Administration`，不要直接换成全权限 Token。
- **npm 409**：先查询相同 package/version 是否已进入 Registry；已接受的版本不能重复发布。
- **Notion 404**：检查 Page 是否明确分享给 Integration、Page ID 和 capabilities。
- **Cloudflare Pages 失败**：核对 Account ID、Pages Edit、zone 范围和 DNS Edit 是否确实需要。

## 10. 安全底线

- `SETTINGS_ENCRYPTION_KEY`、数据库密码、PAT、npm Token、Notion Secret 和 Bot Token 不提交。
- 初始 `admin/admin123` 仅作首次引导，必须立即修改。
- 平台 Token 按账号、站点和用途拆分；Token 到期、轮换和撤销要有负责人。
- PostgreSQL 仅回环/私网监听；控制中心只经 Caddy HTTPS。
- 站点凭据和 SSO Ticket 不可复用；日志只显示指纹。

## 11. 许可

发布到 GitHub、Cloudflare、npm 和 Notion 时，必须分别遵守平台条款、包名规则、内容许可和隐私要求。控制中心提供自动化，不替代平台授权审核。

官方权限参考：[GitHub Fine-grained PAT 权限](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)、[Cloudflare API Token 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)、[npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)、[Notion 授权](https://developers.notion.com/docs/authorization)。
