import type {
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
  PluginHookBeforeDispatchResult,
} from "../../../src/plugins/hooks.js";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import {
  formatPatternStrategyResult,
  invokePatternStrategyTool,
  type PatternStrategyPluginConfig,
} from "./client.js";

export type ChanChartShortcutRequest = {
  symbol?: string;
  securityName?: string;
  startDate: string;
  endDate: string;
};

const CHAN_CHART_PATTERN = /(?:chan\s*(?:图|chart|走势图)|缠(?:论)?(?:图|走势图|走势))/iu;
const YEAR_TO_DATE_PATTERN = /(?:今年以来|年初至今|今年)/u;
const STOCK_SYMBOL_PATTERN = /\b((?:0|3|6|8|4)\d{5})(?:\.(?:SH|SZ|BJ))?\b/iu;
const LEADING_REQUEST_WORDS = [
  "请给我下",
  "请给我看下",
  "请给我看一下",
  "给我看一下",
  "给我看下",
  "帮我看一下",
  "帮我看下",
  "麻烦看一下",
  "麻烦看下",
  "请给我",
  "给我",
  "帮我",
  "麻烦",
  "看一下",
  "看下",
  "生成",
  "做",
  "画",
  "下",
] as const;

function formatShanghaiDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function stripLeadingRequestWords(value: string): string {
  let next = value.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of LEADING_REQUEST_WORDS) {
      if (next.startsWith(word)) {
        next = next.slice(word.length).trim();
        changed = true;
      }
    }
  }
  return next.replace(/^[:：,，\s]+|(?:的|这只|这支|股票)$/gu, "").trim();
}

function extractSecurityName(text: string): string | undefined {
  const dateMatch = YEAR_TO_DATE_PATTERN.exec(text);
  if (!dateMatch) {
    return undefined;
  }

  const chartMatch = CHAN_CHART_PATTERN.exec(text);
  const beforeDate = text.slice(0, dateMatch.index).trim();
  const afterDate =
    chartMatch && chartMatch.index > dateMatch.index
      ? text.slice(dateMatch.index + dateMatch[0].length, chartMatch.index).trim()
      : "";
  const candidate =
    extractSecurityNameCandidate(afterDate) ?? extractSecurityNameCandidate(beforeDate);
  if (!candidate || STOCK_SYMBOL_PATTERN.test(candidate)) {
    return undefined;
  }
  return candidate;
}

function extractSecurityNameCandidate(text: string): string | undefined {
  const tokens = [...text.matchAll(/[\p{Script=Han}A-Za-z0-9._-]{2,32}/gu)]
    .map((match) => stripLeadingRequestWords(match[0]))
    .filter(Boolean);
  return tokens.at(-1);
}

function extractSymbol(text: string): string | undefined {
  return text.match(STOCK_SYMBOL_PATTERN)?.[1]?.trim();
}

export function resolveChanChartShortcutRequest(
  content: string,
  now: Date = new Date(),
): ChanChartShortcutRequest | undefined {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!CHAN_CHART_PATTERN.test(normalized) || !YEAR_TO_DATE_PATTERN.test(normalized)) {
    return undefined;
  }

  const symbol = extractSymbol(normalized);
  const securityName = extractSecurityName(normalized);
  if (!symbol && !securityName) {
    return undefined;
  }

  const endDate = formatShanghaiDate(now);
  return {
    ...(symbol ? { symbol } : {}),
    ...(securityName ? { securityName } : {}),
    startDate: `${endDate.slice(0, 4)}-01-01`,
    endDate,
  };
}

function readPayloadData(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = (value as { data?: unknown }).data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

function readMediaDetails(value: unknown):
  | {
      mediaUrl: string;
      mediaUrls: string[];
      trustedLocalMedia: true;
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const details = (value as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const media = (details as { media?: unknown }).media;
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    return undefined;
  }
  const mediaUrl = (media as { mediaUrl?: unknown }).mediaUrl;
  const mediaUrls = (media as { mediaUrls?: unknown }).mediaUrls;
  if (typeof mediaUrl !== "string" || !Array.isArray(mediaUrls)) {
    return undefined;
  }
  const normalizedMediaUrls = mediaUrls.filter((url): url is string => typeof url === "string");
  if (!mediaUrl.trim() || normalizedMediaUrls.length === 0) {
    return undefined;
  }
  return {
    mediaUrl,
    mediaUrls: normalizedMediaUrls,
    trustedLocalMedia: true,
  };
}

function formatShortcutLabel(request: ChanChartShortcutRequest): string {
  const name = request.securityName?.trim();
  const symbol = request.symbol?.trim();
  if (name && symbol) {
    return `${name}（${symbol}）`;
  }
  return name || symbol || "Chan";
}

function readDataString(data: Record<string, unknown> | undefined, keys: readonly string[]) {
  if (!data) {
    return undefined;
  }
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readDataNumber(data: Record<string, unknown> | undefined, key: string) {
  const value = data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readDataRecord(data: Record<string, unknown> | undefined, key: string) {
  const value = data?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readChanSummaryRecord(data: Record<string, unknown> | undefined) {
  return readDataRecord(data, "fractal_strength_summary");
}

function readChanDetailRecord(data: Record<string, unknown> | undefined, key: string) {
  return readDataRecord(data, key) ?? readDataRecord(readChanSummaryRecord(data), key);
}

function readRecordNumber(record: Record<string, unknown> | undefined, keys: readonly string[]) {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readRecordString(record: Record<string, unknown> | undefined, keys: readonly string[]) {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function formatPrice(value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return value.toFixed(2).replace(/\.?0+$/u, "");
}

function formatShortcutSecurityLabel(
  request: ChanChartShortcutRequest,
  data: Record<string, unknown> | undefined,
) {
  const fallback = formatShortcutLabel(request);
  const name = readDataString(data, ["security_name", "name"]) ?? request.securityName?.trim();
  const symbol = readDataString(data, ["symbol", "code"]) ?? request.symbol?.trim();
  if (name && symbol && !name.includes(symbol)) {
    return `${name}（${symbol}）`;
  }
  return name || symbol || fallback;
}

function summarizeFractalStrength(value: string) {
  const normalized = value.toLowerCase();
  const direction = normalized.includes("bottom")
    ? "底分型"
    : normalized.includes("top")
      ? "顶分型"
      : "分型";
  const strength = normalized.includes("strong")
    ? "偏强"
    : normalized.includes("weak")
      ? "偏弱"
      : undefined;
  const volume = normalized.includes("volume") ? "，伴随量能变化" : "";
  return `${direction}${strength ?? ""}${volume}`;
}

function formatBoxLine(data: Record<string, unknown> | undefined) {
  const box = readChanDetailRecord(data, "latest_box");
  const bottom = formatPrice(readRecordNumber(box, ["bottom", "lower", "low"]));
  const top = formatPrice(readRecordNumber(box, ["top", "upper", "high"]));
  if (!bottom || !top) {
    return undefined;
  }
  const startDate = readRecordString(box, ["start_date", "startDate"]);
  const endDate = readRecordString(box, ["end_date", "endDate"]);
  const dateText =
    startDate || endDate ? `（${[startDate, endDate].filter(Boolean).join(" 至 ")}）` : "";
  return `- 中枢/箱体：最后一个箱体约 ${bottom}-${top} 元${dateText}。`;
}

function formatRecentPointLine(data: Record<string, unknown> | undefined) {
  const high = readChanDetailRecord(data, "recent_high");
  const low = readChanDetailRecord(data, "recent_low");
  const highPrice = formatPrice(readRecordNumber(high, ["value", "price", "high"]));
  const lowPrice = formatPrice(readRecordNumber(low, ["value", "price", "low"]));
  if (!highPrice && !lowPrice) {
    return undefined;
  }
  const highDate = readRecordString(high, ["date", "fractal_date"]);
  const lowDate = readRecordString(low, ["date", "fractal_date"]);
  const parts = [
    highPrice ? `最近顶分型 ${highPrice}${highDate ? `（${highDate}）` : ""}` : undefined,
    lowPrice ? `最近底分型 ${lowPrice}${lowDate ? `（${lowDate}）` : ""}` : undefined,
  ].filter(Boolean);
  return `- 最近高低点：${parts.join("；")}。`;
}

function formatCurrentPositionLine(data: Record<string, unknown> | undefined) {
  const box = readChanDetailRecord(data, "latest_box");
  const bottom = readRecordNumber(box, ["bottom", "lower", "low"]);
  const top = readRecordNumber(box, ["top", "upper", "high"]);
  const current = readChanDetailRecord(data, "current_price");
  const currentPrice =
    readRecordNumber(current, ["close", "value", "price"]) ?? readDataNumber(data, "current_price");
  const formattedCurrent = formatPrice(currentPrice);
  if (currentPrice === undefined || bottom === undefined || top === undefined || top <= bottom) {
    return "- 当前位置：先看最新价格是否脱离最近中枢/箱体，再用下方动能与成交量确认强弱；未脱离前按震荡结构阅读。";
  }
  const position =
    currentPrice < bottom
      ? "箱体下方"
      : currentPrice > top
        ? "箱体上方"
        : currentPrice <= bottom + (top - bottom) / 3
          ? "箱体内部偏下"
          : currentPrice >= top - (top - bottom) / 3
            ? "箱体内部偏上"
            : "箱体内部中部";
  return `- 当前位置：最新收盘约 ${formattedCurrent} 元，位于${position}；未有效脱离箱体前按震荡结构阅读。`;
}

function formatChanChartExplanation(data: Record<string, unknown> | undefined) {
  const structure =
    readDataString(data, [
      "structure_summary",
      "chan_structure_summary",
      "trend_summary",
      "analysis_summary",
      "summary",
    ]) ?? "图中上半区是 K 线与 Chan 结构标注，重点看最新价格相对最近中枢/箱体上下沿的位置。";
  const signalsDetected = readDataNumber(data, "signals_detected");
  const signalText =
    signalsDetected === undefined
      ? "工具已完成图表标注；具体分型、笔和中枢位置以图中标记为准。"
      : `本次检测到 ${signalsDetected} 个结构信号；具体触发点以图中标记为准。`;
  const fractalSummary = readDataString(data, ["fractal_strength_summary"]);
  const fractalText = fractalSummary ? `- 分型：${summarizeFractalStrength(fractalSummary)}。` : "";
  const boxText = formatBoxLine(data);
  const pointText = formatRecentPointLine(data);
  const currentPositionText = formatCurrentPositionLine(data);

  return [
    "图解摘要：",
    `- 结构：${structure}`,
    `${boxText ?? ""}`,
    `${pointText ?? ""}`,
    `- 信号：${signalText}`,
    `${fractalText}`,
    currentPositionText,
  ]
    .filter((line) => line.trim())
    .join("\n");
}

function formatChanChartShortcutReply(params: {
  request: ChanChartShortcutRequest;
  data: Record<string, unknown> | undefined;
}) {
  const label = formatShortcutSecurityLabel(params.request, params.data);
  return `${label} 今年以来 Chan 走势图已生成。\n\n${formatChanChartExplanation(params.data)}`;
}

function formatRemoteToolError(payload: { error?: { code?: string; message?: string } }) {
  const code = payload.error?.code?.trim();
  const message = payload.error?.message?.trim() || "Remote tool call failed";
  return code ? `${code}: ${message}` : message;
}

export async function handleChanChartBeforeDispatch(
  api: OpenClawPluginApi,
  event: PluginHookBeforeDispatchEvent,
  _ctx: PluginHookBeforeDispatchContext,
): Promise<PluginHookBeforeDispatchResult | undefined> {
  const request = resolveChanChartShortcutRequest(event.content || event.body || "");
  if (!request) {
    return undefined;
  }

  const pluginConfig = api.pluginConfig as PatternStrategyPluginConfig | undefined;
  try {
    const payload = await invokePatternStrategyTool({
      pluginConfig,
      toolName: "chan.generate_chart",
      args: {
        ...(request.symbol ? { symbol: request.symbol } : {}),
        ...(request.securityName ? { security_name: request.securityName } : {}),
        start_date: request.startDate,
        end_date: request.endDate,
        use_price_cache: true,
      },
      logger: api.logger,
      logContext: {
        source: "openclaw_before_dispatch",
        triggerType: "feishu_chan_chart_shortcut",
      },
    });
    if (payload.ok === false) {
      throw new Error(formatRemoteToolError(payload));
    }

    const result = await formatPatternStrategyResult({
      remoteToolName: "chan.generate_chart",
      payload,
      pluginConfig,
    });
    const media = readMediaDetails(result);
    if (!media) {
      throw new Error("chan.generate_chart did not return sendable chart media");
    }

    const data = readPayloadData(result.details);
    return {
      handled: true,
      reply: {
        text: formatChanChartShortcutReply({ request, data }),
        mediaUrl: media.mediaUrl,
        mediaUrls: media.mediaUrls,
        trustedLocalMedia: media.trustedLocalMedia,
        channelData: { feishu: { mediaFirst: true } },
      },
    };
  } catch (error) {
    api.logger.warn(
      `pattern-strategy chan chart shortcut failed; falling back to agent dispatch: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}
