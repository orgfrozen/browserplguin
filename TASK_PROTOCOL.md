# Task Protocol

## 1. Claim Task

最小 Task：

```json
{
  "task_id": "task_fix_001",
  "project_id": "vetatool",
  "task_prompt": "修复 sitemap lastmod 问题"
}
```

带 Project 初始化信息：

```json
{
  "task_id": "task_fix_001",
  "project_id": "vetatool",
  "task_prompt": "修复 sitemap lastmod 问题",
  "project_constraints": "遵循现有架构，不做无关重构。",
  "resource": {
    "url": "https://example.com/vetatool-source.zip",
    "filename": "vetatool-source.zip"
  },
  "initialization_prompt": "分析一下这个项目，并从seo角度来计划一下怎么进行"
}
```


资源规则：

- `resource` 可选；存在时 `resource.url` 必须是绝对 HTTP(S) URL。
- `resource.filename` 可选；未提供时优先使用响应 `Content-Disposition`，再使用 URL 最后路径段。
- Background 下载使用 `credentials: omit`，不把页面 Cookie 带给资源服务器。
- 默认原始资源上限 32 MiB；HTTP 非 2xx、空文件、超限或文件名非法均以 `RESOURCE_DOWNLOAD_FAILED` 终止。
- 资源域名必须已显式授予 exact-origin runtime host access；下载前客户端重新 `permissions.contains()`，缺失或检查异常以 `RESOURCE_HOST_PERMISSION_REQUIRED` 在 fetch 前终止。Background 不自动申请权限。
- 资源附件 ready 后先发送 `initialization_prompt`；初始化回复不增加 `task_round_count`，之后才进入真正 `task_prompt`。

批量 Patch 目标：

```json
{
  "task_id": "vetatool-seo-20260813",
  "project_id": "vetatool",
  "task_prompt": "持续优化 SEO",
  "patch_goal": {
    "minimum": 30
  }
}
```

`patch_goal` 缺失或为 `null` 时，Patch 数量只统计，不作为完成条件。

## 2. Session

Runner 为该 Task 创建唯一临时 Project 和唯一 Session。

```json
{
  "project_name": "vetatool2026081315",
  "session_id": "faf42343242"
}
```

当前 Task 生命周期内不会创建第二个 Session。

## 3. Model Status Protocol

Project Instructions 要求模型在回复末尾提供：

```text
<TASK_STATUS>CONTINUE</TASK_STATUS>
<TASK_STATUS>DONE</TASK_STATUS>
<TASK_STATUS>BLOCKED</TASK_STATUS>
```

规则：

- `CONTINUE` → 下一轮。
- `DONE` + 无 patch goal → 可完成。
- `DONE` + `task_patch_count < patch_goal.minimum` → 继续。
- `DONE` + 已达到 patch goal → 可完成。
- `BLOCKED` → 当前执行停止，Finalize/Cleanup 后 release。
- 缺少状态标记 → 有界 fallback；超过阈值后 Finalize/Cleanup + release。

## 4. Progress Events

示例：

```json
{
  "type": "TASK_PROJECT_STARTED",
  "project_name": "vetatool2026081315",
  "session_id": "faf42343242"
}
```


初始化开始：

```json
{
  "type": "TASK_INITIALIZING",
  "resource_url": "https://example.com/vetatool-source.zip",
  "project_name": "vetatool2026081315"
}
```

初始化完成：

```json
{
  "type": "TASK_INITIALIZED",
  "project_name": "vetatool2026081315"
}
```

```json
{
  "type": "ROUND_COMPLETED",
  "task_round_count": 8,
  "task_patch_count": 5,
  "task_status": "CONTINUE"
}
```

Context Limit：

```json
{
  "type": "TASK_CONTEXT_LIMIT",
  "task_round_count": 18,
  "task_patch_count": 21,
  "patch_goal": { "minimum": 30 }
}
```

Finalize：

```json
{
  "type": "TASK_FINALIZING",
  "terminal_reason": "CHAT_LENGTH_LIMIT",
  "task_round_count": 18,
  "task_patch_count": 21
}
```

Cleanup：

```json
{
  "type": "TASK_PROJECT_DELETED",
  "project_name": "vetatool2026081315",
  "session_id": "faf42343242"
}
```

## 5. Terminal Results

成功：

```json
{
  "terminal_status": "success",
  "task_patch_count": 1,
  "task_round_count": 4,
  "session_id": "faf42343242",
  "project_name": "vetatool2026081315",
  "patch_goal": null
}
```

Context Limit：

```json
{
  "terminal_status": "context_limit",
  "code": "CHAT_LENGTH_LIMIT",
  "task_patch_count": 21,
  "task_round_count": 18,
  "session_id": "faf42343242",
  "project_name": "vetatool2026081315",
  "patch_goal": { "minimum": 30 }
}
```

这是终止但非成功。插件不会在同一个 Task 内续接；服务端可根据业务策略创建新 Task。

## 6. Real Task API Wire Contract

所有真实 Task API 请求必须包含：

```text
X-Task-Protocol-Version: 1
```

### Claim

```http
POST /tasks/claim
```

无任务：

```text
204 No Content
```

领取成功：

```json
{
  "task": {
    "task_id": "task_fix_001",
    "project_id": "vetatool",
    "task_prompt": "修复 sitemap lastmod 问题"
  },
  "lease": {
    "token": "opaque-server-token",
    "ttl_ms": 90000,
    "expires_at": "2026-08-13T10:00:00Z"
  }
}
```

`lease.token` 必须为非空字符串，`lease.ttl_ms` 必须为正整数；`expires_at` 可选，存在时必须是可解析的 ISO date-time。协议错误直接拒绝该 claim 响应。

### Task scoped requests

以下请求必须带当前 lease：

```text
X-Task-Lease-Token: <lease.token>
```

```text
POST /tasks/{task_id}/heartbeat
POST /tasks/{task_id}/progress
POST /tasks/{task_id}/artifacts
POST /tasks/{task_id}/artifacts/upload
POST /tasks/{task_id}/complete
POST /tasks/{task_id}/context-limit
POST /tasks/{task_id}/fail
POST /tasks/{task_id}/release
```

Heartbeat 可返回 `204`（lease 不变），也可返回：

```json
{
  "lease": {
    "token": "rotated-token",
    "ttl_ms": 60000,
    "expires_at": "2026-08-13T10:01:00Z"
  }
}
```

客户端用新 lease 替换旧 lease，并按 `min(configuredInterval, floor(ttl_ms / 3))` 重新调度下一次 heartbeat；真实 runner 还必须把最新 lease 写回 durable `activeExecution.lease`。

### Context Limit terminal

ChatGPT 达到当前会话/上下文长度上限后，Runner 先完成 `FINALIZING → CLEANUP`，然后使用专用终态：

```http
POST /tasks/{task_id}/context-limit
X-Task-Lease-Token: <lease.token>
Idempotency-Key: browserplguin:<task_id>:<stable-hash>
Content-Type: application/json
```

请求体使用上面的 `terminal_status=context_limit` 结果。服务端应把 Task 记为独立的 `context_limit` 终态，而不是普通 `failed`。成功后客户端删除 lease；网络/服务端失败则保留 lease 和 durable `TERMINAL_PENDING`，以完全相同 payload 重试。

从 v0.18.0 开始，新 Context Limit checkpoint 使用 `terminal_action=CONTEXT_LIMIT`。为兼容旧版本已经持久化的 `terminal_action=FAIL` + `terminal_status=context_limit`，Recovery 必须继续向原 `/fail` endpoint 重试该 exact payload，不能改写 endpoint 或幂等语义。

### Local Patch artifact payload

local 模式只有在 Chrome download `complete` 且 transfer 校验成功后才上报。示例：

```json
{
  "task_id": "t1",
  "session_id": "faf42343242",
  "download_id": 41,
  "filename": "patch-faf42343242-001.patch",
  "local_path": "/Users/agent/Downloads/patch-faf42343242-001.patch",
  "source_url": "blob:https://chatgpt.com/...",
  "patch_key": "patch-faf42343242-001.patch",
  "transfer_mode": "local",
  "transfer_receipt": {
    "download_id": 41,
    "filename": "patch-faf42343242-001.patch",
    "local_path": "/Users/agent/Downloads/patch-faf42343242-001.patch",
    "source_url": "blob:https://chatgpt.com/..."
  }
}
```

第一版 local 目录策略是使用浏览器当前配置的 Downloads 目的地，不在插件中强制移动文件。`local_path` 以 Chrome 最终 DownloadItem 为准。

### Remote Patch upload payload

remote 模式的文件读取层必须先把已经完成的 Patch 转成 canonical base64。上传请求：

```http
POST /tasks/{task_id}/artifacts/upload
X-Task-Lease-Token: <lease.token>
Idempotency-Key: browserplguin:<task_id>:<stable-hash>
Content-Type: application/json
```

```json
{
  "session_id": "faf42343242",
  "filename": "patch-faf42343242-001.patch",
  "patch_key": "patch-faf42343242-001.patch",
  "content_type": "text/x-diff",
  "content_base64": "Li4u",
  "size_bytes": 1234
}
```

客户端验证 base64 与 `size_bytes` 完全一致，默认最多 32 MiB。network/408/425/429/5xx 使用完全相同 payload 重试，因此 Idempotency-Key 不变化；4xx 非瞬时错误不重试。

成功响应至少包含：

```json
{
  "artifact_id": "artifact_01H...",
  "filename": "patch-faf42343242-001.patch",
  "size_bytes": 1234,
  "sha256": "<optional-64-hex>"
}
```

receipt 的 filename/size 必须与上传内容一致。客户端只持久化 `artifact_id / filename / size_bytes / sha256?`；即使服务端返回下载 URL，也不会持久化该 URL，避免把签名参数带入 Task metadata。`content_base64` 只存在于上传请求内，上传完成后会从后续 artifact metadata 中剥离。

当前浏览器扩展没有任意本地文件读取能力，所以 remote Options 仍禁用；后续 Native Helper/安全文件读取层只负责提供 Patch bytes，不改变上述 upload contract。

### Idempotency

progress / artifact / artifact upload / complete / fail / release 必须携带：

```text
Idempotency-Key: browserplguin:<task_id>:<stable-hash>
```

`stable-hash` 基于 endpoint + canonical JSON payload 计算。对象 key 排序后再计算，因此同一语义请求重试会得到同一个 key。`complete / context-limit / fail / release` 只有成功返回后才删除客户端 lease；网络/服务端失败时保留 lease 以便原请求重试。

## 7. Lock Contract

服务端 claim 时加锁。

只有在：

```text
artifacts durable
+ final progress durable
+ temporary Project deleted
```

之后才能执行 `completeTask` / `contextLimitTask` / `failTask` / `releaseTask`。

Cleanup 失败则 Task 继续 locked。


## 8. Crash Recovery Lease Contract

Crash Recovery 不重新 claim。客户端必须从 durable `activeExecution` 读取：

```json
{
  "task_id": "t1",
  "task_snapshot": { "task_id": "t1", "project_id": "vetatool", "task_prompt": "..." },
  "lease": { "token": "opaque-token", "ttl_ms": 60000 },
  "phase": "RUNNING",
  "initialization_completed": true,
  "in_flight_round": {
    "round_number": 4,
    "prompt": "继续当前任务...",
    "stage": "PROMPT_SENT",
    "assistant_text": null
  },
  "task_project": {
    "project_name": "vetatool2026081318-t1",
    "session_id": "faf42343242",
    "status": "active"
  }
}
```

恢复顺序固定为：

1. `restoreLease(task_id, activeExecution.lease)`；
2. `POST /tasks/{task_id}/heartbeat` 验证服务器仍接受该 lease；
3. 若 heartbeat 失败，返回 `recovery_blocked`，不得执行 Project 打开/删除/Prompt；
4. 若 heartbeat 成功并返回 rotated lease，先更新 durable lease；
5. `phase=RUNNING` 时精确恢复 Project/Chat identity并重新启动 lease heartbeat；
6. state 必须包含 v0.9.0 round checkpoint 能力且 `initialization_completed=true`，否则 `recovery_blocked`；
7. 若 `in_flight_round` 存在，读取 `CHATGPT_ROUND_SNAPSHOT`，用 latest user text / latest role / latest assistant text / composer state / context limit 与 checkpoint 对账；
8. `READY_TO_SEND` 只有网页证明尚未发送时才能发送；`PROMPT_SENT` 只能等待已有生成；`RESPONSE_READY` 只能复用已证明一致的回复；任意歧义不得重发；
9. 若 `in_flight_round=null`，仅在上一轮已完整提交时，根据 durable status/patch/fallback 状态安全进入下一轮或原终态；
10. `phase=CLEANUP` 时只重试 Cleanup；删除成功后先进入 `TERMINAL_PENDING`；
11. terminal request 前持久化 `terminal_action + exact terminal_payload`，失败时保持 locked；
12. `phase=TERMINAL_PENDING` 时不再操作 Project，只用完全相同 payload 重试 complete/fail/release，因此 `Idempotency-Key` 保持一致。

v0.9.0 会在 Service Worker 启动时自动检测并执行上述安全恢复，并在证据充分时自动续跑工作 round。每轮必须按 `READY_TO_SEND → PROMPT_SENT → RESPONSE_READY → commit/clear` 顺序落盘；`task_round_count` 只在最后 commit 时递增。activeExecution 未清除前，客户端不得发起新的 `/tasks/claim`。资源初始化阶段如果 `initialization_completed` 尚未确认，仍保持 fail closed，不猜测附件或 initialization Prompt 是否已执行。

## Browser Access Error

`LOGIN_OR_CHALLENGE_REQUIRED` 是浏览器执行端的 fail-closed 状态，不表示 Task Server 协议错误。触发证据只来自登录 URL/控件或安全 challenge 的顶层 URL/title/受限 UI 控件语义。插件不得自动绕过 CAPTCHA/Turnstile。

- 创建临时 Project 前命中：Task 可按现有 create-error/release 路径释放；
- Task 已进入 RUNNING 后命中：停止继续发送 Prompt/执行页面动作，并进入既有终止/Cleanup 逻辑；
- Cleanup 也被访问守卫阻断：保持 durable locked state，等待人工恢复登录/完成挑战后由 Crash Recovery 继续。
