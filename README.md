# Discord Modmail 周报统计机器人

这个机器人用于统计 Modmail 工单中管理员的回复消息数量，并在每周自动把统计报表发送到单独的 Discord 频道。

当前口径：

- 工单创建：在指定 Modmail category 下创建 channel。
- 工单关闭：该工单 channel 被删除，机器人仍会记录关闭事件，但周报不再依赖关闭事件。
- 周归属：按管理员回复消息发送时间。
- 管理员回复：该 category 内的非 bot 真人消息。
- 隐私：不保存消息正文，只保存消息 ID、时间、工单频道 ID、用户 ID/名称和计数。

## 重要安全提醒

如果 bot token 曾经被发到聊天、截图或公共位置，请先去 Discord Developer Portal 重置 token。不要把真实 token 写进代码、README 或 `.env.example`。

## 配置

复制示例配置：

```sh
cp .env.example .env
```

然后把 `.env` 里的 `DISCORD_TOKEN` 改成重置后的真实 token。

程序启动时会自动读取 `.env`。

已填好的固定配置：

```env
GUILD_ID=1128257488375005215
MODMAIL_CATEGORY_ID=1463907222034845858
REPORT_CHANNEL_ID=1526483819664904293
MODMAIL_BOT_ID=575252669443211264
TIMEZONE=Asia/Shanghai
```

## Discord 权限

机器人需要在目标服务器中拥有：

- 查看频道
- 读取消息历史
- 发送消息
- 读取消息内容

Developer Portal 里需要开启：

- Server Members Intent 不需要
- Message Content Intent 建议开启，用于命令和忽略 `!close` 这类命令消息

Bot invite scopes/permissions 至少包含：

- `bot`
- `applications.commands` 可选，本项目当前使用文字命令

## 安装运行

```sh
npm install
npm start
```

也可以用环境变量直接运行：

```sh
DISCORD_TOKEN="你的新 token" npm start
```

## 周报发送时间

默认在每周一 00:05（Asia/Shanghai）发送上一周报表。周范围按 ISO 周计算，也就是周一到周日。

可以通过这些变量调整：

```env
WEEKLY_REPORT_WEEKDAY=1
WEEKLY_REPORT_HOUR=0
WEEKLY_REPORT_MINUTE=5
```

`WEEKLY_REPORT_WEEKDAY` 使用 JavaScript 星期编号：`0=Sunday`，`1=Monday`，直到 `6=Saturday`。

## 手动查看周报

在报表输出频道发送：

```text
!modmail-stats 2026-W29
```

不带周编号则默认发送上一周：

```text
!modmail-stats
```

## 可选行为

默认会忽略以 `!` 开头的真人消息，避免把 `!close` 这类 Modmail 命令算成回复。

如果要统计所有非 bot 真人消息：

```env
IGNORE_MESSAGE_PREFIXES=
```

如果内部备注有固定前缀，比如 `//`、`.`，可以这样：

```env
IGNORE_MESSAGE_PREFIXES=!,//,.
```

如果希望每个工单关闭时也在统计频道发一条简短记录：

```env
SEND_CLOSE_LOG=true
```

## 签到表单自动回复

机器人也可以替代 MEE6，在指定签到频道里自动公开回复 Google 表单链接。

当前配置：

```env
CHECKIN_CHANNEL_ID=1514203944501510295
CHECKIN_FORM_URL=https://forms.gle/wxhXhZpzUseBjeDcA
CHECKIN_REPLY_MESSAGE=这是版主签到表单：\n{form_url}
CHECKIN_ONCE_PER_DAY=true
CHECKIN_DAILY_TIMEZONE=Asia/Shanghai
CHECKIN_COOLDOWN_SECONDS=60
CHECKIN_DELETE_TRIGGER_MESSAGE=false
```

效果：

- 版主在 `CHECKIN_CHANNEL_ID` 频道里发送任意文字、表情或消息。
- Heartopia 会在频道里发送一条普通消息，不会 @ 触发的人。
- 默认每天只发送一次签到提示，日期按 `CHECKIN_DAILY_TIMEZONE=Asia/Shanghai` 计算。
- 当天第一次有人在签到频道发消息时触发；同一天后续再发消息不会触发。
- 到第二天 00:00（UTC+8）后，会重新允许触发一次。
- 不会删除版主原消息。
- 如果关闭每日限制，才会使用 `CHECKIN_COOLDOWN_SECONDS` 作为短冷却，避免刷屏。

默认回复文案可以通过 `CHECKIN_REPLY_MESSAGE` 修改。支持这些占位符：

```text
{form_url}      签到表单链接
{user}          用户名
{display_name} 服务器昵称
```

如果要在 Discord 里临时修改文案，可以在统计频道输入：

```text
!modmail-stats checkin-message 请点击下方链接完成今日签到：
{form_url}
```

查看当前文案：

```text
!modmail-stats checkin-message
```

恢复默认文案：

```text
!modmail-stats checkin-message reset
```

机器人需要在这个签到频道拥有：

- 查看频道
- 读取消息
- 发送消息

如果以后把 `CHECKIN_DELETE_TRIGGER_MESSAGE` 改成 `true`，还需要给机器人“管理消息”权限。

## 频道舆情分析导出

机器人可以手动抓取某个 Discord 频道在指定时间范围内的消息，并在终端显示分析结果，同时生成本地文件。这个功能不会向任何 Discord 频道发送消息。

本次需求可以这样运行：

```sh
npm run analyze -- --channel 1460985755529773301 --from "2026-08-01 00:00" --to "2026-08-03"
```

时间按 UTC+8 解析。`--to "2026-08-03"` 没有写具体时间时，会自动理解为 `2026-08-03 23:59:59`。

生成文件默认保存在：

```text
reports/
```

会生成两类文件：

- `*-report.md`：舆情分析报告，包含高频关键词、用户情绪、讨论最多的话题分类和建议。
- `*-messages.txt`：原始消息文本导出，方便后续人工复核。

也可以把配置写进 `.env`：

```env
ANALYSIS_CHANNEL_ID=1460985755529773301
ANALYSIS_FROM=2026-08-01 00:00
ANALYSIS_TO=2026-08-03
ANALYSIS_TIMEZONE=Asia/Shanghai
ANALYSIS_MAX_MESSAGES=10000
ANALYSIS_INCLUDE_BOTS=false
ANALYSIS_SAVE_RAW=true
ANALYSIS_OUTPUT_DIR=reports
```

然后直接运行：

```sh
npm run analyze
```

注意：

- Heartopia bot 必须能看到这个频道，并拥有“查看频道”和“读取消息历史”权限。
- Developer Portal 里需要开启 Message Content Intent，否则抓到的正文可能为空。
- 当前分析是本地关键词和情绪词典初筛，不调用外部 AI。适合快速看趋势；如果需要更细的人工化分析，可以把生成的报告或原始消息文件发给我继续分析。

## 定时通知发送

机器人可以在指定控制频道里接收 `!notice` 指令，按 UTC+8 定时发送通知到你指定的频道。

默认配置：

```env
NOTICE_CONTROL_CHANNEL_ID=1526483819664904293
NOTICE_COMMAND_PREFIX=!notice
NOTICE_TIMEZONE=Asia/Shanghai
NOTICE_CHECK_INTERVAL_SECONDS=30
```

如果不填写 `NOTICE_CONTROL_CHANNEL_ID`，默认使用 `REPORT_CHANNEL_ID` 作为控制频道。

### 创建定时通知

在控制频道发送：

```text
!notice schedule
time: 2026-08-01 20:00
channel: <#目标频道ID>
type: text
roles: 角色ID1, 角色ID2
image: https://example.com/image.png
content:
这里写通知正文。
可以写很多行，机器人会自动拆分成多条 Discord 消息。
```

字段说明：

- `time`：发送时间，按 UTC+8 解析，格式为 `YYYY-MM-DD HH:mm`。
- `channel`：目标 Discord 频道，可以填频道提及 `<#频道ID>` 或频道 ID。
- `type`：`text` 普通文本，或 `embed` 嵌入消息。
- `roles`：要 @ 的身份组，建议填角色 ID，多个用逗号隔开。
- `image`：图片链接。也可以把图片直接附在这条指令消息里。
- `content`：通知正文，可以多行。

如果正文非常长，Discord 无法让你在一条指令里粘贴完整内容。可以把正文保存为 `.txt` 或 `.md` 文件，和这条指令消息一起上传，机器人会读取文件内容作为通知正文并自动拆分发送。

### Embed 通知

```text
!notice schedule
time: 2026-08-01 20:00
channel: <#目标频道ID>
type: embed
title: 通知标题
roles: 角色ID1
image: https://example.com/banner.png
content:
这里写 Embed 正文。
```

### 其他指令

```text
!notice help
!notice list
!notice preview 通知ID
!notice cancel 通知ID
```

如果要立刻发送一次通知，可以把 `schedule` 改成 `send`，其他格式保持一致：

```text
!notice send
channel: <#目标频道ID>
type: text
roles: 角色ID1
content:
这里写要立刻发送的通知。
```

### 权限要求

机器人需要在控制频道和目标频道拥有：

- 查看频道
- 读取消息历史
- 发送消息
- Embed 链接（如果使用 `type: embed`）

如果通知需要 @ 身份组，机器人还需要能够提及这些身份组。最稳妥的做法是给机器人“提及 @everyone、@here 和所有身份组”的权限，或把对应身份组设置为允许被提及。

## 注意事项

机器人只能统计它在线期间看到的消息。已删除的工单频道无法补历史数据。

`BACKFILL_OPEN_TICKETS_ON_START=true` 可以在启动时读取当前仍未关闭工单的最近消息，所以这些消息会按发送时间进入对应周报；已经关闭并删除的工单无法恢复。
