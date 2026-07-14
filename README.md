# Discord Modmail 周报统计机器人

这个机器人用于统计 Modmail 工单中管理员的回复情况，并在每周自动把统计报表发送到单独的 Discord 频道。

当前口径：

- 工单创建：在指定 Modmail category 下创建 channel。
- 工单关闭：该工单 channel 被删除。
- 周归属：按 channel 删除时间，也就是工单关闭时间。
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

## 注意事项

机器人只能统计它在线期间看到的消息。已删除的工单频道无法补历史数据。

`BACKFILL_OPEN_TICKETS_ON_START=true` 可以在启动时读取当前仍未关闭工单的最近消息，但已经关闭并删除的工单无法恢复。
