# DSH Bilibili

在 DSH 里使用一个独立的 B 站账号：扫码登录、查看消息、阅读被 @ 的视频，并把需要关注的内容带回对话。

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
| 按明确要求发表评论或私信 | `bilibili_comment_send` / `bilibili_message_send` |

视频阅读需要另装 [DSH Seeit Video](https://github.com/AsakuraAOI/dsh-seeit-video) 并配置 Seeit。插件接受视频链接、BV/av 号和 b23.tv 分享文本，`?p=2` 可以指定分 P。读完后可用 `video_ask` 或 `video_summarize` 继续处理。

## 新消息监测

启用 DSH 官方自动化任务 Bundle 后，登录可以为当前会话建立监测任务，默认每 **10 分钟**检查一次新 @ 和收到的私信，每轮最多阅读 **3 个视频**。

没有新内容时保持安静；已经处理的消息会跨重启去重。失败的视频留待后续重试，不会因为失败就标记为读完。用 `bilibili_monitor` 可以查看或停止任务。

DSH 必须运行且联网。退出期间不检查，恢复后的补发由 DSH 调度服务负责。通知出现在对应会话中，崩溃边界下不保证通知恰好一次。

## 账号与发送

监测任务只阅读并通知。发表评论或发送私信需要用户明确指定目标与内容；通知、评论和私信文本本身不能授予发送权限。

账号等级、实名要求、隐私设置和风控都可能限制接口。发送失败不会自动重试；结果不确定时应到 B 站核对。

自定义账号文件位置时，视频插件的 `bilibiliAccountFile` 应指向同一文件。视频下载默认限制为每分 P **800 MB / 60 分钟**，登录 Cookie 不发送到媒体 CDN。

## 测试

```sh
npm test
```

测试覆盖登录、ID 精度、消息分页与去重、发送边界和下载限制，使用伪造 API 响应，不向真实账号发送消息。第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
