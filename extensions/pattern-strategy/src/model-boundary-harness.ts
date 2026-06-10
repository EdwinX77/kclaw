export const MARKET_TIMEZONE = "Asia/Shanghai";

export const CANSLIM_OUTPUT_SECTIONS = [
  "技术信号",
  "CANSLIM 补充",
  "非 CANSLIM 舆情/热度",
  "信息缺口",
  "交易原则检查",
  "说明",
] as const;

export const STRATEGY_CONSTRUCTION_DETAIL_REPLY = "这类问题不予回复。";

export function buildStrategyConstructionConfidentialityRule() {
  return [
    "Strategy construction confidentiality:",
    `- If the user asks for strategy construction details, reply exactly: ${STRATEGY_CONSTRUCTION_DETAIL_REPLY}`,
    "- Treat parameters, thresholds, scoring/confidence logic, judgment conditions, task defaults, allowed overrides, signal delivery/fallback policy, filtering/ranking rules, and construction rationale as confidential.",
    "- User-visible signal feedback must not include parameter names or values, threshold/count/window details, scoring/confidence values, override fields, task defaults, fallback policy names/counts, or condition/rationale text.",
    "- For mixed requests, answer only allowed operational fields such as strategy display name, job_id, status, signal date, symbols/names, and non-parameter caveats.",
  ].join("\n");
}

export type MarketDateText = `${number}-${number}-${number}`;

export function extractMarketDateText(value: unknown): MarketDateText | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? formatMarketDate(value) : undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  if (hasExplicitTimezone(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return formatMarketDate(new Date(parsed));
    }
  }
  const match = /\d{4}-\d{2}-\d{2}/.exec(trimmed);
  return match?.[0] as MarketDateText | undefined;
}

function hasExplicitTimezone(value: string) {
  return /(?:z|[+-]\d{2}:?\d{2})$/i.test(value);
}

export function formatMarketDate(date: Date, timeZone = MARKET_TIMEZONE): MarketDateText {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}` as MarketDateText;
}

export function marketDateDayNumber(value: unknown): number | undefined {
  const text = extractMarketDateText(value);
  if (!text) {
    return undefined;
  }
  const [year, month, day] = text.split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) {
    return undefined;
  }
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function isOutsideRecentMarketWindow(params: {
  referenceDate: unknown;
  signalDate: unknown;
  recentDays: number;
}) {
  const referenceDay = marketDateDayNumber(params.referenceDate);
  const signalDay = marketDateDayNumber(params.signalDate);
  if (referenceDay === undefined || signalDay === undefined || params.recentDays <= 0) {
    return false;
  }
  return referenceDay - signalDay > Math.floor(params.recentDays);
}

export function buildCanslimEnrichmentContract() {
  return [
    "Required skill: canslim-enrichment.",
    "This callback is about an existing Pattern Strategy job, not a new user request.",
    buildStrategyConstructionConfidentialityRule(),
    `Market timezone: ${MARKET_TIMEZONE}. Treat signal_date/end_date as China A-share market dates, not UTC dates.`,
    "Before any web_search/web_fetch/browser call, call all available Pattern Strategy factor tools for the formal signal symbols:",
    "- factor_financial_growth",
    "- factor_margin_balance_change",
    "- factor_institution_holder_change",
    "Do not submit a new strategy task from this callback.",
    "Do not narrate your process, tool plan, search progress, or intermediate conclusions. Feishu must receive only one final user-facing Chinese summary.",
    "Do not write English progress text such as 'Let me fetch', 'Now I have', 'Stage 1', or 'I will check'.",
    "Do not describe fallback/history rows as today's new signals.",
    "Final Feishu reply must use these sections exactly and in this order:",
    ...CANSLIM_OUTPUT_SECTIONS.map((section, index) => `${index + 1}. ${section}`),
    "Keep CANSLIM, sentiment, heat, and trading principles as context only; they never replace the formal Pattern Strategy signal.",
  ].join("\n");
}

export function validateCanslimOutputShape(text: string) {
  const missingSections = CANSLIM_OUTPUT_SECTIONS.filter((section) => !text.includes(section));
  return {
    ok: missingSections.length === 0,
    missingSections,
  };
}

export function isFrontDoorAgentDirectExecution(params: {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
}) {
  if (params.toolName !== "strategy_task_run") {
    return false;
  }
  const agentId = params.agentId?.trim();
  if (agentId !== "tas-dispatch") {
    return false;
  }
  const sessionKey = params.sessionKey?.trim() ?? "";
  return !sessionKey.includes(":cron:");
}
