import fs from "node:fs";
import path from "node:path";
import { Client, GatewayIntentBits, Partials } from "discord.js";

const DISCORD_EPOCH = 1420070400000n;
const UTC_PLUS_8 = 8 * 60 * 60 * 1000;

loadDotEnv(".env");

const args = parseArgs(process.argv.slice(2));
const config = {
  token: requiredEnv("DISCORD_TOKEN"),
  guildId: args.guild || process.env.ANALYSIS_GUILD_ID || process.env.GUILD_ID || "",
  channelId: args.channel || process.env.ANALYSIS_CHANNEL_ID || "",
  from: args.from || process.env.ANALYSIS_FROM || "",
  to: args.to || process.env.ANALYSIS_TO || "",
  timezone: args.timezone || process.env.ANALYSIS_TIMEZONE || "Asia/Shanghai",
  outputDir: args.outputDir || process.env.ANALYSIS_OUTPUT_DIR || "reports",
  maxMessages: parseInt(args.max || process.env.ANALYSIS_MAX_MESSAGES || "10000", 10),
  includeBots: parseBool(args.includeBots ?? process.env.ANALYSIS_INCLUDE_BOTS, false),
  saveRaw: parseBool(args.saveRaw ?? process.env.ANALYSIS_SAVE_RAW, true),
};

main().catch((error) => {
  console.error(`[analysis] failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
});

async function main() {
  validateConfig(config);

  const fromDate = parseUtc8DateTime(config.from, { endOfDay: false });
  const toDate = parseUtc8DateTime(config.to, { endOfDay: true });
  if (!fromDate || !toDate) {
    throw new Error("时间格式需要类似 2026-08-01 00:00 或 2026-08-03");
  }
  if (fromDate.getTime() > toDate.getTime()) {
    throw new Error("开始时间不能晚于结束时间");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  await loginClient(client, config.token);
  console.log(`[analysis] logged in as ${client.user.tag}`);

  try {
    const channel = await client.channels.fetch(config.channelId);
    if (!channel) throw new Error("找不到这个频道，请确认频道 ID 是否正确");
    if (channel.guildId !== config.guildId) {
      throw new Error("这个频道不属于配置的服务器 ID");
    }
    if (!channel.isTextBased() || !channel.messages?.fetch) {
      throw new Error("这个频道不是可读取消息的文字频道");
    }

    console.log(
      `[analysis] fetching ${config.channelId} from ${formatLocal(fromDate)} to ${formatLocal(toDate)}`,
    );
    const result = await fetchMessagesInRange(channel, fromDate, toDate, config);
    const analysis = analyzeMessages(result.messages);
    const report = renderReport({
      channel,
      fromDate,
      toDate,
      messages: result.messages,
      analysis,
      truncated: result.truncated,
      config,
    });

    fs.mkdirSync(config.outputDir, { recursive: true });
    const baseName = buildOutputBaseName(config.channelId, fromDate, toDate);
    const reportPath = path.join(config.outputDir, `${baseName}-report.md`);
    fs.writeFileSync(reportPath, report);

    let rawPath = "";
    if (config.saveRaw) {
      rawPath = path.join(config.outputDir, `${baseName}-messages.txt`);
      fs.writeFileSync(rawPath, renderTranscript(result.messages, config));
    }

    console.log("\n" + report);
    console.log("\n[analysis] saved report:", reportPath);
    if (rawPath) console.log("[analysis] saved raw messages:", rawPath);
  } finally {
    client.destroy();
  }
}

function validateConfig(currentConfig) {
  if (!currentConfig.guildId) throw new Error("缺少服务器 ID：请设置 GUILD_ID 或 --guild");
  if (!currentConfig.channelId) throw new Error("缺少频道 ID：请设置 ANALYSIS_CHANNEL_ID 或 --channel");
  if (!currentConfig.from) throw new Error("缺少开始时间：请设置 ANALYSIS_FROM 或 --from");
  if (!currentConfig.to) throw new Error("缺少结束时间：请设置 ANALYSIS_TO 或 --to");
  if (!Number.isFinite(currentConfig.maxMessages) || currentConfig.maxMessages < 1) {
    throw new Error("ANALYSIS_MAX_MESSAGES 必须是大于 0 的数字");
  }
  if (!["Asia/Shanghai", "UTC+8", "GMT+8"].includes(currentConfig.timezone)) {
    throw new Error("当前脚本只支持 UTC+8 / Asia/Shanghai 时间");
  }
}

function loginClient(client, token) {
  return new Promise((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.login(token).catch(reject);
  });
}

async function fetchMessagesInRange(channel, fromDate, toDate, currentConfig) {
  const messages = [];
  let before = snowflakeFromTimestamp(toDate.getTime() + 1000);
  let truncated = false;

  while (messages.length < currentConfig.maxMessages) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, currentConfig.maxMessages - messages.length),
      before,
    });
    if (batch.size === 0) break;

    const batchMessages = [...batch.values()].sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    );
    const oldest = batchMessages[batchMessages.length - 1];

    for (const message of batchMessages) {
      if (message.createdTimestamp > toDate.getTime()) continue;
      if (message.createdTimestamp < fromDate.getTime()) continue;
      if (!currentConfig.includeBots && message.author?.bot) continue;
      messages.push(serializeMessage(message));
    }

    before = oldest.id;
    if (oldest.createdTimestamp < fromDate.getTime()) break;
  }

  if (messages.length >= currentConfig.maxMessages) truncated = true;
  messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { messages, truncated };
}

function serializeMessage(message) {
  return {
    id: message.id,
    channelId: message.channelId,
    createdAt: new Date(message.createdTimestamp).toISOString(),
    createdAtLocal: formatLocal(new Date(message.createdTimestamp)),
    authorId: message.author?.id || "",
    username: message.author?.username || "",
    displayName:
      message.member?.displayName ||
      message.author?.globalName ||
      message.author?.username ||
      "",
    bot: Boolean(message.author?.bot),
    content: message.content || "",
    attachmentUrls: [...message.attachments.values()].map((attachment) => attachment.url),
  };
}

function analyzeMessages(messages) {
  const keywordStats = countKeywords(messages);
  const sentiment = analyzeSentiment(messages);
  const topics = analyzeTopics(messages);
  const emptyContentCount = messages.filter(
    (message) => !message.content && message.attachmentUrls.length === 0,
  ).length;

  return {
    keywordStats,
    sentiment,
    topics,
    emptyContentCount,
  };
}

function countKeywords(messages) {
  const stats = new Map();
  for (const message of messages) {
    const seenInMessage = new Set();
    for (const token of tokenize(message.content)) {
      const item = stats.get(token) || { word: token, count: 0, messageCount: 0 };
      item.count += 1;
      if (!seenInMessage.has(token)) {
        item.messageCount += 1;
        seenInMessage.add(token);
      }
      stats.set(token, item);
    }
  }
  return [...stats.values()]
    .sort((a, b) => b.count - a.count || b.messageCount - a.messageCount)
    .slice(0, 30);
}

function analyzeSentiment(messages) {
  const summary = {
    positive: [],
    neutral: [],
    negative: [],
  };

  for (const message of messages) {
    const result = scoreSentiment(message.content);
    summary[result.label].push({ ...message, sentimentScore: result.score });
  }

  return summary;
}

function analyzeTopics(messages) {
  const topicMap = new Map(
    TOPICS.map((topic) => [
      topic.id,
      {
        ...topic,
        messages: [],
        sentiment: { positive: 0, neutral: 0, negative: 0 },
      },
    ]),
  );
  topicMap.set("other", {
    id: "other",
    name: "其他讨论",
    keywords: [],
    messages: [],
    sentiment: { positive: 0, neutral: 0, negative: 0 },
  });

  for (const message of messages) {
    const topic = classifyTopic(message.content);
    const sentimentLabel = scoreSentiment(message.content).label;
    topic.messages.push(message);
    topic.sentiment[sentimentLabel] += 1;
  }

  return [...topicMap.values()]
    .filter((topic) => topic.messages.length > 0)
    .map((topic) => ({
      ...topic,
      keywordStats: countKeywords(topic.messages).slice(0, 8),
    }))
    .sort((a, b) => b.messages.length - a.messages.length);

  function classifyTopic(content) {
    const normalized = normalizeForMatch(content);
    let best = topicMap.get("other");
    let bestScore = 0;

    for (const topic of TOPICS) {
      const score = topic.keywords.reduce(
        (total, keyword) => total + countKeywordMatch(normalized, keyword),
        0,
      );
      if (score > bestScore) {
        bestScore = score;
        best = topicMap.get(topic.id);
      }
    }

    return best;
  }
}

function renderReport({ channel, fromDate, toDate, messages, analysis, truncated, config }) {
  const total = messages.length;
  const sentimentRows = [
    ["正面", analysis.sentiment.positive.length, percent(analysis.sentiment.positive.length, total)],
    ["中性", analysis.sentiment.neutral.length, percent(analysis.sentiment.neutral.length, total)],
    ["负面", analysis.sentiment.negative.length, percent(analysis.sentiment.negative.length, total)],
  ];
  const topicRows = analysis.topics.map((topic) => [
    topic.name,
    topic.messages.length,
    percent(topic.messages.length, total),
    `${topic.sentiment.positive}/${topic.sentiment.neutral}/${topic.sentiment.negative}`,
  ]);

  const lines = [
    "# Discord 频道舆情分析报告",
    "",
    `- 服务器 ID：${config.guildId}`,
    `- 频道：${channel.name ? `#${channel.name}` : config.channelId} (${config.channelId})`,
    `- 时间范围：${formatLocal(fromDate)} 至 ${formatLocal(toDate)} UTC+8`,
    `- 抓取消息数：${total}`,
    `- Bot 消息：${config.includeBots ? "已包含" : "已排除"}`,
    "- 分析方式：本地关键词与情绪词典初筛，不调用外部 AI，也不会发送到 Discord 频道。",
    truncated ? `- 注意：已达到最大抓取上限 ${config.maxMessages} 条，报告可能不完整。` : "",
    analysis.emptyContentCount > 0
      ? `- 注意：有 ${analysis.emptyContentCount} 条消息没有正文或附件，若数量异常，请检查 Message Content Intent 和频道读取权限。`
      : "",
    "",
    "## 高频关键词",
    "",
    analysis.keywordStats.length
      ? renderMarkdownTable(
          ["关键词", "出现次数", "涉及消息"],
          analysis.keywordStats.slice(0, 20).map((item) => [
            item.word,
            item.count,
            item.messageCount,
          ]),
        )
      : "没有提取到有效关键词。",
    "",
    "## 用户情绪",
    "",
    renderMarkdownTable(["情绪", "消息数", "占比"], sentimentRows),
    "",
    renderSentimentInsight(analysis.sentiment, total),
    "",
    "### 负面代表消息",
    "",
    renderExamples(analysis.sentiment.negative.slice(0, 5), config),
    "",
    "## 讨论最多的话题分类",
    "",
    topicRows.length
      ? renderMarkdownTable(["话题", "消息数", "占比", "正/中/负"], topicRows)
      : "没有可分类的话题。",
    "",
    ...analysis.topics.flatMap((topic, index) => renderTopicSection(topic, index + 1, total, config)),
    "## 建议",
    "",
    ...renderActionItems(analysis, total),
    "",
  ].filter((line) => line !== "");

  return lines.join("\n");
}

function renderSentimentInsight(sentiment, total) {
  if (total === 0) return "本时间段没有可分析消息。";

  const negativeRatio = sentiment.negative.length / total;
  const positiveRatio = sentiment.positive.length / total;
  if (negativeRatio >= 0.35) {
    return `初步判断：负面反馈占比 ${percent(sentiment.negative.length, total)}，建议优先查看负面代表消息和负面占比较高的话题。`;
  }
  if (positiveRatio >= 0.35 && positiveRatio > negativeRatio * 1.5) {
    return `初步判断：整体反馈偏正面，正面消息占比 ${percent(sentiment.positive.length, total)}。`;
  }
  return "初步判断：整体情绪较分散，建议结合高频话题逐项查看。";
}

function renderTopicSection(topic, index, total, config) {
  return [
    `### ${index}. ${topic.name}`,
    "",
    `- 消息数：${topic.messages.length} (${percent(topic.messages.length, total)})`,
    `- 主要关键词：${topic.keywordStats.map((item) => item.word).join("、") || "-"}`,
    `- 舆情判断：${topicInsight(topic)}`,
    "- 代表消息：",
    renderExamples(topic.messages.slice(0, 3), config),
    "",
  ];
}

function topicInsight(topic) {
  const total = topic.messages.length || 1;
  const negativeRatio = topic.sentiment.negative / total;
  const positiveRatio = topic.sentiment.positive / total;
  if (negativeRatio >= 0.35) {
    return "该话题负面占比较高，可能需要优先排查具体问题或补充官方说明。";
  }
  if (positiveRatio >= 0.35 && positiveRatio > negativeRatio) {
    return "该话题正面反馈较多，可以考虑继续放大亮点或收集可复用内容。";
  }
  return "该话题讨论量较高但情绪不集中，适合继续观察关键词和代表消息。";
}

function renderActionItems(analysis, total) {
  if (total === 0) return ["- 当前时间段没有抓取到消息，请确认时间范围和频道权限。"];

  const topTopic = analysis.topics[0];
  const mostNegativeTopic = [...analysis.topics].sort(
    (a, b) => b.sentiment.negative - a.sentiment.negative,
  )[0];
  const items = [];

  if (topTopic) {
    items.push(`- 优先复盘讨论量最高的话题“${topTopic.name}”，它占全部消息的 ${percent(topTopic.messages.length, total)}。`);
  }
  if (mostNegativeTopic?.sentiment.negative > 0) {
    items.push(`- 重点查看“${mostNegativeTopic.name}”中的负面消息，确认是否需要公告、FAQ 或问题修复跟进。`);
  }
  if (analysis.keywordStats.length > 0) {
    items.push(
      `- 可以围绕高频关键词“${analysis.keywordStats
        .slice(0, 5)
        .map((item) => item.word)
        .join("、")}”做二次人工复核。`,
    );
  }
  items.push("- 如果需要更深入的语义判断，可以把生成的报告或原始消息文件发给我，我再做人工化总结。");
  return items;
}

function renderExamples(messages, config) {
  const valid = messages.filter((message) => message.content || message.attachmentUrls.length);
  if (valid.length === 0) return "- 无";

  return valid
    .slice(0, 5)
    .map((message) => {
      const text = truncate(
        message.content || `[附件] ${message.attachmentUrls.join(", ")}`,
        160,
      );
      return `- ${message.createdAtLocal} ${message.displayName || message.username || message.authorId}: ${text} (${messageLink(config.guildId, message.channelId, message.id)})`;
    })
    .join("\n");
}

function renderTranscript(messages, config) {
  return [
    "Discord channel export",
    `Guild: ${config.guildId}`,
    `Channel: ${config.channelId}`,
    `Generated at: ${formatLocal(new Date())} UTC+8`,
    "",
    ...messages.map((message) => {
      const attachments = message.attachmentUrls.length
        ? `\nAttachments: ${message.attachmentUrls.join(", ")}`
        : "";
      return `[${message.createdAtLocal}] ${message.displayName || message.username || message.authorId}: ${message.content}${attachments}`;
    }),
    "",
  ].join("\n");
}

function renderMarkdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function tokenize(text) {
  const normalized = normalizeForMatch(text)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<a?:\w+:\d+>/g, " ")
    .replace(/<[@#&]?\d+>/g, " ")
    .replace(/[`*_~>[\](){}]/g, " ");

  const tokens = [];
  const segmenter =
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("zh", { granularity: "word" })
      : null;

  if (segmenter) {
    for (const part of segmenter.segment(normalized)) {
      if (!part.isWordLike) continue;
      addToken(part.segment);
    }
  } else {
    for (const token of normalized.match(/[\p{L}\p{N}]+/gu) || []) {
      addToken(token);
    }
  }

  return tokens;

  function addToken(rawToken) {
    const token = rawToken.toLowerCase().trim();
    if (!token) return;
    if (/^\d+$/.test(token)) return;
    if (token.length < 2) return;
    if (STOPWORDS.has(token)) return;
    tokens.push(token);
  }
}

function scoreSentiment(text) {
  const normalized = normalizeForMatch(text);
  let score = 0;

  for (const word of POSITIVE_WORDS) {
    score += countKeywordMatch(normalized, word);
  }
  for (const word of NEGATIVE_WORDS) {
    score -= countKeywordMatch(normalized, word);
  }

  if (score > 0) return { label: "positive", score };
  if (score < 0) return { label: "negative", score };
  return { label: "neutral", score };
}

function countKeywordMatch(text, keyword) {
  const normalizedKeyword = keyword.toLowerCase();
  if (containsCjk(normalizedKeyword)) {
    return text.includes(normalizedKeyword) ? 1 : 0;
  }
  const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = text.match(new RegExp(`\\b${escaped}\\b`, "g"));
  return matches ? matches.length : 0;
}

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[’]/g, "'")
    .replace(/[“”]/g, '"');
}

function containsCjk(text) {
  return /[\u3400-\u9fff]/.test(text);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

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
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function parseUtc8DateTime(value, options) {
  const match =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      String(value || "").trim(),
    );
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const hasTime = hour != null;
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      hasTime ? Number(hour) : options.endOfDay ? 23 : 0,
      hasTime ? Number(minute) : options.endOfDay ? 59 : 0,
      hasTime ? Number(second || 0) : options.endOfDay ? 59 : 0,
    ) - UTC_PLUS_8,
  );

  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function snowflakeFromTimestamp(timestampMs) {
  return ((BigInt(timestampMs) - DISCORD_EPOCH) << 22n).toString();
}

function formatLocal(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replaceAll("/", "-");
}

function buildOutputBaseName(channelId, fromDate, toDate) {
  const from = formatFileDate(fromDate);
  const to = formatFileDate(toDate);
  return `discord-channel-${channelId}-${from}_to_${to}`;
}

function formatFileDate(date) {
  return formatLocal(date).replace(/[^\d]/g, "").slice(0, 12);
}

function percent(value, total) {
  if (!total) return "0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function truncate(text, maxLength) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function messageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "you",
  "your",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "not",
  "but",
  "can",
  "cant",
  "can't",
  "just",
  "like",
  "from",
  "they",
  "them",
  "will",
  "would",
  "there",
  "their",
  "what",
  "when",
  "where",
  "about",
  "really",
  "please",
  "thanks",
  "thank",
  "heartopia",
  "game",
  "discord",
  "http",
  "https",
  "www",
  "com",
  "一个",
  "这个",
  "那个",
  "我们",
  "你们",
  "他们",
  "可以",
  "不是",
  "就是",
  "已经",
  "还是",
  "没有",
  "如果",
  "因为",
  "所以",
  "然后",
  "但是",
  "什么",
  "怎么",
  "自己",
  "una",
  "para",
  "por",
  "con",
  "que",
  "los",
  "las",
  "der",
  "die",
  "das",
  "und",
  "ich",
  "nicht",
  "ein",
  "eine",
]);

const POSITIVE_WORDS = [
  "love",
  "good",
  "great",
  "fun",
  "happy",
  "cute",
  "amazing",
  "enjoy",
  "thanks",
  "thank",
  "hilarious",
  "cool",
  "beautiful",
  "excited",
  "awesome",
  "helpful",
  "nice",
  "perfect",
  "like",
  "genial",
  "bueno",
  "gracias",
  "bom",
  "ótimo",
  "legal",
  "gut",
  "super",
  "danke",
  "喜歡",
  "喜欢",
  "好玩",
  "可爱",
  "可愛",
  "开心",
  "開心",
  "感谢",
  "謝謝",
  "谢谢",
  "有趣",
  "好笑",
  "棒",
  "不错",
  "不錯",
];

const NEGATIVE_WORDS = [
  "bad",
  "bug",
  "bugs",
  "crash",
  "lag",
  "stuck",
  "hate",
  "boring",
  "confusing",
  "problem",
  "problems",
  "issue",
  "issues",
  "broken",
  "disappointed",
  "expensive",
  "unfair",
  "hard",
  "cannot",
  "can't",
  "cant",
  "wrong",
  "spam",
  "upset",
  "frustrated",
  "terrible",
  "sucks",
  "error",
  "erro",
  "problema",
  "malo",
  "schlecht",
  "nervig",
  "问题",
  "問題",
  "卡",
  "卡顿",
  "卡頓",
  "崩溃",
  "崩潰",
  "闪退",
  "閃退",
  "不能",
  "无法",
  "無法",
  "讨厌",
  "討厭",
  "无聊",
  "無聊",
  "失望",
  "贵",
  "貴",
  "坑",
  "烦",
  "煩",
  "糟糕",
  "差",
];

const TOPICS = [
  {
    id: "bug",
    name: "Bug / 技术问题",
    keywords: [
      "bug",
      "crash",
      "lag",
      "stuck",
      "error",
      "issue",
      "problem",
      "broken",
      "login",
      "disconnect",
      "loading",
      "glitch",
      "卡",
      "卡顿",
      "崩溃",
      "闪退",
      "报错",
      "错误",
      "无法登录",
      "登不上",
    ],
  },
  {
    id: "gameplay",
    name: "活动 / 任务 / 玩法",
    keywords: [
      "event",
      "quest",
      "mission",
      "task",
      "whale",
      "canyon",
      "ocean",
      "cleanup",
      "pollution",
      "pollutant",
      "fishing",
      "fish",
      "season",
      "活动",
      "任務",
      "任务",
      "玩法",
      "鲸",
      "鯨",
      "海洋",
      "清理",
      "污染",
      "钓鱼",
      "釣魚",
    ],
  },
  {
    id: "shop",
    name: "付费 / 商店 / 奖励",
    keywords: [
      "shop",
      "store",
      "price",
      "paid",
      "pay",
      "purchase",
      "buy",
      "gem",
      "gems",
      "reward",
      "rewards",
      "sanrio",
      "bundle",
      "礼包",
      "禮包",
      "商店",
      "价格",
      "價格",
      "付费",
      "付費",
      "购买",
      "購買",
      "奖励",
      "獎勵",
    ],
  },
  {
    id: "content",
    name: "内容更新 / NPC / 外观",
    keywords: [
      "update",
      "npc",
      "vanya",
      "skin",
      "outfit",
      "clothes",
      "furniture",
      "house",
      "decor",
      "photo",
      "ugc",
      "更新",
      "角色",
      "万尼亚",
      "萬尼亞",
      "服装",
      "服裝",
      "家具",
      "房子",
      "装饰",
      "裝飾",
    ],
  },
  {
    id: "social",
    name: "社交 / 社群 / 多语言沟通",
    keywords: [
      "friend",
      "friends",
      "team",
      "guild",
      "server",
      "mod",
      "moderator",
      "language",
      "chat",
      "community",
      "social",
      "好友",
      "朋友",
      "队伍",
      "隊伍",
      "服务器",
      "伺服器",
      "版主",
      "语言",
      "語言",
      "聊天",
      "社群",
    ],
  },
  {
    id: "suggestion",
    name: "功能建议 / 体验优化",
    keywords: [
      "suggest",
      "suggestion",
      "feature",
      "improve",
      "improvement",
      "need",
      "want",
      "should",
      "hope",
      "add",
      "qol",
      "quality",
      "建议",
      "建議",
      "希望",
      "需要",
      "优化",
      "優化",
      "新增",
      "功能",
      "体验",
      "體驗",
    ],
  },
  {
    id: "moderation",
    name: "规则 / 管理 / 争议",
    keywords: [
      "rule",
      "rules",
      "ban",
      "mute",
      "report",
      "warning",
      "toxic",
      "drama",
      "complaint",
      "complaints",
      "callout",
      "规则",
      "規則",
      "封禁",
      "禁言",
      "举报",
      "舉報",
      "投诉",
      "投訴",
      "争议",
      "爭議",
      "管理",
    ],
  },
];
