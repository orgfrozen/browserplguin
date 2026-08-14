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
RESOURCE_HOST_PERMISSION      ← exact-origin runtime gate 已实现
   ↓
DOWNLOAD_RESOURCE             ← 已实现，待真实下载/上传 E2E
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
COMPLETE / CONTEXT_LIMIT / FAIL / RELEASE
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

当前 Task 结束；插件不会创建第二个 Project。v0.18.0 起，Cleanup 完成后客户端调用专用 `POST /tasks/{task_id}/context-limit`，服务端可把它记录为独立 `context_limit` 终态；旧版本已经持久化的 `FAIL + terminal_status=context_limit` 仍按原 `/fail` endpoint exact retry。

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
7. remote transport 已支持经 Task API `/tasks/{task_id}/artifacts/upload` 上传；v0.16.0 新增 `NativePatchFileReader` + Native Messaging Host，从 Chrome 最终 `local_path` 安全读取 `.patch`，按 `BEGIN/CHUNK/END` 分块返回 bytes，扩展重组并重新计算 SHA-256 后再进入 remote upload；v0.17.0 增加 macOS/Linux Host 安装注册脚本与 `PING/PONG` readiness 检测；网络/429/5xx 使用同一 payload/idempotency key 有界重试。
8. 只有 transfer receipt 成功后才增加 `task_patch_count` 并上报 artifact metadata；remote Patch bytes 会在 metadata 上报前剥离，通过 Patch key/文件名去重。

详见 `PATCH_DOWNLOAD.md`。


## Native Helper 安装（remote 前置）

当前 remote 仍未开放，但 Host 安装/协议 readiness 已可独立验证。先在扩展 Options 页面复制当前 **Extension ID**，然后在项目根目录执行：

```bash
node native-host/install-native-host.mjs \
  --extension-id <你的32位Extension ID> \
  --browser chrome
```

如果 Chrome 的下载目录不是 `~/Downloads`，显式传入：

```bash
node native-host/install-native-host.mjs \
  --extension-id <你的32位Extension ID> \
  --browser chrome \
  --downloads-dir "/absolute/path/to/Downloads"
```

支持 `chrome`、`chromium`、`chrome-for-testing`，安装脚本目前面向 macOS/Linux user-level Native Messaging Host 注册。它会把 Host 复制到稳定用户目录，生成绑定绝对 Node 路径和 Downloads root 的 launcher，并把 `allowed_origins` 精确设置成当前 Extension ID；不会写 wildcard。安装后 reload 扩展，在 Options 点击 **检测 Native Helper**。`ready` 只代表 Host manifest/进程/协议可用，**不会修改 `patchTransferMode`，也不会自动启用 remote**。

在 Options 还可以运行 **Remote E2E Preflight**。它只检查 `mode=real`、Task API URL/当前 host permission、manifest `nativeMessaging`、Helper live PING 和 reader capabilities；不会 claim Task、读取 Patch、上传 artifact 或修改 transfer mode。只有 preflight 显示 ready，才表示环境前置条件齐全，可以进入真实 remote E2E。真实 E2E 未完成前 remote 仍保持 disabled。

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
- Context Limit 终止语义：专用 `/tasks/{task_id}/context-limit` 终态、durable `CONTEXT_LIMIT` action、旧 FAIL checkpoint 兼容恢复；Popup `Last Run` 可直接看到 `context_limit · task_id · CHAT_LENGTH_LIMIT`。
- Patch 自动下载管理与 Chrome download 事件关联。
- M11 local artifact transfer：使用浏览器当前 Downloads 目的地，校验并上报最终 `download_id / filename / local_path / source_url`。
- M11 remote reader：`NativePatchFileReader` 通过 `runtime.connectNative()` 调用 `com.browserplguin.patch_reader`；Host 仅允许 Downloads root 内普通 `.patch` 文件，拒绝路径逃逸/符号链接/超限文件，并以分块 Native Messaging 返回 bytes + SHA-256。v0.17.0 已加入 macOS/Linux user-level 安装注册脚本，并要求精确绑定当前 Extension ID。
- M11 remote upload protocol：`RemoteArtifactTransport` 校验 Patch base64/大小，经 lease-scoped `/artifacts/upload` 上传，对 network/429/5xx 做有界指数退避；服务端 receipt 只保留 `artifact_id / filename / size_bytes / sha256?`，不持久化 Patch bytes 或服务端 URL。
- Patch 只有在 transfer 成功后才计数；计数状态先持久化，再调用 artifact metadata API。Options 可显示当前 Extension ID、执行 Native Helper `PING/PONG` readiness，并运行无副作用 Remote E2E Preflight；preflight 只返回环境检查布尔值/稳定 blocker code，不持久化 Task API URL/token/Extension ID/native error。真实 remote 端到端尚未完成，因此默认仍保持 local；v0.26.0 只有在本机已有 passed Remote E2E Evidence 且 fresh preflight ready 时，才允许显式 promotion 到 production remote。
- v0.25.0 增加 Remote E2E Evidence Recorder：真实 remote test-mode runner 通过 TaskRunner best-effort observer 见证 remote transfer、artifact report、Cleanup 和 terminal success；只有同一次执行完整见证且最终 `completed` 才累计 `passed`。证据只保存在 `chrome.storage.local`，只含固定阶段枚举/计数，不保存 Task/Project/Session、URL、文件名/路径、Patch bytes、receipt 或 Token；记录失败不会改变 Task 结果，且不会自动开放正式 remote。
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
- Task `resource.url` HTTP(S) 校验、exact-origin runtime host permission gate、background 下载、文件名/大小/MIME 校验与 base64 传输。
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

- `resource.url` 所在域名必须已显式授予 exact-origin host access；Options 可按 URL 检测/授权/撤销，Background 下载前再次 `permissions.contains()`。未授权或权限检查异常以 `RESOURCE_HOST_PERMISSION_REQUIRED` fail closed，且在 fetch 前终止。
- 当前资源原始大小默认上限为 32 MiB；通过 background 下载后以 base64 消息传给 content script。
- `input[type=file]` 唯一定位、附件文件名出现、uploading/processing/progress 消失的当前 DOM 表现。
- `initialization_prompt` 的真实 `READY → GENERATING → READY` 行为。

**下一阶段尚未实现：**

- 使用已安装 Helper + 真实 Task API 完成 remote Patch 端到端回归，并在通过后正式开放 Options remote。
- 资源初始化本身的 in-flight 附件/Prompt 恢复；当前只有 `initialization_completed=true` 才允许自动进入工作 round，未确认完成时保持 `recovery_blocked`。

真实 UI 定位统一采用 **fail-closed**：只有唯一语义候选才会执行；不使用 hash CSS class、固定坐标或模糊猜测。第一次在真实页面校准时可在 Popup 点 `Inspect UI` 获取非聊天正文的控件诊断，也可以点 `Run UI Calibration` 运行只读矩阵，直接区分 `pass / unavailable / incompatible`。

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
2. 在 Options 给真实 `resource.url` exact origin 授权，跑一次资源下载/附件 ready 真实流程
3. 校准 initialization_prompt、Context Limit、登录失效与 challenge 页面表现
4. 用真实 Chrome 产生 Calibration / Resource E2E / Remote E2E 证据并导出 validation handoff；错误截图 policy v1 已设计，但实际截图采集仍保持禁用
```

## Resource Host Access（v0.22.0）

Task 资源使用运行时可选 host permission，而不是把任意资源域名放进 required `host_permissions`。Options 的 `Resource Host Access` 区域允许输入真实资源 URL，并只对其 scheme + host 生成精确 pattern（例如 `https://assets.example.com/*`）执行检测、授权或撤销。完整 path/query/hash 不进入授权状态。

真实 Task 下载前 `ResourceLoader` 会再次检查该 exact origin。权限缺失、Permissions API 不可用或检查异常都会在网络请求之前以 `RESOURCE_HOST_PERMISSION_REQUIRED` fail closed；Background 不会自动请求权限。真实资源下载→ChatGPT 附件 ready 的 E2E 仍需在真实 Chrome 上验证。

## Calibration Evidence Ledger（v0.23.0）

每次 Popup 运行 `Run UI Calibration` 成功后，Background 会把矩阵结果投影成 privacy-safe 本地证据并写入 `chrome.storage.local`。Evidence Ledger 保存固定 surface id、`pass / unavailable / incompatible`、selector profile id/version、page category、access status、时间戳、聚合计数，以及每个 surface 最近最多 3 个 privacy-safe 结构 fingerprints；除该白名单结构外，矩阵里的自由 `evidence` 不会被持久化。

Popup 的 `Calibration Evidence` 区域展示总运行次数，以及每个 surface 的最近状态和 `pass/total`。Recent runs 最多保留 20 条，长期覆盖度使用聚合计数；可以显式点击“清空本地校准证据”只删除该 ledger。该证据不会上传服务端，也不会包含 DOM 文本、聊天/Project/Prompt、URL、文件名、Token、Extension ID 或本地路径。

## Calibration Coverage Gate / Safe Handoff Report（v0.24.0）

Popup 现在会把 Evidence Ledger 投影成六个仍待真实校准的 selector surface：`context_limit`、`patch_candidates`、`project_create`、`project_settings`、`resource_input`、`project_delete`。只有出现过 `pass` 才算有覆盖；历史 pass 后当前页面 `unavailable` 仍保留覆盖；如果最新状态是 `incompatible`，即使历史 pass 也会标记 `needs review`。六项全部 `covered` 才显示 `ready for review`，但不会自动修改 `TODO.md`。

`Download safe report` 会下载本地 JSON handoff report。报告只包含固定 surface、selector profile、page category、时间戳、聚合计数和最近 privacy-safe 结构 fingerprints，不包含其它 recent matrix evidence、DOM/聊天正文、Project/Prompt、resource URL、文件名、Token、Extension ID 或本地路径。

Evidence Ledger 只负责积累真实页面证据，**不会自动把任何 live-calibration TODO 标完成**；只有实际 Chrome 页面跑出的证据经过确认后，才更新 M4/M5/M6/M7/M8/M9。

## Live UI Calibration Matrix（v0.21.0）

Popup 提供 `Run UI Calibration`，用于真实 ChatGPT 页面校准。它只读取当前 DOM，不点击、不创建/删除 Project、不发送 Prompt、不上传文件、不下载 Patch。

矩阵固定检查：access、composer、model state、latest assistant、Patch candidates、Context Limit、Project create/settings/delete 入口和 resource file input。每项只有三种结果：`pass` 表示当前页面可唯一识别；`unavailable` 表示当前页面状态没有暴露该临时 UI；`incompatible` 表示结构歧义或无法安全唯一解释。

返回结果不包含聊天正文、Project 名、Prompt、附件名、URL query/hash、API/lease token 或原始 DOM 自由文本。因此这个工具可以用于真实页面 selector 校准，但它本身不代表 M4/M5/M6/M7/M8/M9 的真实校准已经完成。

## Remote E2E 测试模式（v0.20.0）

Remote 仍未作为普通生产选项开放。为了在真实 Chrome 环境安全完成第一条 remote 全链回归，Options 提供独立的 **Remote E2E 测试模式**：

1. 先保存 real mode / Task API 配置并授予对应 host permission。
2. 运行 `Remote E2E Preflight`。
3. 显式点击“启用 Remote E2E 测试模式”；启用动作会再次执行 live preflight，只有当前全部 ready 才会把 `patchTransferMode` 临时切到 `remote`。
4. 每次 `Run Real Once` 都会在 Task claim 之前重新执行 live preflight；任何权限、Helper、capability 或 API 配置变化都会 fail-closed，且不会领取 Task。
5. 点击“关闭并恢复 local”会原子退出测试模式。普通“保存设置”同样会自动退出测试模式并恢复 `local`，因此配置变化必须重新 preflight + 显式启用。

正式 remote 不会自动开放。v0.26.0 增加 **Remote Production Promotion Gate**：只有本机 Evidence Ledger 已有至少一次 `passed`，用户显式点击 promotion，且当场 live preflight ready，才持久化 `remoteProductionMode=true + patchTransferMode=remote`。之后每次 `Run Real Once` 在 claim 前仍重新检查 Evidence 和 preflight；清空 Evidence 或环境变化会阻止新的 production remote claim。Recovery 不经过 promotion gate，以免已领取 Task 被配置变化卡死。

## Resource E2E Evidence (v0.27.0)

真实 `resource.url` Task 现在会在本机记录 privacy-safe 资源初始化证据。`passed` 只在同一次 real runner invocation 依次见证 background resource 下载完成、ChatGPT attachment ready、初始化回复完成，以及 durable `initialization_completed` + `TASK_INITIALIZED` 上报成功后产生。权限/下载/附件/初始化 Prompt/初始化状态持久化失败分别归类到固定 failure stage；Recovery 不推断未亲眼见证的历史成功。Popup 只显示 runs/passed/latest/stage，证据不保存 resource URL/origin、文件名、文件内容、Prompt、Task/Project/Session 标识或 Token。真实 Chrome 的 resource E2E TODO 仍需现场产生 `passed` Evidence 后才能关闭。
## Production Readiness Gate（v0.28.0）

Popup 新增只读的 `Production Readiness` 汇总。它不创建新证据，而是实时汇总现有六项 Live Calibration Coverage、Resource E2E Evidence、Remote E2E Evidence、Remote Production 状态，并重新执行一次无副作用 Remote E2E Preflight。只有六项 selector 已有可复核 pass、Resource/Remote 各至少一次 `passed`、正式 remote 已显式 promotion、且当前 preflight 仍 ready，才显示 `ready for release review`。

Readiness 报告只包含固定 blocker code、布尔值、聚合计数和时间戳；不包含 recent runs、DOM/聊天内容、Task/Project/Session 标识、URL、文件名/路径、Prompt、Patch bytes、Token 或 lease。`Download safe release report` 只下载这份白名单对象。该 gate 不自动修改 TODO，也不会 claim Task；错误截图仍是可选策略而非 release 硬门槛。

## Safe Validation Handoff Bundle（v0.29.0）

Popup 的 `Download validation handoff` 会把现有 Live Calibration Coverage、Resource E2E Evidence、Remote E2E Evidence、Remote Production、fresh Remote E2E Preflight 与 release 条件合并成一个本地 JSON。Bundle 自己重新计算 release-ready/blocker，不信任过期或被污染的 ready 标志，并给出唯一固定 `next_action`：`CALIBRATE_UI / RUN_RESOURCE_E2E / FIX_REMOTE_PREFLIGHT / RUN_REMOTE_E2E / PROMOTE_REMOTE / RELEASE_REVIEW`。

Handoff 采用严格白名单，只包含六个固定 calibration surface 的安全 coverage/计数、selector profile id/version、固定 page/status enum、Resource/Remote 聚合计数与最近固定 result/stage、production/preflight 布尔值和 allowlist blocker。它不包含 recent raw runs、DOM/聊天文本、Task/Project/Session、URL、文件名/路径、Prompt/response、Patch bytes、receipt、Token、lease 或 raw error，也不会上传、修改设置、claim Task 或自动勾选真实 TODO。

## Diagnostic Screenshot Safety Policy（v0.30.0）

错误截图仍然**没有实现，也不会自动采集**。本版本只把未来截图功能必须遵守的隐私边界固化为 `diagnostic-screenshot-policy`：`capture_enabled=false`，任何未来实现都必须显式 opt-in，只允许 `UI_SELECTOR_INCOMPATIBLE` 且页面为 `READY/chat`，只允许固定语义控件区域与 `solid_mask` redaction。整页截图、自由坐标、OCR、文本提取、持久化、导出和上传在 policy v1 中全部禁止。Options 只读显示该策略，不提供 consent 开关，也不调用任何截图 API。

## Selector Calibration Fingerprints（v0.31.0）

Live Calibration Matrix 现在会为候选控件附带最多 3 个 privacy-safe 结构 fingerprints，用于真实 ChatGPT 页面出现 `unavailable / incompatible` 后直接修 selector，而无需导出 DOM 或截图。Fingerprint 只允许 `tag / role / type`、固定 `data-testid/name` 类别、固定 semantic hint，以及最多 3 层 ancestor role/tag category；`data-testid/name` 原值本身不会导出。

Matrix → Calibration Evidence Ledger → Calibration Coverage → Safe Validation Handoff 四层都会重新执行白名单投影。禁止进入 fingerprint/handoff 的内容包括 textContent、aria-label/title/placeholder/value、href/hostname/path/query、Project/Task/Session 标识、resource/Patch/附件文件名、CSS/XPath/HTML/class/style/dataset、Token、raw error、截图/OCR/图片数据。该工具只让真实 selector 校准证据更可操作，不修改 selector，也不会自动关闭任何 live TODO。

## Guided Live Calibration Campaign（v0.32.0）

Popup 现在把六个仍需真实 ChatGPT 校准的 selector surface 组织成固定只读 campaign：`project_create → project_settings → resource_input → patch_candidates → context_limit → project_delete`。Campaign 完全从现有 Calibration Evidence Ledger 即时推导，不增加新的持久化状态；historical pass 且最新不是 `incompatible` 才视为 `observed`，最新 `incompatible` 会停在 `needs_review`，否则保持 `pending`。

`Capture current state` 复用现有 `RUN_CHATGPT_CALIBRATION`，只读取当前 DOM 并写入既有脱敏 Evidence；不会自动点击、导航、创建/删除 Project、发送 Prompt 或上传文件。人类提示来自固定 `instruction_code` 本地映射，campaign 输出只含固定 surface/page/status/instruction 枚举、计数和 fingerprint 数量，不带 DOM/聊天/Project/URL/文件自由文本。Campaign complete 只表示六项都有可复核 live pass 证据，不会自动完成 TODO。
