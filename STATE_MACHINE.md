# State Machine

## Task 生命周期

```text
IDLE
 ↓
CLAIMED
 ↓
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
       │              COMPLETE / FAIL / RELEASE API
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
→ failTask(CHAT_LENGTH_LIMIT)
```

已经成功下载的 Patch 和已完成轮次保留在最终结果中。


## Terminal Pending

Project 已删除后，terminal API 仍可能发生“服务端已写入但客户端响应丢失”。因此发送 terminal request 前必须持久化：

```text
phase = TERMINAL_PENDING
terminal_action = COMPLETE | FAIL | RELEASE
terminal_payload = exact JSON payload
terminal_error = null | {...}
task_project.status = deleted
```

如果 terminal API 失败，TaskStore 不清除。恢复流程在 lease 验证通过后直接重试同一个 `terminal_payload`，不重新打开或删除 Project。由于 payload 完全一致，M10 的 `Idempotency-Key` 也保持一致。

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
BLOCKED      ├─ RUNNING → exact Project/Chat prepare only → RECOVERED_RUNNING
             ├─ CLEANUP → retry exact delete → TERMINAL_PENDING → original terminal API
             └─ TERMINAL_PENDING → retry exact persisted terminal payload only
```

规则：

- lease 验证失败时，不打开 Project、不删除 Project、不发送 Prompt；
- `RUNNING` 恢复只使用 durable `task_project.project_name + session_id`，禁止模糊匹配；
- 恢复成功后重新启动 lease heartbeat；
- activeExecution 未清除时拒绝新的 real claim；
- v0.8.0 不在 `RECOVERED_RUNNING` 后自动重发 Prompt；
- `CLEANUP` 恢复只继续 Cleanup，不重新执行 Task；
- `TERMINAL_PENDING` 恢复不碰 Project，只重试持久化的 exact terminal payload；
- heartbeat 返回轮换 lease 后立即持久化最新 token/TTL。
