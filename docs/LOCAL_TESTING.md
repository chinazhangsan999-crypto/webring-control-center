# 第十一阶段：本地测试

## 一键代码测试

```powershell
npm run test:local
npm audit --omit=dev
```

`test:local` 会先检查服务入口、后台路由、任务执行器、告警服务和浏览器脚本语法，然后执行全部 Node.js 单元测试。

## 2026-09-11 本机结果

- JavaScript 语法检查：通过。
- Node.js 单元测试：65/65 通过。
- 依赖安全扫描：0 个已知漏洞。
- 桌面浏览器任务中心：通过。
- 390 × 844 手机视口：通过。
- 浏览器控制台：0 个错误、0 个警告。
- “测试告警”按钮：确认发出 `POST /api/admin/alerts/test`。
- 北京时间显示：通过。
- CSP：测试时发现内联进度条样式被阻止，已改为原生 `<progress>` 并复测通过。

浏览器检查使用本地静态资源和模拟 API 数据，只验证前端渲染、响应式布局及交互。它不等同于真实 PostgreSQL、Telegram、Bark、Cloudflare 或 GitHub 联调。

验收截图：

- `output/playwright/task-center-desktop.png`
- `output/playwright/task-center-mobile.png`

## 数据库集成测试前置条件

当前测试机未安装 PostgreSQL、Docker 或 Podman，且 5432 端口未监听，因此本轮没有伪造数据库迁移和真实登录通过结果。

具备 Docker 的环境按以下步骤执行：

```powershell
docker compose up -d postgres
$env:INITIAL_ADMIN_PASSWORD='请换成至少12位的本地测试密码'
npm run migrate
npm start
```

然后打开 `http://127.0.0.1:3100`，依次检查：

1. 使用唯一超级管理员登录。
2. 新增一个测试导航站并保存一次性凭据。
3. 创建节点和广告，确认单站有效快照。
4. 配置永久发布页，但不要填写生产令牌。
5. 打开任务中心，确认 Worker 显示运行中。
6. 创建发布任务，确认进度从 `0/3` 依次变化。
7. 人为使用无效测试凭据，确认错误码和退避重试。
8. 重启服务，确认陈旧运行任务能够恢复。
9. 配置专用测试 Telegram/Bark 通道后点击“测试告警”。

## 外部通道安全要求

- 只使用专门的测试 Bot、测试 Chat 和测试 Bark Key。
- 不把真实 Token 写入 `.env.example`、测试源码或截图。
- Cloudflare/GitHub 发布联调使用测试项目和测试仓库。
- 测试完成后轮换临时凭据并删除测试数据。
