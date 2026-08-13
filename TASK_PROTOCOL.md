# Task Protocol

## 1. Claim Task

最小 Task：

```json
{
  "task_id": "task_fix_001",
  "project_id": "vetatool",
  "task_prompt": "修复 sitemap lastmod 问题"
}
```

带 Project 初始化信息：

```json
{
  "task_id": "task_fix_001",
  "project_id": "vetatool",
  "task_prompt": "修复 sitemap lastmod 问题",
  "project_constraints": "遵循现有架构，不做无关重构。",
  "resource": {
    "url": "https://example.com/vetatool-source.zip",
    "filename": "vetatool-source.zip"
  },
  "initialization_prompt": "分析一下这个项目，并从seo角度来计划一下怎么进行"
}
```


资源规则：

- `resource` 可选；存在时 `resource.url` 必须是绝对 HTTP(S) URL。
- `resource.filename` 可选；未提供时优先使用响应 `Content-Disposition`，再使用 URL 最后路径段。
- Background 下载使用 `credentials: omit`，不把页面 Cookie 带给资源服务器。
- 默认原始资源上限 32 MiB；HTTP 非 2xx、空文件、超限或文件名非法均以 `RESOURCE_DOWNLOAD_FAILED` 终止。
- 资源域名必须已授予扩展 host access。
- 资源附件 ready 后先发送 `initialization_prompt`；初始化回复不增加 `task_round_count`，之后才进入真正 `task_prompt`。

批量 Patch 目标：

```json
{
  "task_id": "vetatool-seo-20260813",
  "project_id": "vetatool",
  "task_prompt": "持续优化 SEO",
  "patch_goal": {
    "minimum": 30
  }
}
```

`patch_goal` 缺失或为 `null` 时，Patch 数量只统计，不作为完成条件。

## 2. Session

Runner 为该 Task 创建唯一临时 Project 和唯一 Session。

```json
{
  "project_name": "vetatool2026081315",
  "session_id": "faf42343242"
}
```

当前 Task 生命周期内不会创建第二个 Session。

## 3. Model Status Protocol

Project Instructions 要求模型在回复末尾提供：

```text
<TASK_STATUS>CONTINUE</TASK_STATUS>
<TASK_STATUS>DONE</TASK_STATUS>
<TASK_STATUS>BLOCKED</TASK_STATUS>
```

规则：

- `CONTINUE` → 下一轮。
- `DONE` + 无 patch goal → 可完成。
- `DONE` + `task_patch_count < patch_goal.minimum` → 继续。
- `DONE` + 已达到 patch goal → 可完成。
- `BLOCKED` → 当前执行停止，Finalize/Cleanup 后 release。
- 缺少状态标记 → 有界 fallback；超过阈值后 Finalize/Cleanup + release。

## 4. Progress Events

示例：

```json
{
  "type": "TASK_PROJECT_STARTED",
  "project_name": "vetatool2026081315",
  "session_id": "faf42343242"
}
```


初始化开始：

```json
{
  "type": "TASK_INITIALIZING",
  "resource_url": "https://example.com/vetatool-source.zip",
  "project_name": "vetatool2026081315"
}
```

初始化完成：

```json
{
  "type": "TASK_INITIALIZED",
  "project_name": "vetatool2026081315"
}
```

```json
{
  "type": "ROUND_COMPLETED",
  "task_round_count": 8,
  "task_patch_count": 5,
  "task_status": "CONTINUE"
}
```

Context Limit：

```json
{
  "type": "TASK_CONTEXT_LIMIT",
  "task_round_count": 18,
  "task_patch_count": 21,
  "patch_goal": { "minimum": 30 }
}
```

Finalize：

```json
{
  "type": "TASK_FINALIZING",
  "terminal_reason": "CHAT_LENGTH_LIMIT",
  "task_round_count": 18,
  "task_patch_count": 21
}
```

Cleanup：

```json
{
  "type": "TASK_PROJECT_DELETED",
  "project_name": "vetatool2026081315",
  "session_id": "faf42343242"
}
```

## 5. Terminal Results

成功：

```json
{
  "terminal_status": "success",
  "task_patch_count": 1,
  "task_round_count": 4,
  "session_id": "faf42343242",
  "project_name": "vetatool2026081315",
  "patch_goal": null
}
```

Context Limit：

```json
{
  "terminal_status": "context_limit",
  "code": "CHAT_LENGTH_LIMIT",
  "task_patch_count": 21,
  "task_round_count": 18,
  "session_id": "faf42343242",
  "project_name": "vetatool2026081315",
  "patch_goal": { "minimum": 30 }
}
```

这是终止但非成功。插件不会在同一个 Task 内续接；服务端可根据业务策略创建新 Task。

## 6. Lock Contract

服务端 claim 时加锁。

只有在：

```text
artifacts durable
+ final progress durable
+ temporary Project deleted
```

之后才能执行 `completeTask` / `failTask` / `releaseTask`。

Cleanup 失败则 Task 继续 locked。
