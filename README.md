# 星环总控

面向多个域名、不同 IP、不同云厂商导航站的统一管理中心。第一阶段实现本地可运行的控制面，不修改任何现网导航站，也不执行云端发布。

## 已实现

- 一个总后台账号登录，服务端 Session Cookie 与 CSRF 防护。
- 导航站登记、启停、心跳状态、站点凭据轮换。
- 60 秒一次性后台入口票据；票据兑换后立即失效。
- 节点全局投放、指定站点投放、按站点分组投放。
- 统一节点排序、投放范围校验、单站有效快照预览及 Agent 应用进度展示。
- 中央广告全局或定向投放，联盟代码只保存在总后台并记录 SHA-256。
- 多广告 API 域名管理：支持默认中央 API、站点分组和单站分配，自动部署 Cloudflare Worker。
- 代码广告可选择主页面执行或 sandbox iframe；导航站快照不再携带联盟代码原文。
- 每站每广告位独立策略：`central_only`、`central_first`、`mixed`、`local_only`。
- 每个网站独立永久发布页配置，同时展示自定义永久域名与 GitHub Pages 地址。
- PostgreSQL 持久化任务队列和审计日志。
- 站点 Agent：主动心跳、ETag 增量拉取、一次性 SSO 兑换。
- 统一后台登录：总后台登录一次后，以站点绑定的一次性票据进入各导航站后台。
- 总控与 Agent 共用版本化协议：握手、稳定错误码、快照 Schema、站点归属和修订号一致性校验。
- 数据库层强制单超级管理员，提供改密、会话检查、其他会话回收和安全审计。
- 总后台界面参照导航系统后台模板，采用顶部胶囊导航、浅色卡片布局并适配手机端。
- 静态发布页生成器；生成页面不依赖主站或总后台。
- 永久发布页双平台工作流：独立发布到 Cloudflare Pages 自定义域名与 GitHub Pages，并按远端摘要验收。
- 总后台发布页管理：配置完整度、待发布变更、双平台状态、安全预览、单站历史和失败平台重试。
- 持久化任务队列：优先级、执行进度、心跳恢复、错误分类与指数退避重试。
- 统一任务告警：所有标题带总后台名称，Telegram 失败后自动转 Bark，并可在任务中心查看成功率和最近失败原因。

## 本地启动

1. 复制 `.env.example` 为 `.env`，设置新的数据库密码和管理员密码。
2. 将 `.env` 中的变量注入当前终端或进程管理器。
3. 启动 PostgreSQL：`docker compose up -d postgres`。
4. 安装依赖：`npm install`。
5. 执行迁移：`npm run migrate`。
6. 启动服务：`npm start`。
7. 打开 `http://127.0.0.1:3100`。

Node.js 不会自动读取 `.env`。生产环境应由 systemd、Docker Compose、PM2 或密钥管理服务注入环境变量。

## 安全边界

- 不按管理员公网 IP 放行；管理员从总后台登录。
- 导航站使用独立凭据主动访问总后台，不暴露 SQLite 或内部管理端口。
- 凭据只在创建或轮换时显示一次，数据库仅保存摘要。
- 单点登录票据只能由目标站点凭据兑换一次。
- 代码广告不做内容过滤或改写；Direct 模式等同于在导航站主页面执行第三方代码，仅用于明确可信的联盟代码。
- Sandbox 模式不授予 `allow-same-origin`，广告 API 使用站点级短期票据、Origin 校验和服务端签名回源。
- 当前站点 Agent 是接入包，尚未写入现有导航站；第二阶段选择测试站后再接入并灰度。

## 目录

- `src/`：总后台 API、认证、PostgreSQL 数据层和任务执行器。
- `docs/BACKEND.md`：第三阶段后端、单超级管理员与 API 边界说明。
- `docs/UNIFIED_LOGIN.md`：第四阶段统一后台登录链路、安全约束与灰度策略。
- `docs/UNIFIED_NODES.md`：第五阶段统一节点管理、下发一致性和本地数据边界。
- `docs/AD_MIXED_MANAGEMENT.md`：第六阶段中央/本地广告混合策略、优先级和原子下发。
- `docs/PUBLISH_PAGE_TEMPLATE.md`：第七阶段永久发布页模板、双地址配置和静态发布包边界。
- `docs/DUAL_PLATFORM_WORKFLOW.md`：第八阶段双平台发布、凭据权限、独立重试和远端校验。
- `docs/PUBLISH_PAGE_MANAGEMENT.md`：第九阶段总后台发布页管理、状态口径、预览与历史操作。
- `docs/TASK_QUEUE_ALERTS.md`：第十阶段任务队列、重试、进程恢复与 Telegram → Bark 告警链路。
- `docs/LOCAL_TESTING.md`：第十一阶段本地测试结果、浏览器验收和数据库联调步骤。
- `public/`：无框架响应式管理界面。
- `packages/site-agent/`：导航站接入包。
- `packages/shared-protocol/`：总控与 Agent 共享的 `1.0` 协议、运行时校验器和 JSON Schema。
- `packages/publish-page-template/`：永久发布页静态生成器。
- `test/`：不依赖真实 PostgreSQL 的核心单元测试。

## 第一阶段不包含

- 真实 Cloudflare/GitHub 凭据注入、DNS 配置和首次云端灰度发布。
- 把现网节点、广告或发布页数据迁入总后台。
- 关闭各导航站本地节点管理入口。
- 关闭导航站原有后台登录；须等 SSO 灰度验收通过后再进行。
