# ChatGPT Automation Contract

## 正常路径

浏览器已经登录 `chatgpt.com` 且未处于安全挑战页后，Runner 目标流程为：

```text
claim Task
→ capture workspace_mode (project | chat)
→ create one fresh temporary Workspace
   project: create Project → set Project Instructions → attach source/resource
   chat: New Chat → attach LLM_RULES.md → attach source ZIP
→ wait until every expected attachment is ready
→ send workspace initialization prompt
→ require exact `<INIT_STATUS>READY</INIT_STATUS>`
→ chat only: persist exact `/c/<conversation_id>` identity
→ send task prompt
→ multi-round execution
→ download Patch artifacts
→ terminal
→ delete exact Task-owned Project or Conversation
```

## 一个 Task 只操作一个 Workspace

Task 正常执行时不扫描历史业务 Project，也不寻找“上一次聊天”。默认模式可以随时修改，但已经 claim 的 Task 使用自己的 durable `workspace_mode` 到终态。

项目名称固定按 `project_id + _ewan_ + 本地时间到分钟` 生成，例如：

```text
vetatool_ewan_202608131530
```

如果出现同小时命名冲突，可追加：

```text
vetatool_ewan_202608131530-02
```

## Project Instructions

Task 创建时设置：

- 服务端给出的 `project_constraints`；
- 当前 `session_id`；
- Patch 文件命名约束；
- Patch 从 `001` 开始；
- Task status marker 规则；
- Context Limit 时不续接当前 Task。

## 普通 Chat 初始化

Chat mode 不创建 Project，也不把规则复制成第二份 Project Instructions。它在普通 New Chat 中按顺序上传当前 PatchSync Export 对应的 `LLM_RULES.md` 与 source ZIP；两个附件都确认 ready 后才发送 Chat 初始化 Prompt。初始化回复必须是 exact `<INIT_STATUS>READY</INIT_STATUS>`，随后立即捕获并 durable 保存 `/c/<conversation_id>`，只有 identity 保存成功后才允许发送正式 `task_prompt`。

恢复和 Cleanup 只使用该 exact conversation identity，不使用聊天标题、侧栏位置或“最近聊天”。

## 模型完成判断

一轮必须经过：

```text
READY
→ SEND
→ GENERATING
→ READY
→ assistant text stable
```

然后读取最后一条 Assistant 回复和其中的 Patch 控件。

## Context Limit

检测到 ChatGPT 提示聊天/上下文达到最大长度时：

```text
STOP current Task loop
→ preserve current patch_count / round_count
→ FINALIZING
→ DELETE exact Workspace
→ report CHAT_LENGTH_LIMIT
```

插件不新建第二个 Workspace。

## 恢复路径

Chrome/Service Worker 中断后，恢复只允许精确打开 durable state 记录的临时 Workspace：Project 用原 Project identity；Chat 用 `/c/<conversation_id>`。v0.9.0 的工作 round 使用：

```json
{
  "phase": "RUNNING",
  "initialization_completed": true,
  "in_flight_round": {
    "round_number": 4,
    "prompt": "继续当前任务...",
    "stage": "PROMPT_SENT",
    "assistant_text": null
  }
}
```

恢复先验证 lease，再把 checkpoint 与当前页面的 latest user / latest role / latest assistant / composer state 对账：

- `READY_TO_SEND`：页面证明尚未发送才发送；
- `PROMPT_SENT`：继续等待已经发送的 Prompt，不重发；
- `RESPONSE_READY`：直接继续 Patch/status 处理；
- 不能证明时 `recovery_blocked`。

完整 round 只有在 response、Patch 和 status 都持久化后才增加 `task_round_count` 并清除 checkpoint。资源初始化没有确认 `initialization_completed=true` 时仍禁止自动续跑。

## Semantic DOM 与 Fail-closed

当前已经实现语义自动化逻辑：

- Create Project / Prepare New Chat
- Set Project Instructions（Project mode）
- Attach `LLM_RULES.md` + source ZIP（Chat mode）
- Task resource 下载/文件输入注入/附件 ready 等待
- initialization_prompt 输入/发送与回复等待
- Prompt 输入/发送
- Reopen exact Task-owned Project/Conversation
- Delete exact Task-owned Project/Conversation

这些动作仍需要在真实 ChatGPT 当前版本做 live calibration。定位规则为：稳定属性/role/aria → 多语言语义 → 精确结构关系；只要候选不唯一或目标不存在就停止。

上述定位规则当前统一由 selector registry profile `chatgpt-semantic-v1`（version `1`）提供。当前 profile 只把既有 selector/pattern 集中管理，不改变任何匹配顺序；未来 UI 版本差异通过新增 profile 处理。未知 profile 不回退、不猜测，直接 `UI_SELECTOR_INCOMPATIBLE`。

`Upload resource` 已实现为 fail-closed 语义流程：background 先对 `resource.url` 做 exact-origin runtime host permission 检查，再下载并校验 HTTP(S) 资源；content script 只在唯一 file input 可确定时注入 `File`，等待附件文件名出现且无 uploading/processing/progress 后才发送 `initialization_prompt`。Options 提供按 URL 检测/授权/撤销 Resource Host Access；Background 本身不自动请求权限。该流程仍需在真实 ChatGPT 当前版本校准 file input 与附件卡片 DOM，并跑真实资源 E2E。

Popup 的 `Inspect UI` 会返回非敏感控件元数据，帮助校准真实页面；它不会读取聊天正文。`Run UI Calibration` 则提供更严格的只读矩阵，只返回固定检查项的 pass/unavailable/incompatible 与安全计数，不执行任何 ChatGPT UI 写操作。

每次 `Run UI Calibration` 成功后，Background 还会写入本地 Calibration Evidence Ledger。持久化层不会复制矩阵 `evidence`，只记录固定 surface/status/profile/page/access/time 与聚合计数，并将 recent runs 限制为 20 条。Popup 显示最近状态和 `pass/total`，也可显式清空；该 ledger 不上传远程，也不代表真实 DOM calibration 已通过。

在此基础上，Popup 的 Calibration Coverage 只针对当前仍待 live calibration 的八个 selector surface 计算 `missing pass / covered / needs review`。八项全部 covered 时才显示 `ready for review`；这只是 handoff gate，不会自动勾选真实校准 TODO。`Download safe report` 导出的 JSON 只包含固定枚举/计数和 selector profile，不包含矩阵 evidence 或页面自由文本。

Remote E2E test mode 还会启用独立的本地 Evidence Recorder。它通过 TaskRunner 非权威 observer 只见证四个成功阶段：remote transfer、artifact metadata report、Cleanup、terminal API。只有同一次 real runner 调用同时见证这些阶段并以 `COMPLETE/completed` 结束，才记为 `passed`；恢复流程不会根据历史 `task_patch_count` 猜测未亲眼见证的 upload/report，因此缺失前半链时只记 `incomplete/recovery`。Evidence 只保存固定阶段枚举、计数和时间戳，observer/ledger 错误不会反向影响 Task。

真实自动化命令失败时，content script 还会返回 privacy-safe error diagnostics。它与手动 Inspect UI 分离，策略更严格：URL 只保留 hostname + 脱敏 pathname，title 只保留 `chat/login/challenge/other/unknown` 类别，控件自由文本只映射为允许的语义 hint 或 `[redacted]`。不返回 textContent、聊天正文、Project 名、附件名、query/hash，也不采集截图。

Background 会把其中的 UI compatibility 失败进一步压缩为本地 telemetry：只聚合 selector profile、`CHATGPT_*` operation、兼容错误码、access status、page category、count 和时间戳；不保存 controls/fingerprints 或任何自由文本，也不发送远程 telemetry。

## 登录失效 / Challenge Guard

content script 对实际自动化命令统一做 access guard。只使用 URL/title 和可见 UI 控件语义，不扫描聊天正文。当前识别：

- `chatgpt.com/auth/login`、`/login` 等登录路径；
- 无 composer 时的可见 Log in/Sign in/登录/ログイン 控件；
- `/cdn-cgi/challenge-platform/`、`Just a moment...`、security verification/verify-human 类标题；
- Turnstile/CAPTCHA/challenge iframe、form、testid 或明确 verify-human 控件；
- 没有 ChatGPT tab 但存在 `auth.openai.com` 登录 tab。

命中后抛出 `LOGIN_OR_CHALLENGE_REQUIRED`，不会自动点击登录或绕过 CAPTCHA/安全验证。`Inspect UI` 与 `CHATGPT_ACCESS_STATE` 保持可用，人工完成验证后可继续任务恢复。

## Remote production promotion

v0.26.0 adds an explicit production promotion gate after the test-only Evidence Recorder. At least one local `passed` Remote E2E evidence run is required, but evidence alone never changes settings. The user must explicitly promote while a fresh live preflight is ready; every subsequent new real Task repeats evidence + preflight before claim. Test and production flags are mutually exclusive, ordinary settings saves return to local, and recovery remains ungated so an already-owned Task cannot be stranded.

## Resource E2E evidence

For a real Task with `resource.url`, the runner now records local evidence for the initialization path. A pass requires witnessed download success, ChatGPT attachment readiness, a non-context-limit initialization response, durable initialization checkpointing, and successful `TASK_INITIALIZED` progress reporting. The evidence path is observation-only and cannot change Task outcome. Use the Popup `Resource E2E Evidence` summary during live validation; the real DOM/E2E TODO remains open until actual Chrome evidence exists.
## Production Readiness Gate (v0.28.0)

真实环境收口现在统一由一个只读 release gate 汇总：

```text
Calibration Coverage 6/6 + no needs-review
+ Resource E2E passed >= 1
+ Remote E2E passed >= 1
+ remoteProductionMode enabled
+ fresh Remote E2E Preflight ready
→ ready_for_release_review
```

任一条件缺失只返回稳定 blocker code。该检查不操作 ChatGPT、不 claim Task、不修改设置/TODO；Popup 可下载只含固定枚举/计数/布尔值/时间戳的安全报告。

## Safe Validation Handoff Bundle (v0.29.0)

完成真实页面验证时，可在 Popup 下载单一 `validation-handoff-*.json`。Background 会现场读取 calibration coverage、Resource/Remote E2E evidence、production state，并重新执行 Remote E2E Preflight；Bundle 使用固定白名单重新计算 readiness/blocker，并给出一个固定 `next_action`，用于决定下一步是继续 UI 校准、跑 Resource E2E、修 preflight、跑 Remote E2E、promotion，还是进入 release review。

该文件只用于人工交接，不触发任何页面操作、Task claim、promotion 或上传；真实环境 TODO 仍需真实证据后人工关闭。

## Diagnostic Screenshot Safety Policy（v0.30.0）

当前错误诊断仍只返回结构化脱敏 DOM 信息，**不截图**。Policy v1 只定义未来截图能力的硬边界：必须由用户显式 opt-in；只允许 `UI_SELECTOR_INCOMPATIBLE` 且 access=`READY`、page=`chat`；只允许固定语义控件区域和 `solid_mask` redaction。整页、自由坐标、OCR、文本提取、持久化、导出、上传全部禁止。Options 仅展示 policy 状态，当前没有 consent 控件，也没有任何 capture API 调用。

## Selector Calibration Fingerprints（v0.31.0）

真实页面执行 `Run UI Calibration` 时，候选控件除了 status/count 外，会附带最多 3 个结构 fingerprints。结构只包含安全 tag/role/type、固定 semantic/machine-id category 和最多 3 层 ancestor category；不包含 text/aria/title/placeholder/value、URL、文件名、Project/Prompt、DOM HTML/class/style/dataset、Token、截图或 OCR。

Fingerprint 会沿现有 Matrix → Evidence Ledger → Coverage → Validation Handoff 传递，每一层都再次白名单化；同构候选会去重，但 `candidate_count` 保留原始歧义数量。它只用于后续 selector 校准，不触发页面写操作，也不代表真实 TODO 已完成。

## Guided Live Calibration Campaign（v0.32.0）

真实 UI 校准可按固定 campaign 顺序手动推进：New Chat → Project create → Project settings → Resource input → Patch candidates → Context limit → Conversation delete → Project delete。Popup 给出固定 manual step，并用 `Capture current state` 复用现有只读 Calibration Matrix。`needs_review` 会停在当前阶段；只有已有 pass 且最新不是 incompatible 才自动前进。Campaign 不点击页面、不导航、不创建/删除 Project、不发 Prompt、不上传文件，也不单独保存现场数据。

## Selector Calibration Delta Report（v0.33.0）

真实校准 handoff 现在把结构 fingerprints 与固定 v1 selector contract 做差异比较。硬结构缺失会返回 `NO_STRUCTURAL_CANDIDATE` 以及 tag/role/type mismatch；machine-id/semantic/ancestor 变化作为 soft delta；多个结构匹配返回 `MULTIPLE_STRUCTURAL_MATCHES`。

它不自动修改 selector，也不影响 Campaign/Readiness 的 pass 规则。真实页面校准仍必须人工完成；delta 只是让后续 Patch 能直接看到结构变化点。
## Selector Remediation Plan（v0.34.0）

真实校准 handoff 现在除 fingerprints 与 structural delta 外，还包含固定 remediation plan。`NO_FINGERPRINT_EVIDENCE / ROLE_MISMATCH / TYPE_MISMATCH / MACHINE_ID_CATEGORY_CHANGED / MULTIPLE_STRUCTURAL_MATCHES` 等 delta 会被映射为 `COLLECT_MORE_EVIDENCE / RETUNE_ROLE_FILTER / RETUNE_TYPE_FILTER / RETUNE_MACHINE_ID_FILTER / ADD_DISAMBIGUATION_CONTEXT` 等固定动作，并列出需要审查的现有 selector/pattern code-contract target。

Remediation Plan 仅诊断，不自动修改 ChatGPT selector，不输出 selector 文本，也不影响 readiness/campaign/TODO。
