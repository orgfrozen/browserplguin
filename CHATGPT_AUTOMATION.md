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

`Upload resource` 已实现为 fail-closed 语义流程：background 下载并校验 HTTP(S) 资源，content script 只在唯一 file input 可确定时注入 `File`，等待附件文件名出现且无 uploading/processing/progress 后才发送 `initialization_prompt`。该流程仍需在真实 ChatGPT 当前版本校准 file input 与附件卡片 DOM；资源域名必须已授予扩展 host access。

Popup 的 `Inspect UI` 会返回非敏感控件元数据，帮助校准真实页面；它不会读取聊天正文。

## 登录失效 / Challenge Guard

content script 对实际自动化命令统一做 access guard。只使用 URL/title 和可见 UI 控件语义，不扫描聊天正文。当前识别：

- `chatgpt.com/auth/login`、`/login` 等登录路径；
- 无 composer 时的可见 Log in/Sign in/登录/ログイン 控件；
- `/cdn-cgi/challenge-platform/`、`Just a moment...`、security verification/verify-human 类标题；
- Turnstile/CAPTCHA/challenge iframe、form、testid 或明确 verify-human 控件；
- 没有 ChatGPT tab 但存在 `auth.openai.com` 登录 tab。

命中后抛出 `LOGIN_OR_CHALLENGE_REQUIRED`，不会自动点击登录或绕过 CAPTCHA/安全验证。`Inspect UI` 与 `CHATGPT_ACCESS_STATE` 保持可用，人工完成验证后可继续任务恢复。
