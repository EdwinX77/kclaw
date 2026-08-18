import type { PluginLogger } from "../../../src/plugins/types.js";
import { invokePatternStrategyTool, type PatternStrategyPluginConfig } from "./client.js";
import {
  extractMarketDateText,
  MARKET_TIMEZONE,
  type MarketDateText,
} from "./model-boundary-harness.js";

export type LatestAvailableTradeDate = {
  tradeDate: MarketDateText;
  isTradingDay: boolean;
  dataReady: boolean;
  previousTradeDate: MarketDateText | null;
  source: string;
  asOf: string;
};

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function formatMarketAsOf(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get(
    "second",
  )}+08:00`;
}

function parseMarketDate(dateText: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) {
    throw new Error(`invalid market date: ${dateText}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > lastDay) {
    throw new Error(`invalid market date: ${dateText}`);
  }
  return { year, month, day };
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function shiftMarketDateByMonths(dateText: string, deltaMonths: number) {
  const parsed = parseMarketDate(dateText);
  const zeroBasedMonth = parsed.month - 1 + deltaMonths;
  const targetYear = parsed.year + Math.floor(zeroBasedMonth / 12);
  const targetMonthIndex = ((zeroBasedMonth % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  const lastTargetDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(parsed.day, lastTargetDay);
  return `${targetYear}-${pad2(targetMonth)}-${pad2(targetDay)}`;
}

export function parseLatestAvailableTradeDateData(params: { data: unknown; asOf: string }) {
  const data = readRecord(params.data);
  if (!data) {
    throw new Error("market.latest_available_trade_date returned empty data");
  }
  const tradeDate = extractMarketDateText(data.trade_date);
  if (!tradeDate) {
    throw new Error("market.latest_available_trade_date returned invalid trade_date");
  }
  const dataReady = readBoolean(data, "data_ready") ?? false;
  return {
    tradeDate,
    isTradingDay: readBoolean(data, "is_trading_day") ?? false,
    dataReady,
    previousTradeDate: extractMarketDateText(data.previous_trade_date) ?? null,
    source: readString(data, "source") ?? "unknown",
    asOf: params.asOf,
  } satisfies LatestAvailableTradeDate;
}

export async function resolveLatestAvailableTradeDate(params: {
  pluginConfig?: PatternStrategyPluginConfig;
  logger?: PluginLogger;
  asOf?: string;
}) {
  const asOf = params.asOf?.trim() || formatMarketAsOf();
  const payload = await invokePatternStrategyTool({
    pluginConfig: params.pluginConfig,
    toolName: "market.latest_available_trade_date",
    args: {
      market: "CN_A",
      as_of: asOf,
      purpose: "daily_scan",
    },
    logger: params.logger,
  });
  if (payload.ok === false) {
    const code = payload.error?.code?.trim();
    const message = payload.error?.message?.trim() || "market latest trade date lookup failed";
    throw new Error(code ? `${code}: ${message}` : message);
  }
  return parseLatestAvailableTradeDateData({ data: payload.data, asOf });
}
