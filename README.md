# DSH Bilibili

在 DSH 里使用一个独立的 B 站账号：扫码登录、查看消息、阅读被 @ 的视频，并将阅读结果回复到原 @评论下；提及者明确要求私信时，通过私信返回结果。

## 从扫码开始

```sh
dsh plugin --profile desktop add 'github:AsakuraAOI/dsh-bilibili'
```

安装后按提示重启。在 DSH 中说：

> 登录给你准备的 B 站账号。

插件会通过 `bilibili_login` 生成本地二维码。用准备好的账号扫码确认，再轮询登录结果。它不读取浏览器 Cookie，二维码也在本机生成。

登录态默认放在 `$DSH_HOME/storages/bilibili/account.json`；未设置 `DSH_HOME` 时使用 `~/.dsh`。注销会清除该登录态，并停止本插件创建的监测任务。

## 平时可以让它做什么

| 你要做的事 | 工具 |
|---|---|
| 查看登录状态或退出账号 | `bilibili_login` |
| 看视频信息与分 P 列表 | `bilibili_video` |
| 阅读某个视频，再继续问内容 | `bilibili_read` |
| 查看 @ 通知与热门评论 | `bilibili_mentions` / `bilibili_comments` |
| 看指定用户的私信记录 | `bilibili_messages` |
| 管理新消息监测 | `bilibili_monitor` |
| 获取视频材料与待处理请求 | `bilibili_mentions_check` |
| 提交主 Agent 的回复、结束本轮 | `bilibili_mention_reply` / `bilibili_mentions_finish` |
| 按明确要求发表评论或私信 | `bilibili_comment_send` / `bilibili_message_send` |

视频准备与阅读需搭配 [Seeit ASR 与视觉](https://github.com/AsakuraAOI/dsh-seeit-video) 0.4.0 以上。B站插件负责解析链接、BV/av 号、短链与分 P，下载视频和音轨，读取可访问的原字幕，再通过 `media_open` 取得 `mediaId`、字幕数量和简短首批原文。`page.hasMore=true` 时由主 Agent 用 `media_materials` 按游标续读，或重新选择时间范围；缓存完整不表示本次已经读完。`?p=2` 可以指定分 P。无需另装 Seeit 源码运行时。

@评论可以提出阅读重点，例如“看 3:20 图表的数字，并解释它说明什么，私信发我”。监测返回 `awaiting_agent` 工作项、原评论、`requestId`、媒体路径和已有字幕。主 Agent 根据会话自行调用 `audio_transcribe` 或 `visual_observe`，决定范围、补看和最终回复。支持视觉的主 Agent 直接看图；否则独立视觉模型只描述和提取。插件不自动转写全片、规划、总结或问答。

没有字幕时仍返回媒体 ID 和路径，由主 Agent 决定如何读取。只有标题、简介或缺口说明时，不能原样发送冒充视频原文。

主 Agent 用 `bilibili_mention_reply(requestId, content=...)` 提交完整回复。索要原材料时可以 `useMaterials=true` 通过完整 UTF-8 快照发送原字幕、ASR 和独立视觉文字材料（不会把首批预览当作全文）；原图中由主 Agent 自行读取的内容需由它编写 `content`。原字幕和 ASR 分别标明来源，机器识别不等同于作者原稿。处理全部请求后调用 `bilibili_mentions_finish(requestIds)`。

## 新消息监测

启用 DSH 官方自动化任务 Bundle 后，登录可以为当前会话建立监测任务，默认每 **1 分钟**检查一次新 @ 和收到的私信，每轮最多阅读 **3 个视频**。最短检查间隔为 **60 秒**；插件重新载入时，会通过调度服务将已有监测任务同步到插件设置中的间隔，不重复创建任务。

读完默认回复触发阅读的原 @评论（支持楼中楼），不会另发一条顶层评论。提及者明确说“请私信发我”“私信回复”等时，仅向该提及者的 UID 发送阅读结果，不再公开回评。不会根据评论指定的其他 UID 转发。

长结果完整分段，按 `【1/3】`、`【2/3】` 等编号依次发送，不截断正文。私信每段保守限制为 **500 字符**，同时检查含编号的 JSON 不超过 **2000 字节**；评论沿用每条 **1000 字符**限制，所有分段都回复原 @评论。优先在换行或空白处分段，编号也计入限制。

同一账号的私信共用发送队列，每条收到发送回执后至少间隔 **1.5 秒**再发下一条，避免连续多段落在同一秒造成 B站显示顺序错位；分段回执保留实际发送时间，重启续发也遵守间隔。

DSH 会话通知是可选项，默认关闭；不选也会完成主 Agent 内部阅读、补证据、处理和 B站回复。可在插件设置勾选 `notifySession`，或启动监测时传入 `bilibili_monitor(action="start", notifySession=true)`，需要关闭则传 `false`。已有任务再次 start 时不传此项会保留原选择。通知打开后，新 @、收到的私信以及阅读和发送结果会带回对应会话；没有新内容时保持安静。

已经处理的消息跨重启去重；材料取得后先持久保存，主 Agent 尚未回复时保留待处理，不会因为已读材料就标记完成。阅读失败留待后续重试。每段发送前保存状态、成功后保存回执，再发送下一段。任一段失败或结果未知立即停止，不重发已成功的分段，也不继续发送后面的分段；需到 B站核对。若在两段之间退出且上一段成功回执已保存，恢复后仅继续未发送的分段。用 `bilibili_monitor` 可以查看或停止任务；`bilibili_mentions_check(readVideos=false)` 仅预览，不阅读或发送。更新前已处理的 @不会补发评论或私信。

DSH 必须运行且联网。退出期间不检查，恢复后的补发由 DSH 调度服务负责。

## 账号与发送

监测只提交主 Agent 根据当前视频材料处理后的回复，目标固定为原 @评论或明确要求私信的提及者本人。原 @文本可提供当前视频的处理要求、材料关注点和回复渠道，不能授权其他操作、访问其他链接或文件、改变收件人。除此之外，发表评论或发送私信仍需要当前 DSH 用户明确指定目标与内容。

账号等级、实名要求、隐私设置和风控都可能限制接口。发送失败不会自动重试；结果不确定时应到 B 站核对。

视频与原字幕均使用本插件自己的账号文件。下载缓存在账号文件旁的 `media` 目录；默认每分 P **800 MB**（`maxDownloadMb`），不按时长拦截（`maxVideoMinutes=0`）。分离的视频和音轨直接交给 Seeit，无需先合并；登录 Cookie 不发送到媒体 CDN。下载中的瞬时网络错误最多重试两次；取消、权限和大小超限不重试。失败记录包含阶段、字节计数及底层错误码，保存在媒体旁的 `.download-diagnostics.json`，不记录登录态或签名 URL。

## 测试

```sh
npm test
```

测试覆盖登录、ID 精度、消息分页与去重、发送边界和下载限制，使用伪造 API 响应，不向真实账号发送消息。第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
