# ChatGPT Automation Contract

## 正常路径

浏览器已经登录 `chatgpt.com` 且未处于安全挑战页后，Runner 目标流程为：

```text
claim Task
→ create a fresh temporary Project
→ set Project Instructions
→ download task resource package
→ upload resource package
→ send initialization prompt
→ send task prompt
→ multi-round execution
→ download Patch artifacts
→ terminal
→ delete temporary Project
```

## 一个 Task 只操作一个 Project

Task 正常执行时不扫描历史业务 Project，也不寻找“上一次聊天”。

项目名称由 `project_id + 时间` 生成，例如：

```text
vetatool2026081315
```

如果出现同小时命名冲突，可追加：

```text
vetatool2026081315-02
```

## Project Instructions

Task 创建时设置：

- 服务端给出的 `project_constraints`；
- 当前 `session_id`；
- Patch 文件命名约束；
- Patch 从 `001` 开始；
- Task status marker 规则；
- Context Limit 时不续接当前 Task。

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
→ DELETE Project
→ report CHAT_LENGTH_LIMIT
```

插件不新建第二个 Project。

## 恢复路径

Chrome/Service Worker 中断后，恢复只允许精确打开 durable state 记录的临时 Project。v0.9.0 的工作 round 使用：

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

- Create Project
- Set Project Instructions
- Task resource 下载/文件输入注入/附件 ready 等待
- initialization_prompt 输入/发送与回复等待
- Prompt 输入/发送
- Delete exact Task-owned Project

这些动作仍需要在真实 ChatGPT 当前版本做 live calibration。定位规则为：稳定属性/role/aria → 多语言语义 → 精确结构关系；只要候选不唯一或目标不存在就停止。

上述定位规则当前统一由 selector registry profile `chatgpt-semantic-v1`（version `1`）提供。当前 profile 只把既有 selector/pattern 集中管理，不改变任何匹配顺序；未来 UI 版本差异通过新增 profile 处理。未知 profile 不回退、不猜测，直接 `UI_SELECTOR_INCOMPATIBLE`。

`Upload resource` 已实现为 fail-closed 语义流程：background 先对 `resource.url` 做 exact-origin runtime host permission 检查，再下载并校验 HTTP(S) 资源；content script 只在唯一 file input 可确定时注入 `File`，等待附件文件名出现且无 uploading/processing/progress 后才发送 `initialization_prompt`。Options 提供按 URL 检测/授权/撤销 Resource Host Access；Background 本身不自动请求权限。该流程仍需在真实 ChatGPT 当前版本校准 file input 与附件卡片 DOM，并跑真实资源 E2E。

Popup 的 `Inspect UI` 会返回非敏感控件元数据，帮助校准真实页面；它不会读取聊天正文。`Run UI Calibration` 则提供更严格的只读矩阵，只返回固定检查项的 pass/unavailable/incompatible 与安全计数，不执行任何 ChatGPT UI 写操作。

每次 `Run UI Calibration` 成功后，Background 还会写入本地 Calibration Evidence Ledger。持久化层不会复制矩阵 `evidence`，只记录固定 surface/status/profile/page/access/time 与聚合计数，并将 recent runs 限制为 20 条。Popup 显示最近状态和 `pass/total`，也可显式清空；该 ledger 不上传远程，也不代表真实 DOM calibration 已通过。

在此基础上，Popup 的 Calibration Coverage 只针对当前仍待 live calibration 的六个 selector surface 计算 `missing pass / covered / needs review`。六项全部 covered 时才显示 `ready for review`；这只是 handoff gate，不会自动勾选真实校准 TODO。`Download safe report` 导出的 JSON 只包含固定枚举/计数和 selector profile，不包含矩阵 evidence 或页面自由文本。

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
