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
```

才执行：

```text
task_patch_count += 1
reportArtifact(...)
```

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

如果后续启用 remote transfer，还需要在 Project Cleanup 前确认所有必需远程上传成功。
