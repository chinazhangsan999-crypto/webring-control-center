# 第十阶段：任务队列与告警

## 范围

本阶段把双平台发布和管理员告警统一放入 PostgreSQL 任务队列。队列状态是唯一事实来源；浏览器关闭或服务进程重启不会删除任务。当前不引入 Redis、BullMQ 或新的外部服务。

## 任务状态

- `queued`：等待执行，可由管理员取消。
- `running`：Worker 已领取并持续写入心跳。
- `succeeded`：任务完成，进度等于总步骤数。
- `failed`：达到最大尝试次数或遇到不可重试错误。
- `cancelled`：管理员在任务开始前取消。

发布任务共三步：生成静态包、发布 Cloudflare、发布 GitHub。两个平台分别保存结果，重试时复用已经成功的平台结果。普通失败最多尝试三次，等待时间依次为 30 秒、120 秒；下一次若仍失败则结束。配置、凭据或版本过期等不可重试错误直接失败。

Worker 每 10 秒刷新运行任务心跳。服务启动时，超过 5 分钟没有心跳的任务会自动恢复到队列；已经用完尝试次数的任务标记失败并发送最终失败告警。

## 告警链路

告警本身也是 `alert.send` 任务，优先级高于普通发布任务，但告警失败不会再次生成告警，避免递归和告警风暴。

发送顺序固定为：

1. Telegram，单次请求总超时 8 秒；失败后等待 1.5 秒再重试一次。
2. Telegram 最终失败后才使用 Bark。
3. Telegram 正文按约 3500 字符分片；Bark 按 2500 UTF-8 字节分片。
4. 所有标题自动添加 `【ALERT_SITE_NAME】`。
5. 正文中的完整 HTTP/HTTPS 地址在 Telegram 中由客户端识别，在 Bark 中转换为 Markdown 链接。

若两个通道都未配置，业务任务仍可正常完成，不创建必然失败的告警任务。后台任务中心会明确显示“未配置”。告警令牌只从环境变量读取，不写入数据库，也不返回前端。

## 环境变量

```text
ALERT_SITE_NAME=星环总控
ALERT_TELEGRAM_BOT_TOKEN=
ALERT_TELEGRAM_CHAT_ID=
ALERT_BARK_URL=
ALERT_TIMEOUT_MS=8000
ALERT_RETRY_DELAY_MS=1500
```

`ALERT_BARK_URL` 填写 Bark 推送接口地址。生产环境由进程管理器或密钥管理服务注入，不提交真实令牌。

## 后台接口

- `GET /api/admin/jobs`：最近 100 个任务及进度、错误码、平台结果。
- `GET /api/admin/jobs/overview`：排队数、运行数、24 小时成功数、告警成功率、Worker 状态和通道配置状态。
- `POST /api/admin/jobs/:id/retry`：将最终失败任务重新加入队列。
- `POST /api/admin/jobs/:id/cancel`：取消尚未执行的任务。
- `POST /api/admin/alerts/test`：创建一条真实告警测试任务。

## 验收标准

- 发布任务排队时显示 `0/3`，运行时按实际步骤增长，完成时为 `3/3`。
- 可重试失败按 30 秒、120 秒退避；不可重试错误不等待。
- 服务重启后，陈旧运行任务可恢复，不会长期卡死。
- Telegram 两次请求均失败时才调用 Bark；Telegram 成功时不调用 Bark。
- Bark 中文分片每段不超过 2500 UTF-8 字节。
- 告警任务失败后不产生新的告警任务。
- 后台不展示任何 Telegram Token 或 Bark 私密地址。
