# Architecture

## 1. 架构定位

ChatGPT Web Task Runner 把已经登录的 `chatgpt.com` 浏览器环境当作一个 Task Executor。

```text
Task Server
    │
    │ claim / heartbeat / progress / artifact / terminal
    ▼
Chrome Extension (MV3)
    │
    ├── TaskRunner
    ├── TaskStore
    ├── BrowserPageDriver
    ├── ResourceLoader
    ├── PatchDownloadManager
    └── ChromePatchProcessor
    │
    ▼
chatgpt.com DOM
```

最重要的边界：

```text
1 Task = 1 temporary ChatGPT Project = 1 Session
```

ChatGPT Project 是一次 Task 的临时工作区，不是长期业务项目容器。

## 2. 正常数据流

```text
Task Server
  ↓ claim (server lock)
TaskRunner
  ↓
createTaskProject()
  ↓
Project Initialization
  ├─ Project Instructions
  ├─ resource package
  └─ initialization prompt
  ↓
Task Loop
  ├─ send prompt
  ├─ wait generating
  ├─ wait ready
  ├─ scan latest assistant response
  ├─ download new Patch artifacts
  ├─ update task_patch_count
  └─ CONTINUE / DONE
  ↓
Terminal Reason
  ↓
FINALIZING
  ↓
CLEANUP: delete the one Task Project
  ↓
complete / fail / release
```

## 3. 主要组件

### TaskRunner

负责：

- claim Task 后建立运行状态；
- 正常路径创建一个新的临时 Project；
- 驱动多轮模型对话；
- 处理 `patch_goal`；
- 处理 Context Limit；
- 保证 Finalize/Cleanup 顺序；
- 最后调用服务端终态 API。

TaskRunner **不支持当前 Task 内 Project 迁移**。

### ExecutionState

只保留 Task 级状态：

```json
{
  "task_id": "t1",
  "project_id": "vetatool",
  "phase": "RUNNING",
  "session_id": "faf42343242",
  "chatgpt_project_name": "vetatool2026081315",
  "task_round_count": 8,
  "task_patch_count": 5,
  "initialization_completed": true,
  "in_flight_round": {
    "round_number": 9,
    "prompt": "继续当前任务...",
    "stage": "PROMPT_SENT",
    "assistant_text": null
  },
  "downloaded_patch_keys": [],
  "task_project": {
    "project_name": "vetatool2026081315",
    "session_id": "faf42343242",
    "status": "active"
  }
}
```

没有 Session 级 Patch/round counter，也没有 Project history 数组，因为一个 Task 只有一个 Project/Session。

### BrowserPageDriver

负责把 Runner 意图转换为 ChatGPT 页面动作。

当前已实现：

- 正常路径创建一个新的临时 Project；
- 同小时项目名冲突安全递增；
- 生成唯一 Session ID；
- 写入 Project Instructions；
- 下载/校验 Task `resource.url`，并把可序列化资源 payload 交给 content script；
- 将资源附件注入 ChatGPT composer 并等待 ready；
- 执行 `initialization_prompt`，且不计入 Task 工作 round；
- Prompt 输入与发送；
- 等待生成开始/结束；
- Context Limit 识别；
- 读取稳定 Assistant 文本；
- 发现 Patch 控件；
- 从精确 Task-owned Project identity 发起删除并验证消失；
- 安全 UI diagnostics。

Project create/settings/resource attachment/delete 已具备语义实现，但仍需要在真实 ChatGPT 当前页面做 live calibration；出现歧义或找不到目标时保持 fail closed。资源下载在 background 执行，默认原始大小上限 32 MiB，并使用 `credentials: omit`；资源域名必须具备扩展 host access。

### PatchDownloadManager / ChromePatchProcessor

负责将页面 Patch 控件与真实 Chrome 下载关联。

核心关联条件：

```text
current tab
+ trigger time window
+ .patch identity
+ current session_id
```

只有 Chrome 下载状态 `complete` 后才进入 artifact transfer。

### ArtifactTransferManager

负责把已经完成的 Chrome Patch 下载转换成可上报的传送结果。v0.6.0 的 local 模式不移动文件，使用浏览器当前 Downloads 目的地，并要求 Chrome 已提供最终：

```text
download_id
filename
local_path
source_url
```

local transfer 成功后返回 receipt；TaskRunner 只有在 receipt 成功后才增加 `task_patch_count`，并先持久化新的计数/去重状态，再调用 artifact API。remote transport 仍保持 fail-closed，未配置 Native Helper/transport 时不能假装成功。

### TaskStore

持久化当前 locked Task 的执行状态，用于：

- Service Worker 生命周期恢复；
- Cleanup pending；
- 持久化 normalized Task snapshot、当前 lease、唯一 Project/Session identity；
- heartbeat token/TTL 轮换后原子更新 durable lease。

正常新 Task 不使用历史 Project 定位。

## 4. Task API Lease / Idempotency

真实模式的 HTTP Task API 使用协议版本 `1`。所有请求携带：

```text
X-Task-Protocol-Version: 1
```

claim 成功返回：

```json
{
  "task": { "task_id": "t1", "project_id": "vetatool", "task_prompt": "..." },
  "lease": {
    "token": "opaque-server-token",
    "ttl_ms": 90000,
    "expires_at": "2026-08-13T10:00:00Z"
  }
}
```

`204` 表示当前没有可领取 Task。claim 后，heartbeat/progress/artifact/terminal 请求必须带：

```text
X-Task-Lease-Token: <lease.token>
```

Heartbeat 调度周期为：

```text
min(configured heartbeat interval, floor(lease.ttl_ms / 3))
```

heartbeat 若返回新的 `lease`，客户端立即替换 token/TTL，下一次 heartbeat 使用新 TTL 重新调度；真实 runner 同时把最新 lease 写回 TaskStore，确保 Service Worker 重启后可恢复验锁。

progress/artifact/complete/fail/release 写请求还带稳定 `Idempotency-Key`。key 基于 Task ID、endpoint 和 canonical JSON payload 计算，因此同一语义 payload 即使对象字段顺序变化也得到相同 key。terminal API 只有在服务端成功确认后才清除客户端 lease。


## 4.1 Crash Recovery Safety Base

恢复入口与正常 claim 分离。v0.9.0 中 Service Worker bootstrap 会先初始化 settings，再调用 `recoverRealIfNeeded()`；仅当 `settings.mode=real` 且存在 `activeExecution` 时进入恢复。恢复不调用 `/tasks/claim`：

```text
load activeExecution
→ restore persisted lease into HttpTaskApi
→ heartbeatTask(task_id)
→ server accepts lease?
   ├─ NO  → recovery_blocked; no Project open/delete/send
   └─ YES → persist refreshed lease
```

RUNNING 先精确打开记录中的唯一 Project/Chat，然后使用 durable round checkpoint：

```text
READY_TO_SEND
→ Prompt intent 已落盘，网页事实证明尚未发送才允许发送

PROMPT_SENT
→ Prompt 已发送；网页必须证明最新 user message 与 checkpoint Prompt 一致
→ GENERATING 时继续等待，不重发

RESPONSE_READY
→ Assistant 稳定回复已落盘
→ 网页必须证明最新 user/assistant/READY 与 checkpoint 一致
→ 直接继续 Patch/status 持久化，不重发、不重新等待一轮
```

页面事实来自当前 Chat 的 latest user text、latest message role、latest assistant text、composer state 和 Context Limit。任何不一致或歧义都返回 `TASK_RECOVERY_BLOCKED`。若 `in_flight_round=null`，只有 state 明确支持 checkpoint、`initialization_completed=true` 且上一轮已完整提交时，Runner 才根据 durable `last_task_status/fallback_count/patch_count` 安全进入下一轮或原终态。旧版本没有 checkpoint 能力的 RUNNING state 不自动续跑。

每轮完成顺序固定为：

```text
persist READY_TO_SEND
→ send Prompt
→ persist PROMPT_SENT
→ wait response stable
→ persist RESPONSE_READY + assistant_text
→ process/dedupe/report Patches
→ parse TASK_STATUS
→ one durable save: task_round_count + 1, clear in_flight_round
```

CLEANUP 与 TERMINAL_PENDING 的恢复规则保持不变：CLEANUP 只删除精确 Task Project；Project 删除后先持久化完整 terminal payload；TERMINAL_PENDING 只幂等重试原 terminal API。activeExecution 未清除前，新的 real Run 仍被拒绝。

## 5. Context Limit

Context Limit 是 Task 的终止原因，不是切换工作区信号。

```text
RUNNING
  ↓
CONTEXT_LIMIT detected
  ↓
report TASK_CONTEXT_LIMIT
  ↓
FINALIZING
  ↓
CLEANUP
  ↓
delete temporary Project
  ↓
failTask(code=CHAT_LENGTH_LIMIT)
```

服务端若要继续，创建一个新的 Task。新 Task 拥有新的 Project、Session 和 Patch 序列。

## 6. 锁语义

Task Server 的锁必须覆盖：

```text
claim
→ all model rounds
→ Patch completion/reporting
→ finalization
→ Project cleanup
→ terminal API
```

Cleanup 失败时：

```text
phase = CLEANUP
Task remains locked
state remains durable
```

不能提前 `complete/release/fail`。

## 7. 安全策略

- UI selector 不确定或候选不唯一时 fail closed。
- Project 匹配只用于恢复，必须精确，不模糊猜测。
- Patch 只在 Chrome 确认下载完成后计数。
- Context Limit 不尝试自动续接。
- 不绕过登录验证、CAPTCHA 或浏览器安全机制。

## 8. Semantic UI Automation

真实 DOM 不绑定 hash CSS class。定位优先级：

```text
stable data-testid / name
→ role + aria-label/title
→ 多语言可见语义
→ 与精确 Project identity 的结构关系
→ 找不到或多候选：停止
```

Popup 的 `Inspect UI` 仅采集控件元数据（tag/role/aria/title/testid/name/type/placeholder/href），不返回 Assistant/User 消息正文，用于真实页面 selector 校准。

Popup 的运行态观测通过 background 的 privacy-safe status projection 获取数据，只返回 Task/phase/round/Patch/Project/Session/in-flight/lease TTL/错误码等运行元数据。`task_snapshot.task_prompt`、Project constraints、resource URL、Task API token、lease token 和错误 message 不进入该 status payload。
