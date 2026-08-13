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
- Prompt 输入与发送；
- 等待生成开始/结束；
- Context Limit 识别；
- 读取稳定 Assistant 文本；
- 发现 Patch 控件；
- 从精确 Task-owned Project identity 发起删除并验证消失；
- 安全 UI diagnostics。

Project create/settings/delete 已具备语义定位实现，但仍需要在真实 ChatGPT 当前页面做 live calibration；出现歧义或找不到目标时保持 fail closed。

### PatchDownloadManager / ChromePatchProcessor

负责将页面 Patch 控件与真实 Chrome 下载关联。

核心关联条件：

```text
current tab
+ trigger time window
+ .patch identity
+ current session_id
```

只有 Chrome 下载状态 `complete` 后才作为 durable Patch artifact。

### TaskStore

持久化当前 locked Task 的执行状态，用于：

- Service Worker 生命周期恢复；
- Cleanup pending；
- 未来实现浏览器崩溃后的单 Project 恢复。

正常新 Task 不使用历史 Project 定位。

## 4. Context Limit

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

## 5. 锁语义

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

## 6. 安全策略

- UI selector 不确定或候选不唯一时 fail closed。
- Project 匹配只用于恢复，必须精确，不模糊猜测。
- Patch 只在 Chrome 确认下载完成后计数。
- Context Limit 不尝试自动续接。
- 不绕过登录验证、CAPTCHA 或浏览器安全机制。

## 7. Semantic UI Automation

真实 DOM 不绑定 hash CSS class。定位优先级：

```text
stable data-testid / name
→ role + aria-label/title
→ 多语言可见语义
→ 与精确 Project identity 的结构关系
→ 找不到或多候选：停止
```

Popup 的 `Inspect UI` 仅采集控件元数据（tag/role/aria/title/testid/name/type/placeholder/href），不返回 Assistant/User 消息正文，用于真实页面 selector 校准。
