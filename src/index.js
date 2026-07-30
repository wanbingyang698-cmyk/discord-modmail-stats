import fs from "node:fs";
import path from "node:path";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";

const DISCORD_EPOCH = 1420070400000n;

loadDotEnv(".env");

const config = {
  token: requiredEnv("DISCORD_TOKEN"),
  guildId: requiredEnv("GUILD_ID"),
  modmailCategoryId: requiredEnv("MODMAIL_CATEGORY_ID"),
  reportChannelId: requiredEnv("REPORT_CHANNEL_ID"),
  modmailBotId: process.env.MODMAIL_BOT_ID || "",
  timezone: process.env.TIMEZONE || "Asia/Shanghai",
  storePath: process.env.STORE_PATH || "data/modmail-stats.json",
  commandPrefix: process.env.COMMAND_PREFIX || "!modmail-stats",
  ignoreMessagePrefixes: parseCsv(process.env.IGNORE_MESSAGE_PREFIXES ?? "!"),
  sendCloseLog: parseBool(process.env.SEND_CLOSE_LOG, false),
  backfillOpenTicketsOnStart: parseBool(
    process.env.BACKFILL_OPEN_TICKETS_ON_START,
    true,
  ),
  backfillMessageLimit: parseInt(process.env.BACKFILL_MESSAGE_LIMIT || "500", 10),
  weeklyReportWeekday: parseInt(process.env.WEEKLY_REPORT_WEEKDAY || "1", 10),
  weeklyReportHour: parseInt(process.env.WEEKLY_REPORT_HOUR || "0", 10),
  weeklyReportMinute: parseInt(process.env.WEEKLY_REPORT_MINUTE || "5", 10),
  checkinChannelId: process.env.CHECKIN_CHANNEL_ID || "",
  checkinFormUrl: process.env.CHECKIN_FORM_URL || "",
  checkinCooldownSeconds: parseInt(
    process.env.CHECKIN_COOLDOWN_SECONDS || "60",
    10,
  ),
  checkinDeleteTriggerMessage: parseBool(
    process.env.CHECKIN_DELETE_TRIGGER_MESSAGE,
    false,
  ),
  checkinReplyMessage: process.env.CHECKIN_REPLY_MESSAGE || "",
  checkinOncePerDay: parseBool(process.env.CHECKIN_ONCE_PER_DAY, true),
  checkinDailyTimeZone:
    process.env.CHECKIN_DAILY_TIMEZONE ||
    process.env.TIMEZONE ||
    "Asia/Shanghai",
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

let state = loadState(config.storePath);
let saveTimer = null;
const checkinCooldowns = new Map();

process.on("uncaughtException", (error) => {
  logFatal(error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  logFatal(error);
  process.exit(1);
});

client.once("ready", async () => {
  console.log(`[ready] logged in as ${client.user.tag}`);
  if (config.checkinChannelId && config.checkinFormUrl) {
    console.log(`[checkin] enabled in channel ${config.checkinChannelId}`);
  }
  await syncOpenTickets();
  await checkWeeklyReport();
  setInterval(checkWeeklyReport, 60_000);
});

client.on("channelCreate", async (channel) => {
  if (!isTrackedGuildChannel(channel)) return;
  if (channel.parentId !== config.modmailCategoryId) return;

  upsertTicketFromChannel(channel);
  queueSave();
  console.log(`[ticket] opened ${channel.id} ${channel.name ?? ""}`);
});

client.on("messageCreate", async (message) => {
  if (!message.guild || message.guild.id !== config.guildId) return;

  if (await handleCheckinAutoReply(message)) return;
  if (await handleReportCommand(message)) return;
  if (!shouldCountMessage(message)) return;

  const channel = message.channel;
  const existingTicket = state.tickets[message.channelId];
  const belongsToModmailCategory =
    existingTicket || channel?.parentId === config.modmailCategoryId;
  if (!belongsToModmailCategory) return;

  if (!existingTicket && channel?.parentId === config.modmailCategoryId) {
    upsertTicketFromChannel(channel);
  }

  const changed = recordReply(message);
  if (changed) queueSave();
});

client.on("channelDelete", async (channel) => {
  const ticket = state.tickets[channel.id];
  if (!ticket && channel.parentId !== config.modmailCategoryId) return;

  const activeTicket = ticket || upsertTicketFromChannel(channel);
  if (activeTicket.status === "closed") return;

  const closedAt = new Date();
  activeTicket.status = "closed";
  activeTicket.channelName = channel.name || activeTicket.channelName;
  activeTicket.closedAt = closedAt.toISOString();
  activeTicket.closedWeek = weekKey(closedAt, config.timezone);
  queueSave();

  console.log(
    `[ticket] closed ${activeTicket.channelId} week=${activeTicket.closedWeek}`,
  );

  if (config.sendCloseLog) {
    await sendReportMessage(formatTicketCloseSummary(activeTicket));
  }
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await client.login(config.token);

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] != null) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function logFatal(error) {
  const message = error?.message || String(error);
  if (message.includes("Opening handshake has timed out")) {
    console.error(
      "[network] Discord gateway connection timed out. This usually means the current network cannot reach Discord reliably. Turn on VPN/proxy, try another network, or deploy the bot to a server that can reach Discord.",
    );
  }

  console.error(error);
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadState(storePath) {
  if (!fs.existsSync(storePath)) {
    return {
      version: 1,
      tickets: {},
      sentReports: {},
      checkinReplyMessage: "",
      checkinLastReplyDate: "",
      checkinLastReplyAt: "",
    };
  }

  const raw = fs.readFileSync(storePath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    version: 1,
    tickets: parsed.tickets || {},
    sentReports: parsed.sentReports || {},
    checkinReplyMessage: parsed.checkinReplyMessage || "",
    checkinLastReplyDate: parsed.checkinLastReplyDate || "",
    checkinLastReplyAt: parsed.checkinLastReplyAt || "",
  };
}

function saveState() {
  const dir = path.dirname(config.storePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${config.storePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, config.storePath);
}

function queueSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 500);
}

function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveState();
  client.destroy();
  process.exit(0);
}

async function syncOpenTickets() {
  const guild = await client.guilds.fetch(config.guildId);
  await guild.channels.fetch();

  const openChannels = guild.channels.cache.filter(
    (channel) =>
      channel.parentId === config.modmailCategoryId && isTextLikeChannel(channel),
  );

  for (const channel of openChannels.values()) {
    upsertTicketFromChannel(channel);
  }

  if (openChannels.size > 0) {
    queueSave();
    console.log(`[sync] tracked ${openChannels.size} open Modmail channels`);
  }

  if (config.backfillOpenTicketsOnStart) {
    for (const channel of openChannels.values()) {
      await backfillOpenTicket(channel);
    }
  }
}

async function backfillOpenTicket(channel) {
  if (!channel.messages?.fetch) return;

  let before;
  let fetched = 0;
  const messages = [];

  while (fetched < config.backfillMessageLimit) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, config.backfillMessageLimit - fetched),
      before,
    });
    if (batch.size === 0) break;

    messages.push(...batch.values());
    fetched += batch.size;
    before = batch.last().id;
  }

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  let added = 0;
  for (const message of messages) {
    if (shouldCountMessage(message) && recordReply(message)) {
      added += 1;
    }
  }

  if (added > 0) {
    queueSave();
    console.log(`[backfill] ${channel.id} added ${added} replies`);
  }
}

function isTrackedGuildChannel(channel) {
  return channel?.guild?.id === config.guildId || channel?.guildId === config.guildId;
}

function isTextLikeChannel(channel) {
  return (
    channel?.type === ChannelType.GuildText ||
    channel?.type === ChannelType.GuildPublicThread ||
    channel?.type === ChannelType.GuildPrivateThread
  );
}

function upsertTicketFromChannel(channel) {
  const createdAt =
    channel.createdAt?.toISOString?.() ||
    new Date(snowflakeTimestamp(channel.id)).toISOString();

  const ticket =
    state.tickets[channel.id] ||
    (state.tickets[channel.id] = {
      channelId: channel.id,
      channelName: channel.name || "",
      createdAt,
      closedAt: null,
      closedWeek: null,
      status: "open",
      replyCount: 0,
      firstReplyAt: null,
      firstResponderId: null,
      responders: {},
      replyMessageIds: [],
      replies: [],
    });

  ticket.channelName = channel.name || ticket.channelName;
  ticket.createdAt = ticket.createdAt || createdAt;
  if (!ticket.responders) ticket.responders = {};
  if (!ticket.replyMessageIds) ticket.replyMessageIds = [];
  if (!ticket.replies) ticket.replies = [];
  return ticket;
}

function shouldCountMessage(message) {
  if (!message || !message.author) return false;
  if (message.author.bot) return false;
  if (message.author.id === client.user?.id) return false;
  if (config.modmailBotId && message.author.id === config.modmailBotId) return false;

  const content = message.content || "";
  if (
    content &&
    config.ignoreMessagePrefixes.some((prefix) => content.startsWith(prefix))
  ) {
    return false;
  }

  return true;
}

function recordReply(message) {
  const channel = message.channel;
  const ticket = state.tickets[message.channelId] || upsertTicketFromChannel(channel);

  const hasMessageId = ticket.replyMessageIds.includes(message.id);
  const hasReplyDetail = (ticket.replies || []).some(
    (reply) => reply.messageId === message.id,
  );
  if (hasMessageId && hasReplyDetail) return false;
  
  const at = new Date(message.createdTimestamp || Date.now()).toISOString();
  const userId = message.author.id;
  const displayName =
    message.member?.displayName ||
    message.author.globalName ||
    message.author.username ||
    userId;

  if (!hasMessageId) {
    ticket.replyMessageIds.push(message.id);
    ticket.replyCount += 1;
  }

  const responder =
    ticket.responders[userId] ||
    (ticket.responders[userId] = {
      userId,
      username: message.author.username || "",
      displayName,
      replyCount: 0,
      firstReplyAt: at,
      lastReplyAt: at,
    });

  responder.username = message.author.username || responder.username;
  responder.displayName = displayName;
  if (!hasMessageId) {
    responder.replyCount += 1;
  }
  responder.firstReplyAt = minIso(responder.firstReplyAt, at);
  responder.lastReplyAt = maxIso(responder.lastReplyAt, at);

  if (!ticket.firstReplyAt || at < ticket.firstReplyAt) {
    ticket.firstReplyAt = at;
    ticket.firstResponderId = userId;
  }

  if (!hasReplyDetail) {
    ticket.replies.push({
      messageId: message.id,
      channelId: message.channelId,
      at,
      userId,
      username: message.author.username || "",
      displayName,
    });
  }

  return true;
}

async function handleCheckinAutoReply(message) {
  if (!config.checkinChannelId || !config.checkinFormUrl) return false;
  if (message.channelId !== config.checkinChannelId) return false;
  if (message.author?.bot) return true;

  const todayKey = localDateKey(new Date(), config.checkinDailyTimeZone);
  if (config.checkinOncePerDay && state.checkinLastReplyDate === todayKey) {
    return true;
  }

  const cooldownKey = `${message.channelId}:${message.author.id}`;
  const now = Date.now();
  const cooldownUntil = checkinCooldowns.get(cooldownKey) || 0;
  if (config.checkinCooldownSeconds > 0 && now < cooldownUntil) {
    return true;
  }

  checkinCooldowns.set(
    cooldownKey,
    now + Math.max(0, config.checkinCooldownSeconds) * 1000,
  );

  await message.channel.send({
    content: buildCheckinReplyMessage(message),
    allowedMentions: { parse: [] },
  });

  if (config.checkinOncePerDay) {
    state.checkinLastReplyDate = todayKey;
    state.checkinLastReplyAt = new Date().toISOString();
    queueSave();
  }

  if (config.checkinDeleteTriggerMessage) {
    await message.delete().catch((error) => {
      console.warn("[checkin] failed to delete trigger message", error);
    });
  }

  return true;
}

function buildCheckinReplyMessage(message) {
  const template =
    state.checkinReplyMessage ||
    config.checkinReplyMessage ||
    ["这是版主签到表单：", "{form_url}"].join("\n");

  return template
    .replaceAll("\\n", "\n")
    .replaceAll("{form_url}", config.checkinFormUrl)
    .replaceAll("{user}", message.author.username || "")
    .replaceAll(
      "{display_name}",
      message.member?.displayName || message.author.globalName || "",
    )
    .trim();
}

async function handleReportCommand(message) {
  const content = message.content || "";
  if (!content.startsWith(config.commandPrefix)) return false;
  if (message.channelId !== config.reportChannelId) return true;
  if (message.author.bot) return true;

  const body = content.slice(config.commandPrefix.length).trim();
  if (await handleCheckinMessageCommand(message, body)) return true;

  const args = body.split(/\s+/);
  const requestedWeek = args.find((arg) => /^\d{4}-W\d{2}$/.test(arg));
  const week = requestedWeek || previousWeekKey(new Date(), config.timezone);

  await sendReportMessage(formatWeeklyReport(week));
  return true;
}

async function handleCheckinMessageCommand(message, body) {
  const command = "checkin-message";
  if (!body.startsWith(command)) return false;

  const text = body.slice(command.length).trim();
  if (!text) {
    await message.reply({
      content: [
        "当前签到自动回复文案：",
        "```text",
        currentCheckinReplyTemplate(),
        "```",
        "",
        "修改示例：",
        `${config.commandPrefix} checkin-message 请点击下方链接完成今日签到：\n{form_url}`,
        "",
        "可用占位符：{form_url}、{user}、{display_name}",
      ].join("\n").slice(0, 1900),
      allowedMentions: { parse: [], repliedUser: false },
    });
    return true;
  }

  if (text === "reset") {
    state.checkinReplyMessage = "";
    queueSave();
    await message.reply({
      content: "已恢复默认签到自动回复文案。",
      allowedMentions: { parse: [], repliedUser: false },
    });
    return true;
  }

  state.checkinReplyMessage = text;
  queueSave();
  await message.reply({
    content: [
      "已更新签到自动回复文案：",
      "```text",
      currentCheckinReplyTemplate(),
      "```",
    ].join("\n").slice(0, 1900),
    allowedMentions: { parse: [], repliedUser: false },
  });
  return true;
}

function currentCheckinReplyTemplate() {
  return (
    state.checkinReplyMessage ||
    config.checkinReplyMessage ||
    ["这是版主签到表单：", "{form_url}"].join("\n")
  );
}

async function checkWeeklyReport() {
  const now = new Date();
  const parts = zonedParts(now, config.timezone);
  const isReportDay = parts.weekday === config.weeklyReportWeekday;
  const isAfterReportTime =
    parts.hour > config.weeklyReportHour ||
    (parts.hour === config.weeklyReportHour &&
      parts.minute >= config.weeklyReportMinute);

  if (!isReportDay || !isAfterReportTime) return;

  const week = previousWeekKey(now, config.timezone);
  if (state.sentReports[week]) return;

  await sendReportMessage(formatWeeklyReport(week));
  state.sentReports[week] = new Date().toISOString();
  queueSave();
}

async function sendReportMessage(content) {
  const channel = await client.channels.fetch(config.reportChannelId);
  if (!channel?.isTextBased()) {
    throw new Error("Report channel is not text-based or is not accessible");
  }

  for (const chunk of splitDiscordMessage(content)) {
    await channel.send(chunk);
  }
}

function formatTicketCloseSummary(ticket) {
  const responders = Object.values(ticket.responders || {})
    .sort((a, b) => b.replyCount - a.replyCount)
    .map((person) => `${person.displayName}: ${person.replyCount}`)
    .join(", ");

  return [
    `工单频道已关闭：${ticket.channelName || ticket.channelId}`,
    `关闭周：${ticket.closedWeek || closedWeekForTicket(ticket) || "未知"}`,
    `管理员回复数：${ticket.replyCount}`,
    `参与管理员：${responders || "无"}`,
  ].join("\n");
}

function formatWeeklyReport(week) {
  const tickets = Object.values(state.tickets);
  const weeklyReplies = [];

  const adminStats = new Map();
  let firstResponseTotalMs = 0;
  let firstResponseCount = 0;

  for (const ticket of tickets) {
    for (const reply of ticket.replies || []) {
      if (weekKey(new Date(reply.at), config.timezone) !== week) continue;
      weeklyReplies.push({ ticket, reply });

      const stat =
        adminStats.get(reply.userId) ||
        {
          userId: reply.userId,
          displayName: reply.displayName || reply.userId,
          ticketIds: new Set(),
          replyCount: 0,
          firstResponseCount: 0,
          firstResponseTotalMs: 0,
        };

      stat.displayName = reply.displayName || stat.displayName;
      stat.ticketIds.add(ticket.channelId);
      stat.replyCount += 1;
      adminStats.set(reply.userId, stat);
    }

    const firstResponseMs = ticket.firstReplyAt
      ? new Date(ticket.firstReplyAt).getTime() - new Date(ticket.createdAt).getTime()
      : null;

    if (
      ticket.firstReplyAt &&
      ticket.firstResponderId &&
      weekKey(new Date(ticket.firstReplyAt), config.timezone) === week &&
      firstResponseMs != null &&
      firstResponseMs >= 0
    ) {
      const responder = ticket.responders?.[ticket.firstResponderId];
      const stat =
        adminStats.get(ticket.firstResponderId) ||
        {
          userId: ticket.firstResponderId,
          displayName:
            responder?.displayName || responder?.username || ticket.firstResponderId,
          ticketIds: new Set(),
          replyCount: 0,
          firstResponseCount: 0,
          firstResponseTotalMs: 0,
        };

      const hasWeeklyReply = weeklyReplies.some(
        ({ ticket: replyTicket, reply }) =>
          replyTicket.channelId === ticket.channelId &&
          reply.userId === ticket.firstResponderId,
      );
      if (hasWeeklyReply) {
        stat.firstResponseCount += 1;
        stat.firstResponseTotalMs += Math.max(0, firstResponseMs);
        firstResponseCount += 1;
        firstResponseTotalMs += firstResponseMs;
      }

      adminStats.set(ticket.firstResponderId, stat);
    }
  }

  const rows = [...adminStats.values()].sort((a, b) => {
    if (b.replyCount !== a.replyCount) {
      return b.replyCount - a.replyCount;
    }
    return b.ticketIds.size - a.ticketIds.size;
  });

  const table = rows.length
    ? renderTable(
        ["管理员", "回复数", "涉及工单", "首响次数", "平均首响"],
        rows.map((stat) => [
          truncate(stat.displayName, 18),
          String(stat.replyCount),
          String(stat.ticketIds.size),
          String(stat.firstResponseCount),
          stat.firstResponseCount
            ? formatDuration(stat.firstResponseTotalMs / stat.firstResponseCount)
            : "-",
        ]),
      )
    : "无管理员回复数据";

  const avgFirstResponse = firstResponseCount
    ? formatDuration(firstResponseTotalMs / firstResponseCount)
    : "-";
  const ticketCount = new Set(
    weeklyReplies.map(({ ticket }) => ticket.channelId),
  ).size;

  return [
    `## ${week} Modmail 管理员回复周报`,
    `范围：${weekRangeLabel(week)}`,
    "",
    "统计口径：按管理员回复消息发送时间归属周。不要求工单关闭。",
    "",
    `本周回复总数：${weeklyReplies.length}`,
    `涉及工单：${ticketCount}`,
    `活跃管理员：${rows.length}`,
    `本周首响次数：${firstResponseCount}`,
    `本周平均首响：${avgFirstResponse}`,
    "",
    "```text",
    table,
    "```",
  ].join("\n");
}

function renderTable(headers, rows) {
  const allRows = [headers, ...rows];
  const widths = headers.map((_, columnIndex) =>
    Math.max(...allRows.map((row) => visibleLength(row[columnIndex]))),
  );

  const formatRow = (row) =>
    row
      .map((cell, index) => String(cell).padEnd(widths[index], " "))
      .join("  ");

  return [
    formatRow(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(formatRow),
  ].join("\n");
}

function splitDiscordMessage(content) {
  const max = 1900;
  if (content.length <= max) return [content];

  const chunks = [];
  let rest = content;
  while (rest.length > max) {
    let splitAt = rest.lastIndexOf("\n", max);
    if (splitAt < 1) splitAt = max;
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function truncate(value, maxLength) {
  const text = String(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function visibleLength(value) {
  return String(value).length;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}m`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

function minIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function snowflakeTimestamp(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

function closedWeekForTicket(ticket) {
  if (ticket.closedWeek) return ticket.closedWeek;
  if (!ticket.closedAt) return null;
  return weekKey(new Date(ticket.closedAt), config.timezone);
}

function weekKey(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return isoWeekKeyFromUtcDate(
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day)),
  );
}

function previousWeekKey(date, timeZone) {
  const currentWeekStart = startOfIsoWeekUtcDate(date, timeZone);
  currentWeekStart.setUTCDate(currentWeekStart.getUTCDate() - 7);
  return isoWeekKeyFromUtcDate(currentWeekStart);
}

function startOfIsoWeekUtcDate(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = localDate.getUTCDay() || 7;
  localDate.setUTCDate(localDate.getUTCDate() - day + 1);
  return localDate;
}

function isoWeekKeyFromUtcDate(date) {
  const working = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = working.getUTCDay() || 7;
  working.setUTCDate(working.getUTCDate() + 4 - day);

  const weekYear = working.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNumber = Math.ceil(
    ((working.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );

  return `${weekYear}-W${String(weekNumber).padStart(2, "0")}`;
}

function weekRangeLabel(week) {
  const start = isoWeekStartFromKey(week);
  if (!start) return "未知";

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return `${formatUtcYmd(start)} 至 ${formatUtcYmd(end)}`;
}

function isoWeekStartFromKey(week) {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;

  const weekYear = Number(match[1]);
  const weekNumber = Number(match[2]);
  if (weekNumber < 1 || weekNumber > 53) return null;

  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  jan4.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (weekNumber - 1) * 7);
  return jan4;
}

function formatUtcYmd(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function localDateKey(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: new Date(
      Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)),
    ).getUTCDay(),
  };
}
