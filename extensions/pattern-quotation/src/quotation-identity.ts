export const MARKET_TIMEZONE = "Asia/Shanghai";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function readMarketDate(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return undefined;
  }
  return normalized;
}

export function buildQuotationIdempotencyKey(params: {
  startDate: string;
  endDate: string;
  chainKey?: string;
  stages?: string[];
}) {
  const compact = (value: string) => value.replaceAll("-", "");
  const datePart =
    params.startDate === params.endDate
      ? compact(params.endDate)
      : `${compact(params.startDate)}-${compact(params.endDate)}`;
  if (params.chainKey === "custom" || (!params.chainKey && params.stages?.length)) {
    return `quotation:stages:${params.stages?.join("+") ?? ""}:${datePart}`;
  }
  return `quotation:${params.chainKey ?? "custom"}:${datePart}`;
}
