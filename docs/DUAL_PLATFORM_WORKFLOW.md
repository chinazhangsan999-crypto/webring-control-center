# 第八阶段：永久发布页双平台工作流

## 结果

总后台的 `publish.deploy` 任务现在执行完整发布链路：

```text
锁定站点配置版本
  -> 生成一份固定静态包和 SHA-256
  -> GitHub Pages 与 Cloudflare Pages 独立发布
  -> 分别读取远端 publish-manifest.json
  -> 两端摘要都一致后，任务才标记成功
```

Cloudflare 和 GitHub 的发布并行执行。一个平台失败不会阻止另一个平台完成；任务重试时会保留已经成功的平台，只重新执行失败平台。若发布页配置或统一节点在任务排队后发生变化，旧任务会停止，避免把过期入口发布到远端。

## 凭据

凭据只通过总后台进程的环境变量注入，不写入 PostgreSQL、任务结果、审计日志或静态发布包。

```dotenv
PUBLISH_GITHUB_TOKEN=
PUBLISH_GITHUB_BRANCH=gh-pages
PUBLISH_CLOUDFLARE_API_TOKEN=
PUBLISH_CLOUDFLARE_ACCOUNT_ID=
PUBLISH_CLOUDFLARE_BRANCH=main
PUBLISH_WRANGLER_STATE_DIR=
```

生产环境需要 Node.js 22 或更高版本。Cloudflare 发布使用项目锁定的官方 Wrangler，不依赖服务器全局安装。

## GitHub 准备

每个导航站使用一个已经创建并至少有一次初始提交的独立仓库。后台“GitHub 仓库”填写：

```text
owner/repository
```

“GitHub Pages 发布地址”填写 GitHub 提供的原生地址，例如：

```text
https://owner.github.io/repository/
```

建议使用 fine-grained token，并只授权这些发布页仓库。需要的仓库权限：

- Contents：Read and write；
- Pages：Read and write；
- Administration：Read and write（首次启用或调整 Pages 来源需要）。

工作流把五个静态文件写成一棵完整 Git Tree，创建提交并更新 `gh-pages` 分支，然后确保 GitHub Pages 使用该分支根目录。发布仓库应专用于永久发布页，因为每次发布会让 `gh-pages` 分支只保留当前静态包。

## Cloudflare 准备

Cloudflare API Token 至少需要账户级 `Cloudflare Pages: Edit`，并限制到承载发布页的账户。配置项“Cloudflare 项目”填写小写项目名。

工作流会：

1. 查询 Pages 项目；不存在时创建 Direct Upload 项目；
2. 查询自定义永久域名；未关联时提交关联；
3. 通过 Wrangler Direct Upload 上传静态目录；
4. 使用自定义永久域名读取远端 manifest 验证。

自定义域名仍需满足 Cloudflare 的域名所有权和 DNS 条件。若域名不在该 Cloudflare 账户、验证记录缺失或证书仍在签发，发布上传可能成功，但最终校验会失败并进入重试；后台会保留具体平台错误。

`pages.dev` 只作为 Cloudflare 内部部署结果记录，不会展示为用户应收藏的永久地址。

## 状态与重试

任务的 `result.platforms` 独立记录：

```json
{
  "github": {
    "status": "succeeded",
    "commit_sha": "...",
    "branch": "gh-pages",
    "verified": true
  },
  "cloudflare": {
    "status": "failed",
    "error": "...",
    "retryable": true
  }
}
```

- 自动失败最多沿用任务现有的 3 次尝试，间隔 30 秒；
- 手动重试会保留已成功平台；
- 如果配置版本变化，手动重试会清空旧结果并使用新版本；
- 缺少令牌、仓库格式错误等配置错误不做无意义自动重试；
- 两个平台都通过远端摘要校验后才产生 `publish.deploy.succeeded` 审计记录；
- 最终失败产生 `publish.deploy.failed` 审计记录，但不记录令牌。

## 后台展示

永久发布页卡片分别显示 Cloudflare 与 GitHub 的“待发布、发布中、已发布、失败”状态，并展示最近错误。任务中心同样分列显示两个平台，并提供：

- 失败任务“重试”；
- 排队任务“取消”。

## 安全与故障边界

- GitHub 更新分支时不使用强制覆盖，发现并发提交会失败而不是吞掉远端变化；
- 只有固定的五个静态文件允许进入发布工作流；
- 平台 HTTP 请求均有 20 秒总超时；
- Wrangler 进程最多运行 120 秒；
- 远端验证最多约 90 秒，并使用查询参数绕过旧缓存；
- 日志与 Wrangler 状态默认写入 `var/`，不会混进静态包或 Git 提交；
- 删除远端项目、仓库、域名和历史部署不属于本阶段，工作流不会执行任何远端删除操作。

## 本阶段没有执行的外部操作

代码已经具备真实发布能力，但本阶段没有使用真实令牌、创建远端项目、修改 DNS、推送任何 GitHub 仓库，也没有发布到云端。配置生产凭据并完成单个测试站灰度后，再启用全部站点。
