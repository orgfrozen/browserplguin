# State Machine

## Task 生命周期

```text
IDLE
 ↓
CLAIMED
 ↓
ACCESS_GUARD
 ├─ LOGIN/CHALLENGE → fail-closed
 ↓ READY
CREATE_PROJECT
 ↓
RUNNING
 ↓
┌──────────────────────────────────────────┐
│ Round                                    │
│  SEND_PROMPT                             │
│      ↓                                   │
│  WAIT_GENERATING                         │
│      ↓                                   │
│  WAIT_READY                              │
│      ↓                                   │
│  PROCESS_PATCHES                         │
│      ↓                                   │
│  ROUND_COMPLETED                         │
│      ↓                                   │
│  CONTINUE ────────────────────────┐       │
└───────────────────────────────────┼───────┘
                                    │
                                    └→ next Round
```

终止分支：

```text
RUNNING
  ├─ TASK DONE
  ├─ CONTEXT_LIMIT
  ├─ BLOCKED / PROTOCOL_ERROR
  ├─ MAX_TASK_ROUNDS
  └─ UNEXPECTED ERROR
       ↓
FINALIZING
       ↓
CLEANUP
       ↓
DELETE_TASK_PROJECT
       ↓
       ├─ delete success → TERMINAL_PENDING
       │                    ↓
       │      COMPLETE / CONTEXT_LIMIT / FAIL / RELEASE API
       │                    ├─ ack → terminal + clear TaskStore
       │                    └─ error → TERMINAL_PENDING (still locked)
       └─ delete failure → CLEANUP_PENDING (still locked)
```

## 模型一轮状态

```text
READY
 ↓ send prompt
WAIT_GENERATING
 ↓ observe Stop/generating semantics
GENERATING
 ↓
WAIT_READY
 ↓ Stop disappears + Send/↑ returns
STABILIZE_RESPONSE
 ↓ latest assistant response stable
PROCESS_PATCHES
 ↓
ROUND_COMPLETED
```

不能仅因为看到发送箭头就判定回复完成；必须观察这一轮真实进入过生成态。


## Durable Round Checkpoint

正常执行和 Crash Recovery 共用同一组 round checkpoint：

```text
READY_TO_SEND
  ↓ page send succeeds
PROMPT_SENT
  ↓ READY + stable assistant response
RESPONSE_READY
  ↓ Patch/status processing durable
ROUND_COMMIT
  ├─ task_round_count += 1
  └─ in_flight_round = null
```

`task_round_count` 只统计 `ROUND_COMMIT` 完成的工作轮次。Recovery 不以 storage 状态单独猜测网页副作用，而是同时读取当前 ChatGPT 的 latest user message、latest message role、latest assistant text、composer state 和 Context Limit：

- `READY_TO_SEND`：只有网页证明 checkpoint Prompt 尚未发送且当前没有别的未回答 user message时才发送；
- `PROMPT_SENT`：最新 user message 必须精确等于 checkpoint Prompt；生成中继续等待，绝不重发；
- `RESPONSE_READY`：最新 user/assistant 顺序、assistant text 与 READY 状态必须和 checkpoint 一致，直接继续持久化；
- 任意歧义：`TASK_RECOVERY_BLOCKED`。

资源 Task 还必须 `initialization_completed=true` 才允许自动恢复工作 round；否则 fail closed。

## Context Limit

如果 `CHATGPT_STATE.contextLimit = true`：

```text
当前 Task 不再发送任何 Prompt
不创建第二个 Project
不建立第二个 Session
不发送恢复 Prompt
```

Runner 直接进入：

```text
TASK_CONTEXT_LIMIT
→ FINALIZING
→ CLEANUP
→ terminal_action = CONTEXT_LIMIT
→ POST /tasks/{task_id}/context-limit
```

已经成功下载的 Patch 和已完成轮次保留在最终结果中。


## Terminal Pending

Project 已删除后，terminal API 仍可能发生“服务端已写入但客户端响应丢失”。因此发送 terminal request 前必须持久化：

```text
phase = TERMINAL_PENDING
terminal_action = COMPLETE | CONTEXT_LIMIT | FAIL | RELEASE
terminal_payload = exact JSON payload
terminal_error = null | {...}
task_project.status = deleted
```

如果 terminal API 失败，TaskStore 不清除。恢复流程在 lease 验证通过后直接重试同一个 `terminal_payload`，不重新打开或删除 Project。由于 payload 完全一致，M10 的 `Idempotency-Key` 也保持一致。新版本的 Context Limit 使用 `CONTEXT_LIMIT` action；旧版本若已落盘 `FAIL + terminal_status=context_limit`，必须继续使用原 `/fail` endpoint exact retry，避免改变已持久化终态语义。

## Cleanup Pending

如果 Project 删除失败：

```text
phase = CLEANUP
cleanup_error = {...}
task_project.status = active
Task = locked
```

这不是服务端 Task 终态。后续恢复流程只需要继续处理这一个临时 Project。


## Crash Recovery Safety Base

恢复不是正常 claim：

```text
Service Worker boot / explicit recover
        ↓
settings.mode=real + activeExecution exists?
        ↓ YES
restore persisted lease
        ↓
heartbeat validates lock ownership
        ↓
     accepted?
      /    \
    NO      YES
    ↓        ↓
RECOVERY   inspect durable phase
BLOCKED      ├─ RUNNING → exact Project/Chat → reconcile durable round checkpoint → safe auto-resume
             ├─ CLEANUP → retry exact delete → TERMINAL_PENDING → original terminal API
             └─ TERMINAL_PENDING → retry exact persisted terminal payload only
```

规则：

- lease 验证失败时，不打开 Project、不删除 Project、不发送 Prompt；
- `RUNNING` 恢复只使用 durable `task_project.project_name + session_id`，禁止模糊匹配；
- 恢复成功后重新启动 lease heartbeat；
- activeExecution 未清除时拒绝新的 real claim；
- v0.9.0 只有在 durable `in_flight_round` 与页面事实能相互证明时才发送/等待/复用当前 round；歧义时不重发 Prompt；
- `CLEANUP` 恢复只继续 Cleanup，不重新执行 Task；
- `TERMINAL_PENDING` 恢复不碰 Project，只重试持久化的 exact terminal payload；
- heartbeat 返回轮换 lease 后立即持久化最新 token/TTL。

## Login / Challenge Access Guard

所有真正改变 ChatGPT 状态或推进 Task 的 content 命令，在执行前统一通过页面访问守卫：

```text
chatgpt.com/auth/login | visible login control without composer
        → LOGIN_REQUIRED
challenge URL/title | Turnstile/CAPTCHA/challenge iframe/form/testid
        → CHALLENGE_REQUIRED
READY chat UI
        → continue automation
```

前两种都转换为 `LOGIN_OR_CHALLENGE_REQUIRED`，不会点击登录、不会处理 CAPTCHA、不会绕过 challenge。`CHATGPT_UI_DIAGNOSTICS` 与 `CHATGPT_ACCESS_STATE` 不受阻断，供人工处理后排障。Task 创建前遇到该错误时正常 release；Task 已运行后遇到该错误时进入现有 fail/finalize/cleanup 流程，而 Cleanup 若同样被 challenge 阻断则保持 durable locked state。
