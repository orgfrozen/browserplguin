# TODO

当前目标架构：

```text
1 Task = 1 temporary ChatGPT Project = 1 Session
```

Context Limit 直接终止当前 Task，不做 Project/Session 续接。

## M0：核心工程骨架 — 已完成

- [x] Manifest V3 extension skeleton。
- [x] Background service worker / content script / popup / options 基础文件。
- [x] Node built-in test runner。
- [x] Mock Task API。
- [x] HTTP Task API interface。
- [x] TaskStore durable state abstraction。

## M1：Task 数据与执行状态 — 已完成

- [x] Task schema：`task_id` / `project_id` / `task_prompt`。
- [x] 可选 `patch_goal.minimum`。
- [x] `task_round_count`。
- [x] `task_patch_count`。
- [x] `downloaded_patch_keys` 去重。
- [x] 单一 `task_project` 状态。
- [x] 移除 Task 内 Session/Project 轮换计数器。

## M2：TaskRunner 多轮调度 — 已完成核心逻辑

- [x] 每次 claim 正常路径创建新的 Task Project。
- [x] 普通 fix Task 不受 Patch 数量限制。
- [x] Patch goal 未达标时继续下一轮。
- [x] 模型 `CONTINUE / DONE / BLOCKED` 状态协议。
- [x] fallback 次数限制。
- [x] max task rounds 保险限制。
- [x] Context Limit 直接终止 Task。
- [x] 不创建第二个 Project/Session。

## M3：Finalize / Cleanup — 已完成核心逻辑

- [x] `FINALIZING` 状态。
- [x] `CLEANUP` 状态。
- [x] 删除 Task 唯一临时 Project 后才调用服务端终态。
- [x] Cleanup 失败保持 Task locked。
- [x] Cleanup error 持久化。
- [x] success → `completeTask`。
- [x] context limit → `failTask(CHAT_LENGTH_LIMIT)`。
- [x] blocked/protocol/max-round → cleanup 后 `releaseTask`。

## M4：模型状态监听 — 已完成核心逻辑

- [x] READY / GENERATING 分类。
- [x] 必须观察到 `READY → GENERATING → READY`。
- [x] Assistant 最后一条回复稳定检测。
- [x] Context Limit DOM 文本识别接口。
- [ ] 在真实 ChatGPT 当前版本校准 Context Limit 文案和 DOM 表现。

## M5：Patch 自动下载 — 已完成核心逻辑

- [x] 最新 Assistant Message Patch 发现。
- [x] 直接 URL 下载。
- [x] 真实点击 fallback。
- [x] `DownloadIntent`。
- [x] tab/time-window/session `.patch` 关联。
- [x] `downloads.onCreated` / `onChanged`。
- [x] complete 后才计数。
- [x] ambiguous fail-closed。
- [x] Patch 去重。
- [ ] 在真实 ChatGPT Patch 卡片/按钮上回归校准。

## M6：真实 ChatGPT Project 创建 — 语义实现完成，待 live calibration

- [x] 定位“New project / 新建项目 / 新規プロジェクト”入口。
- [x] 创建 Project。
- [x] 生成唯一 Project name。
- [x] 同小时重名自动追加 `-02/-03...`。
- [x] 建立 12 位 `session_id`。
- [x] 确认创建成功并记录实际 Project identity/url。
- [x] semantic fallback：stable attribute → role/aria/name → visible multilingual text。
- [x] selector 不确定/多候选时 fail-closed。
- [x] Popup `Inspect UI` 控件诊断。
- [ ] 在真实 ChatGPT 当前版本跑一次完整创建流程并校准差异。

## M7：Project Instructions — 语义实现完成，待 live calibration

- [x] 打开 Project options → Project settings。
- [x] 写入 `project_constraints`。
- [x] 写入 `session_id` Patch 命名规则。
- [x] 写入 `TASK_STATUS` 协议。
- [x] 写入 Context Limit 终止规则。
- [x] 保存并等待设置弹窗关闭。
- [ ] 在真实 ChatGPT 当前版本校准菜单/输入框/Save 语义。

## M8：任务资源包初始化 — 语义实现完成，待 live calibration

- [x] Task schema 校验 `resource.url` 为绝对 HTTP(S) URL。
- [x] Background `ResourceLoader` 下载资源包，使用 `credentials: omit`。
- [x] 校验 HTTP 状态/文件名/实际大小/MIME，默认原始资源上限 32 MiB。
- [x] 将资源编码为可序列化 payload 发送到 content script。
- [x] 将资源转换为 `File` 并注入唯一 `input[type=file]`。
- [x] 等待附件文件名出现且 uploading/processing/progress 状态消失。
- [x] 输入 `initialization_prompt` 并等待回复完成。
- [x] 初始化回复不计入 `task_round_count`，之后再发送真正 `task_prompt`。
- [x] 初始化阶段 Context Limit 直接终止 Task，工作 round 保持 0。
- [x] Mock resource initialization 场景。
- [ ] 在真实 ChatGPT 当前版本校准 file input / attachment card / progress DOM。
- [x] 实现 `resource.url` exact-origin runtime host permission gate：Options 显式检测/授权/撤销，Background fetch 前 fail-closed 检查。
- [ ] 在真实 Chrome 给实际 `resource.url` origin 授权，并完成一次资源下载 → ChatGPT 附件 ready 的端到端回归。

## M9：真实 Project 删除 — 语义实现完成，待 live calibration

- [x] 精确定位当前 Task 自己创建的 Project。
- [x] 只从精确 Project 附近寻找 menu/button。
- [x] 点击唯一 Delete Project action。
- [x] 处理唯一确认弹窗。
- [x] 验证 Project 已不存在。
- [x] 删除失败进入 `CLEANUP_PENDING`，不解锁 Task。
- [ ] 在真实 ChatGPT 当前版本校准 Project row/menu/confirmation DOM。

## M10：服务端真实 Task API — 客户端协议已固化

- [x] `/tasks/claim`：`204` 表示暂无任务；`200` 返回 `{ task, lease }`。
- [x] `lease.token` + `lease.ttl_ms` 校验并在 Task scoped API 中携带 `X-Task-Lease-Token`。
- [x] heartbeat 按 `min(configuredInterval, lease.ttl_ms / 3)` 调度，并接受服务端轮换后的新 lease。
- [x] 所有 API 请求携带 `X-Task-Protocol-Version: 1`。
- [x] progress event schema 固化。
- [x] progress / artifact / complete / context-limit / fail / release 使用 canonical payload 生成稳定 `Idempotency-Key`。
- [x] complete/context-limit/fail/release 成功后清除客户端 lease；请求失败时保留 lease 供重试。
- [x] `context_limit` 使用专用 `/tasks/{task_id}/context-limit` 终态，并在 Popup `Last Run` / active terminal metadata 中展示；旧 `FAIL + terminal_status=context_limit` checkpoint 保持原 endpoint 幂等恢复兼容。


## M11：Patch 文件传送

### local — 已完成

- [x] 下载目录策略：第一版固定使用浏览器当前 Downloads 目的地，不强制移动 click/direct 下载。
- [x] Chrome download `complete` 后校验最终 `download_id / filename / local_path`。
- [x] 上报最终文件名/路径/source URL 元数据和 `transfer_mode=local` receipt。
- [x] local transfer 成功后才计入 `task_patch_count`，并先持久化计数/去重状态再上报 artifact。

### remote — 上传/读取/Host 安装 readiness 已完成，真实 E2E/启用待完成

- [x] `POST /tasks/{task_id}/artifacts/upload` lease/idempotency 客户端协议。
- [x] `RemoteArtifactTransport` 校验 base64/size、remote receipt，并对 network/408/425/429/5xx 有界 retry/backoff。
- [x] remote upload receipt 成功后才计入 `task_patch_count`；Patch bytes 在 artifact metadata 上报前剥离，因此 Cleanup 不会早于已处理 Patch 的 remote transfer。
- [x] Native Messaging 文件读取方案：Host 只允许 canonical Downloads root 内普通 `.patch` 文件，拒绝路径逃逸/符号链接/非文件/超限；扩展使用 `connectNative()` 分块读取并重新校验 SHA-256。
- [x] 将文件读取层接入 `ChromePatchProcessor → ArtifactTransferManager → NativePatchFileReader → RemoteArtifactTransport`；Patch bytes 只在内存链路存在。
- [x] Native Messaging Host 安装/注册：macOS/Linux user-level installer 复制 Host 到稳定目录，生成绝对 Node launcher/manifest，精确绑定当前 Extension ID；Options 支持无文件读取的 PING/PONG readiness。Windows launcher/registry 如未来需要再补。
- [x] Remote E2E Preflight：无副作用检查 real mode、Task API URL/host permission、manifest nativeMessaging、Helper live readiness 和 32 MiB reader capabilities；只持久化 privacy-safe blocker codes，不 claim Task/读文件/上传/改模式。
- [x] Remote E2E 测试模式：只有显式 enable 且 live preflight ready 才临时切到 remote；每次新 real Task claim 前再次 live preflight，普通保存设置/显式关闭都会恢复 local；正式 remote 下拉项仍 disabled。
- [x] Remote E2E Evidence Recorder：仅在 real + remote test mode 下记录 privacy-safe 本地证据；只有同一次执行实际见证 remote transfer + artifact report + Cleanup + `COMPLETE` terminal 且 runner=`completed` 才记为 `passed`，observer/ledger 失败不影响 Task。
- [x] Remote Production Promotion Gate：只有本机 `Remote E2E Evidence.passed_runs >= 1` 且 promotion 时 fresh live preflight ready，才允许显式进入 `remoteProductionMode=true`；每次新 real Task claim 前再次检查 evidence + preflight，Test/Production flag 互斥，普通保存设置恢复 local，Recovery 不受新 claim gate 阻断。
- [ ] 在真实 Chrome 完成一次 remote 端到端回归并获得 `passed` Evidence；随后通过 Production Promotion Gate 显式提升为正式 remote。真实证据出现前不会自动 promotion。

## M12：Crash Recovery — 工作轮次安全自动续跑已完成

- [x] `activeExecution` 持久化 normalized `task_snapshot` + 当前 `lease`。
- [x] Heartbeat token/TTL 轮换后同步更新 TaskStore 中的 durable lease。
- [x] `HttpTaskApi.restoreLease()` 支持 Service Worker 重启后恢复内存 lease。
- [x] 显式 `RECOVER_REAL_TASK` / `RuntimeController.recoverReal()` 入口，不重新 claim Task。
- [x] Recovery 在任何 Project 操作前先 heartbeat 验证服务端 lease；失败则 `recovery_blocked`。
- [x] `phase=RUNNING` 只精确恢复记录中的唯一 `task_project` / Session，不创建 Project、不删除 Project；Prompt 行为必须由 durable checkpoint + 页面事实决定，禁止猜测性重发。
- [x] `phase=CLEANUP` 只恢复 Cleanup；删除成功后进入 durable `TERMINAL_PENDING`。
- [x] Terminal API 调用前持久化 `terminal_action + exact terminal_payload`；请求失败保持 locked 并记录 `terminal_error`。
- [x] `phase=TERMINAL_PENDING` 恢复不再操作 Project，只用完全相同 payload 幂等重试原 complete/fail/release。
- [x] 精确匹配 Project，禁止模糊猜测。
- [x] Service Worker 启动时自动检测 `activeExecution`；仅 real 模式进入现有 recovery policy，且消息处理等待 bootstrap 完成。
- [x] RUNNING 恢复成功后重新启动 lease heartbeat；activeExecution 未清除时拒绝新的 real claim。
- [x] RUNNING 使用 durable `in_flight_round`：`READY_TO_SEND / PROMPT_SENT / RESPONSE_READY`，安全区分“尚未发送 / 已发送生成中 / 回复已完成未持久化”。
- [x] Recovery 将 checkpoint 与页面 latest user/role/assistant/composer state 对账；证据充分时自动续跑，歧义时 `recovery_blocked`，禁止猜测性重发 Prompt。
- [x] `task_round_count` 仅在 response/Patch/status 全部持久化后原子递增并清除 `in_flight_round`。
- [x] 资源 Task 仅在 `initialization_completed=true` 时允许自动进入工作 round；初始化中断仍 fail closed。

## M13：真实页面兼容与观测

- [x] 基础 semantic selector registry/diagnostics。
- [x] Selector registry versioning / per-UI-version compatibility：当前 `chatgpt-semantic-v1` 统一承载现有 DOM selector 与多语言语义 pattern；未知 profile fail-closed。
- [x] Privacy-safe 错误 DOM diagnostics：失败响应附带 selector/access/page/control 结构快照；自由文本、Project/文件名、query/hash 均不采集。
- [ ] 错误截图：当前明确不采集；如后续需要，必须先设计 opt-in + redaction 策略。
- [x] UI version compatibility telemetry：仅本地聚合 selector profile / operation / error code / access status / page category / count；不持久化 DOM fingerprints，不远程上传。
- [x] 登录失效/挑战页识别：URL/title/可见登录控件/challenge iframe-form-testid 语义守卫；自动化命令统一 fail-closed，diagnostics/access-state 仍可用。
- [x] Popup 展示 privacy-safe active Task / phase / round / patch count / patch goal / Project / Session / in-flight stage / lease TTL / last recovery；不返回 Prompt/约束/resource URL/API token/lease token。
- [x] Live Calibration Matrix：Popup 一键只读检查 access/composer/model-state/latest-assistant/Patch/Context Limit/Project create-settings-delete/resource input；只返回 pass/unavailable/incompatible 与安全计数，不执行点击或页面写操作。
- [x] Calibration Evidence Ledger：每次矩阵成功后只持久化固定 surface/status/profile/page/access/time 与聚合计数，recent runs 有界；不保存 matrix evidence/DOM 自由文本，不远程上传，Popup 可查看覆盖度并显式清空。
- [x] Calibration Coverage Gate / Safe Handoff Report：固定映射六个仍待 live calibration 的 selector surface，只有真实 pass 证据才算 covered，最新 incompatible 强制 needs-review；Popup 可下载仅含固定枚举/计数的脱敏 JSON 报告，不自动勾选真实 TODO。

## 明确不做

第一版不做：

- 一个 Task 自动切换到第二个 ChatGPT Project。
- Task 内跨 Session 续接。
- 到达 Context Limit 后自动生成恢复 Prompt。
- 复用长期业务 ChatGPT Project 作为正常 Task 工作区。

如果业务需要“继续未完成任务”，由服务端创建新的 Task。
