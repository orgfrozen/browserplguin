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
       ├─ success → COMPLETE / FAIL / RELEASE
       └─ failure → CLEANUP_PENDING (still locked)
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

## Cleanup Pending

如果 Project 删除失败：

```text
phase = CLEANUP
cleanup_error = {...}
task_project.status = active
Task = locked
```

这不是服务端 Task 终态。后续恢复流程只需要继续处理这一个临时 Project。
