# ChatGPT Web Task Runner

一个以 Chrome Extension（Manifest V3）为执行端的 ChatGPT Web 自动化任务运行器骨架。

当前架构的核心原则已经固定：

> **1 Task = 1 临时 ChatGPT Project = 1 Session。**

每次从服务端 claim 一个 Task，插件都创建一个新的临时 ChatGPT Project，在这个 Project 的单一聊天里通过多轮对话完成任务、自动下载 Patch、统计 Patch 数。Task 正常完成、达到聊天/上下文最大长度、被阻塞或发生终止错误后，都会先进入 Finalize/Cleanup，删除这个 Task 的临时 Project，再向服务端完成最终状态变更。

## 核心规则

- 每个 Task 正常路径永远创建新的 ChatGPT Project，不复用业务历史 Project。
- 一个 Task 只拥有一个 ChatGPT Project 和一个 Session。
- 一个 Task 可以与模型进行很多轮对话。
- 一个 Task 可以生成 0、1 或很多个 Patch。
- `task_patch_count` 永远统计成功下载并去重后的 Patch 数量。
- `patch_goal` 是可选约束：普通 fix bug 可以没有；例如 SEO 批量任务可以配置 `minimum: 30`。
- 达到 ChatGPT 聊天/上下文最大长度时，当前 Task **直接终止**，不会自动创建第二个 Project。
- 如果服务端希望继续未完成工作，应创建一个新的 Task，由新的 Task 再创建自己的临时 Project。
- Task 锁一直保持到成果 Finalize 完成、临时 Project 删除完成之后。
- Cleanup 失败时保持 Task locked，并保存 durable state，避免其他执行器拿到同一个 Task。

## 一个 Task 的典型生命周期

```text
CLAIM_TASK
   ↓
ACCESS_GUARD                   ← 登录失效/安全挑战直接 fail-closed
   ↓
CREATE_TEMP_PROJECT
   ↓
SET_PROJECT_INSTRUCTIONS      ← 语义定位已实现，待真实页面校准
   ↓
DOWNLOAD_RESOURCE             ← 已实现，待真实资源域名/权限校准
   ↓
UPLOAD_RESOURCE               ← 已实现，待真实文件输入/附件卡片校准
   ↓
INITIALIZE_PROJECT            ← 已实现，初始化回复不计入工作 round
   ↓
RUNNING
   ↓
多轮：Prompt → Model → Patch → Continue
   ↓
   ├─ TASK DONE
   ├─ CONTEXT_LIMIT
   ├─ BLOCKED / PROTOCOL_ERROR
   └─ UNEXPECTED ERROR
   ↓
FINALIZING
   ↓
确认 Patch/结果已持久化
   ↓
CLEANUP
   ↓
DELETE_TEMP_PROJECT            ← 精确 identity + 语义定位已实现，待真实页面校准
   ↓
COMPLETE / FAIL / RELEASE
```

## Patch 数量规则

普通 fix task：

```json
{
  "task_id": "fix-001",
  "project_id": "vetatool",
  "task_prompt": "修复 sitemap lastmod 问题"
}
```

没有 `patch_goal`，Patch 数量只做统计，不参与完成判断。

批量 SEO task：

```json
{
  "task_id": "vetatool-seo-20260813",
  "project_id": "vetatool",
  "task_prompt": "持续从 SEO 角度优化 vetatool",
  "patch_goal": {
    "minimum": 30
  }
}
```

此时即使模型提前输出 `<TASK_STATUS>DONE</TASK_STATUS>`，只要 `task_patch_count < 30`，Runner 仍会继续当前 Task。

如果做到 21 个 Patch 后达到 Context Limit：

```json
{
  "terminal_status": "context_limit",
  "code": "CHAT_LENGTH_LIMIT",
  "task_patch_count": 21,
  "patch_goal": { "minimum": 30 }
}
```

当前 Task 结束；插件不会创建第二个 Project。

## Session 与 Patch 文件名

新建 Task Project 时会建立一个 `session_id`，例如：

```text
session_id = faf42343242
```

项目约束要求该 Task 的 Patch 使用当前 Session：

```text
patch-faf42343242-001.patch
patch-faf42343242-002.patch
patch-faf42343242-003.patch
...
```

由于一个 Task 只有一个 Session，不存在 Task 内跨 Session 编号问题。

## 自动 Patch 下载

附件参考项目只复用了“自动下载”思路：

1. 只扫描最新 Assistant 回复中的 Patch 下载控件。
2. 控件有 URL 时可直接 `chrome.downloads.download()`。
3. 没 URL 时真实点击页面下载控件。
4. 用 `tabId + 时间窗口 + .patch + current session_id` 将 Chrome 下载与当前触发动作关联。
5. 监听 `chrome.downloads.onChanged`，只有状态到 `complete` 后才计入 `task_patch_count`。
6. Chrome 下载完成后先经过 `ArtifactTransferManager`；local 模式校验最终 `download_id / filename / local_path`。
7. remote transport 已支持由可信文件读取层提供 `content_base64 + size_bytes` 后，经 Task API `/tasks/{task_id}/artifacts/upload` 上传；网络/429/5xx 使用同一 payload/idempotency key 有界重试。
8. 只有 transfer receipt 成功后才增加 `task_patch_count` 并上报 artifact metadata；remote Patch bytes 会在 metadata 上报前剥离，通过 Patch key/文件名去重。

详见 `PATCH_DOWNLOAD.md`。

## 当前实现状态

已经实现并有自动测试覆盖：

- Task schema / `patch_goal.minimum`。
- Mock Task API 和真实 HTTP Task API client。
- `/tasks/claim` 的 Task + lease wire contract，以及 `X-Task-Protocol-Version: 1`。
- Task scoped API 自动携带 lease token；heartbeat 根据服务端 TTL 自适应调度并支持 lease token 轮换。
- activeExecution 持久化规范化 Task snapshot + 最新 lease；heartbeat token/TTL 轮换会同步写回 TaskStore。
- Crash Recovery：Service Worker 启动会在 real 模式且存在 `activeExecution` 时自动触发安全恢复；恢复前先 heartbeat 验证 lease。RUNNING 使用 durable `in_flight_round` + 当前 ChatGPT 页面事实核对来安全区分 Prompt 未发送、已发送生成中、回复已完成未落盘，并在证据充分时自动续跑；歧义状态 fail closed。CLEANUP 只继续删除与原终态。
- Project 删除后、terminal API 确认前使用 durable `TERMINAL_PENDING + terminal_action + terminal_payload`；响应丢失时恢复流程用完全相同 payload 幂等重试。
- progress/artifact/terminal 写请求使用 canonical payload 生成稳定 `Idempotency-Key`。
- 单 Task Project 生命周期状态模型。
- 多轮对话 TaskRunner。
- `task_patch_count` 与 Patch 去重。
- `READY → GENERATING → READY` 模型状态判断。
- Context Limit 终止语义。
- Patch 自动下载管理与 Chrome download 事件关联。
- M11 local artifact transfer：使用浏览器当前 Downloads 目的地，校验并上报最终 `download_id / filename / local_path / source_url`。
- M11 remote upload protocol：`RemoteArtifactTransport` 校验 Patch base64/大小，经 lease-scoped `/artifacts/upload` 上传，对 network/429/5xx 做有界指数退避；服务端 receipt 只保留 `artifact_id / filename / size_bytes / sha256?`，不持久化 Patch bytes 或服务端 URL。
- Patch 只有在 transfer 成功后才计数；计数状态先持久化，再调用 artifact metadata API。remote 端到端仍等待 Native Helper/安全文件读取层提供下载后的 Patch bytes，Options 中 remote 继续禁用。
- Finalize → Cleanup → 服务端终态顺序。
- Cleanup 失败时保持 locked 的 durable state。
- Mock fix、multi-round、patch-goal、context-limit 场景。
- ChatGPT Project “新建 → 设置 Instructions → 精确删除”的语义 DOM 自动化实现。
- Project 名称同小时冲突自动追加 `-02/-03...`。
- 12 位 Session ID 自动生成。
- Composer 对 `textarea` / `contenteditable` 的 Prompt 输入与 `data-testid`/aria/text 发送按钮定位。
- `Inspect UI` 诊断：只返回 button/input/dialog/menu/link 等控件元数据，不读取聊天正文。
- ChatGPT 页面访问守卫：识别 `/auth/login`/登录控件、challenge URL/title、Turnstile/CAPTCHA/challenge iframe/form/testid；除 diagnostics/access-state 外的自动化命令统一抛出 `LOGIN_OR_CHALLENGE_REQUIRED`，不尝试绕过验证。
- Selector registry versioning：当前所有 Project/Composer/Access Guard 语义 selector 统一读取 `chatgpt-semantic-v1`；diagnostics/status 只暴露 `{id, version}`，未知 profile 直接 `UI_SELECTOR_INCOMPATIBLE`。
- Privacy-safe error DOM diagnostics：真实 ChatGPT 自动化失败时附带 `error_code / selector profile / access state / sanitized pathname / title category / control fingerprints`；不采集聊天正文、Project 名、附件名、URL query/hash 或任意页面标题，且本版本明确不截图。
- UI compatibility telemetry：真实页面的 `UI_SELECTOR_INCOMPATIBLE / LOGIN_OR_CHALLENGE_REQUIRED` 会在 background 仅以 `selector profile + operation + error_code + access status + page category + count` 聚合到 `chrome.storage.local`；不持久化 DOM fingerprints、自由文本或 URL，不远程上传。Popup 仅展示总事件数和最近一条兼容错误摘要。
- 当没有 `chatgpt.com` tab、但存在 `auth.openai.com` 登录 tab 时，TabManager 也返回 `LOGIN_OR_CHALLENGE_REQUIRED`，而不是误报 Project 不存在。
- Popup 运行态面板：结构化展示 mode / runner / active Task / phase / round / Patch count / Patch goal / Project / Session / in-flight stage / lease TTL / last recovery；状态投影不会返回 Prompt、Project constraints、resource URL、Task API token 或 lease token。
- Task `resource.url` HTTP(S) 校验、background 下载、文件名/大小/MIME 校验与 base64 传输。
- Composer 将资源注入唯一 `input[type=file]`，等待附件名称出现且无 uploading/processing/progress 状态后继续。
- `initialization_prompt` 在正式 `task_prompt` 前单独执行，且不增加 `task_round_count`；完成状态单独持久化，初始化未确认完成时 Recovery 不猜测。
- 每个工作 round 依次持久化 `READY_TO_SEND → PROMPT_SENT → RESPONSE_READY`；只有 response-ready 的 Patch/状态处理全部完成后才原子清 checkpoint 并增加 `task_round_count`。

**已实现但仍需在真实 ChatGPT 当前页面校准：**

- 登录失效/挑战页 guard 的当前 ChatGPT/OpenAI 文案与 challenge DOM 表现；当前实现只阻断，不自动处理 CAPTCHA/安全挑战。
- “New project / 新建项目 / 新規プロジェクト”入口的当前 DOM 表现。
- Project options → Project settings → Instructions → Save 的当前 DOM 表现。
- Task-owned Project 行附近菜单 → Delete project → 确认弹窗的当前 DOM 表现。
- Context Limit 的当前文案/DOM。
- Patch 卡片/下载按钮的当前 DOM。

**已实现但仍需在真实 ChatGPT 当前页面/权限环境校准：**

- `resource.url` 所在域名必须已授予扩展 host access；未授权/网络失败会以 `RESOURCE_DOWNLOAD_FAILED` fail closed。
- 当前资源原始大小默认上限为 32 MiB；通过 background 下载后以 base64 消息传给 content script。
- `input[type=file]` 唯一定位、附件文件名出现、uploading/processing/progress 消失的当前 DOM 表现。
- `initialization_prompt` 的真实 `READY → GENERATING → READY` 行为。

**下一阶段尚未实现：**

- Patch 文件远程 API 的完整文件读取/上传链路（local 模式已完成）。
- 资源初始化本身的 in-flight 附件/Prompt 恢复；当前只有 `initialization_completed=true` 才允许自动进入工作 round，未确认完成时保持 `recovery_blocked`。

真实 UI 定位统一采用 **fail-closed**：只有唯一语义候选才会执行；不使用 hash CSS class、固定坐标或模糊猜测。第一次在真实页面校准时可在 Popup 点 `Inspect UI` 获取非聊天正文的控件诊断。

## Mock 模式

`mock/tasks.json` 提供代表性场景：

- `mock-fix-001`
- `mock-resource-init`
- `mock-feature-multi-round`
- `mock-seo-min-3`
- `mock-context-limit`
- Patch 去重/多 Patch 等基础样例

运行测试：

```bash
npm test
```

## 目录

```text
src/
├── background/
│   ├── task-runner.js
│   ├── task-api.js
│   ├── mock-task-api.js
│   ├── task-store.js
│   ├── browser-page-driver.js
│   ├── mock-page-driver.js
│   ├── patch-download-manager.js
│   └── chrome-patch-processor.js
├── content/
│   ├── content-script.js
│   ├── chatgpt-adapter.js
│   ├── project-manager.js
│   ├── conversation-manager.js
│   ├── composer.js
│   └── artifact-observer.js
├── shared/
│   ├── task-schema.js
│   ├── execution-state.js
│   ├── status-protocol.js
│   ├── patch-identity.js
│   └── project-naming.js
└── ui/

tests/
mock/
docs/superpowers/
```

## 下一步

开发优先级以 `TODO.md` 为准。当前最优先的是：

```text
1. 在真实 chatgpt.com 上运行 Inspect UI，校准 M6/M7/M8/M9 与登录/challenge guard 的当前语义标签
2. 给真实 `resource.url` 域名授予扩展 host access，跑一次资源下载/附件 ready 流程
3. 校准 initialization_prompt、Context Limit、登录失效与 challenge 页面表现
4. 接入 Native Helper/安全文件读取层，把 Chrome 完成下载的 Patch bytes 提供给已实现的 M11 remote upload transport；错误截图仍需先完成 opt-in + redaction 设计
```
