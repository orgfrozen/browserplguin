# Patch Download

## 范围

本模块只负责 ChatGPT Assistant 回复里的 Patch/附件自动下载与持久化确认。

## 发现流程

每一轮模型回复稳定后：

```text
latest Assistant message
  ↓
scan Patch controls
  ↓
filter current session
  ↓
filter already downloaded keys
  ↓
trigger download
```

只扫描最新 Assistant Message，避免反复处理历史回复。

## 两种触发方式

### 控件有 URL

```text
candidate.url
→ chrome.downloads.download()
→ immediate downloadId binding
```

### 控件无 URL

ChatGPT 有时只显示“下载 Patch”按钮，文件名/URL 在点击前不可见：

```text
create DownloadIntent
→ click real page control
→ chrome.downloads.onCreated
→ correlate actual download
```

## DownloadIntent 关联

至少使用：

```text
task_id
session_id
tab_id
triggered_at
optional filename hint
```

Chrome 新下载出现后，结合：

```text
same tab
+ recent trigger window
+ .patch file identity
+ current session_id
```

进行匹配。

若多个下载都可能匹配，返回 `PATCH_DOWNLOAD_AMBIGUOUS`，不猜。

## 完成条件

不能在“点击下载”时增加 Patch 数。

只有：

```text
chrome.downloads.onChanged
state = complete
+ actual filename belongs to current session
+ patch key not seen before
+ ArtifactTransferManager receipt success (local receipt，或 remote upload receipt)
```

才执行：

```text
persist task_patch_count / downloaded_patch_keys
→ reportArtifact(... transfer_mode, transfer_receipt, no Patch bytes ...)
```

local v0.6.0 使用浏览器当前 Downloads 目的地，不强制移动下载文件；上报 Chrome 最终 `download_id / filename / local_path / source_url`。

remote upload 协议在 v0.15.0 已实现：可信文件读取层提供 `content_base64 + size_bytes` 后，通过 Task lease/idempotency key 上传；成功 receipt 返回后才允许计数。Patch bytes 会在 artifact metadata 上报前剥离。v0.16.0 已接入 Native Helper 读取链：Chrome 下载完成得到 `local_path` 后，`NativePatchFileReader` 通过 `connectNative()` 请求 `com.browserplguin.patch_reader`；Host 只允许 Downloads root 内普通 `.patch` 文件，并按 Native Messaging 单消息上限分块返回内容。扩展重组后重新计算 SHA-256，再交给 remote upload。Host manifest 安装/注册与真实 remote E2E 尚未完成，因此用户设置中的 remote 仍禁用。

## Patch key

例如当前：

```text
session_id = faf42343242
```

允许：

```text
patch-faf42343242-001.patch
patch-faf42343242-002.patch
```

其它 Session ID 的历史 Patch 不作为当前 Task 新 Patch 处理。

由于一个 Task 只有一个 Session，`task_patch_count` 就是该 Task 唯一需要维护的 Patch 数量计数器。

## 去重

Runner 持久化 `downloaded_patch_keys`。

同一个 DOM 控件、同一个 Patch 文件或页面重绘再次出现，都不能重复计数。

## Task Finalize

终止 Task 前必须确保当前已触发的 Patch 下载已经达到确定状态：

```text
complete
or
explicit failed
```

remote transfer 启用后，所有 Patch 都必须取得 remote upload receipt 才会进入计数，因此 Project Cleanup 自然只能发生在所有已处理 Patch 远程上传成功之后；上传失败会走 Task failure/finalize，不能假装成功。

## Native Helper 安装与 readiness

`native-host/install-native-host.mjs` 负责 macOS/Linux user-level 安装注册。它要求显式传入当前 Chrome Extension ID，并生成：

- 稳定用户目录中的 `patch-file-reader.mjs` / `patch-file-service.mjs` 副本；
- 绑定安装时 `process.execPath` 与 canonical Downloads root 的可执行 launcher；
- `com.browserplguin.patch_reader.json` Native Messaging manifest；
- 精确的 `allowed_origins = ["chrome-extension://<EXTENSION_ID>/"]`，不允许 wildcard。

Host readiness 使用独立的 `PING → PONG`：

```text
PING(request_id)
  ↓
PONG(request_id, host_name, protocol_version, capabilities)
```

该路径不接受/读取文件路径。`NativePatchFileReader.checkReady()` 校验 host name、protocol version 与 `read_patch_file/chunked/max_patch_bytes` capabilities；Background 只存储脱敏后的 readiness 摘要。Options 的检测按钮不会改变 `patchTransferMode`。真实 remote E2E 通过前，remote option 仍 disabled。
## Remote E2E Preflight

在正式开放 remote 之前，Options 提供无副作用 preflight。它验证：

- `mode=real`；
- Task API Base URL 是 HTTP(S)；
- 当前扩展已拥有该 Task API origin 的 host permission；
- manifest 包含 `nativeMessaging`；
- Native Helper live `PING/PONG` ready；
- Helper 支持 `read_patch_file`、chunked framing，且 `max_patch_bytes >= 32 MiB`。

preflight **不会** claim Task、读 Patch、上传 artifact 或修改 `patchTransferMode`。持久化结果只包含 checks/blocker codes/时间，不包含 Task API URL/token、Extension ID、Host 原始错误或本地路径。真实 remote E2E 完成前 Options remote 继续 disabled。
