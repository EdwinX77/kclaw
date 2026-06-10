import fs from "node:fs/promises";
import path from "node:path";

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | string;

export type AutomationRunRecordInput = {
  runTime?: string;
  source?: string;
  category: string;
  taskFamily: string;
  taskKey: string;
  cronJobId?: string;
  businessJobId?: string;
  status: AutomationRunStatus;
  rawCount?: number;
  returnedCount?: number;
  symbols?: string[];
  overrides?: unknown;
  notes?: string;
};

export type AutomationRunRecord = Required<
  Omit<AutomationRunRecordInput, "rawCount" | "returnedCount" | "symbols" | "overrides" | "notes">
> & {
  rawCount: number | null;
  returnedCount: number | null;
  symbols: string[];
  overrides: unknown;
  notes: string;
  recordedAt: number;
};

export type AutomationRunFilter = {
  category?: string;
  taskFamily?: string;
  taskKey?: string;
  status?: string;
  source?: string;
  limit?: number;
};

const storeLocks = new Map<string, Promise<void>>();

export function resolveAutomationRunStorePath(stateDir: string) {
  return path.join(stateDir, "pattern-strategy", "automation-runs.jsonl");
}

export function resolveAutomationRunMemoryPath(params: { workspaceDir: string; relPath?: string }) {
  const relPath = normalizeMemoryRelPath(params.relPath);
  const workspaceDir = path.resolve(params.workspaceDir);
  const filePath = path.resolve(workspaceDir, relPath);
  if (filePath !== workspaceDir && !filePath.startsWith(`${workspaceDir}${path.sep}`)) {
    throw new Error(`automation run memory path escapes workspace: ${relPath}`);
  }
  return { relPath, filePath };
}

export async function recordAutomationRun(params: {
  stateDir: string;
  workspaceDir?: string;
  memoryRelPath?: string;
  record: AutomationRunRecordInput;
}): Promise<AutomationRunRecord> {
  const record = normalizeAutomationRunRecord(params.record);
  const storePath = resolveAutomationRunStorePath(params.stateDir);
  await withStoreLock(storePath, async () => {
    await ensureDirFor(storePath);
    await fs.appendFile(storePath, `${JSON.stringify(record)}\n`, "utf-8");
  });
  if (params.workspaceDir) {
    const { filePath } = resolveAutomationRunMemoryPath({
      workspaceDir: params.workspaceDir,
      relPath: params.memoryRelPath,
    });
    await withStoreLock(filePath, async () => {
      await appendAutomationRunMarkdown(filePath, record);
    });
  }
  return record;
}

export async function listAutomationRuns(params: {
  stateDir: string;
  filter?: AutomationRunFilter;
}): Promise<AutomationRunRecord[]> {
  const storePath = resolveAutomationRunStorePath(params.stateDir);
  const records = await readAutomationRunRecords(storePath);
  const filtered = records.filter((entry) => matchesFilter(entry, params.filter));
  const sorted = filtered.toSorted((a, b) => b.recordedAt - a.recordedAt);
  const limit = normalizeLimit(params.filter?.limit);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

export async function getLatestAutomationRun(params: {
  stateDir: string;
  filter?: AutomationRunFilter;
}): Promise<AutomationRunRecord | null> {
  const [latest] = await listAutomationRuns({
    stateDir: params.stateDir,
    filter: { ...params.filter, limit: 1 },
  });
  return latest ?? null;
}

function normalizeAutomationRunRecord(input: AutomationRunRecordInput): AutomationRunRecord {
  const now = Date.now();
  return {
    runTime: normalizeText(input.runTime) || formatShanghaiTime(now),
    source: normalizeText(input.source) || "openclaw_cron",
    category: requireText(input.category, "category"),
    taskFamily: requireText(input.taskFamily, "task_family"),
    taskKey: requireText(input.taskKey, "task_key"),
    cronJobId: normalizeText(input.cronJobId) || "-",
    businessJobId: normalizeText(input.businessJobId) || "-",
    status: requireText(input.status, "status"),
    rawCount: normalizeCount(input.rawCount),
    returnedCount: normalizeCount(input.returnedCount),
    symbols: normalizeSymbols(input.symbols),
    overrides: input.overrides ?? null,
    notes: normalizeText(input.notes),
    recordedAt: now,
  };
}

async function readAutomationRunRecords(filePath: string): Promise<AutomationRunRecord[]> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as AutomationRunRecord;
        return isAutomationRunRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

async function appendAutomationRunMarkdown(filePath: string, record: AutomationRunRecord) {
  await ensureAutomationRunMarkdown(filePath);
  await fs.appendFile(filePath, `${formatMarkdownRow(record)}\n`, "utf-8");
}

async function ensureAutomationRunMarkdown(filePath: string) {
  try {
    await fs.access(filePath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  await ensureDirFor(filePath);
  const header = [
    "# Automation Runs",
    "",
    "| run_time | source | category | task_family | task_key | cron_job_id | business_job_id | status | raw_count | returned_count | symbols | overrides | notes |",
    "|---|---|---|---|---|---|---|---|---:|---:|---|---|---|",
    "",
  ].join("\n");
  await fs.writeFile(filePath, header, "utf-8");
}

function formatMarkdownRow(record: AutomationRunRecord) {
  return [
    record.runTime,
    record.source,
    record.category,
    record.taskFamily,
    record.taskKey,
    record.cronJobId,
    record.businessJobId,
    record.status,
    record.rawCount ?? "-",
    record.returnedCount ?? "-",
    record.symbols.length > 0 ? record.symbols.join(", ") : "-",
    compactJson(record.overrides),
    record.notes || "-",
  ]
    .map((value) => escapeMarkdownCell(String(value)))
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function matchesFilter(record: AutomationRunRecord, filter: AutomationRunFilter | undefined) {
  if (!filter) {
    return true;
  }
  return (
    matchesOptional(record.category, filter.category) &&
    matchesOptional(record.taskFamily, filter.taskFamily) &&
    matchesOptional(record.taskKey, filter.taskKey) &&
    matchesOptional(record.status, filter.status) &&
    matchesOptional(record.source, filter.source)
  );
}

function matchesOptional(value: string, expected: string | undefined) {
  const normalizedExpected = normalizeText(expected).toLowerCase();
  if (!normalizedExpected) {
    return true;
  }
  return value.toLowerCase() === normalizedExpected;
}

function normalizeMemoryRelPath(value: string | undefined) {
  const normalized = normalizeText(value) || "memory/automation-runs.md";
  return normalized.replace(/^\/+/, "");
}

function normalizeLimit(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(200, Math.trunc(value)));
}

function normalizeCount(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizeSymbols(value: string[] | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(value.map((entry) => normalizeText(entry)).filter((entry) => entry.length > 0)),
  );
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function requireText(value: unknown, label: string) {
  const text = normalizeText(value);
  if (!text) {
    throw new Error(`${label} required`);
  }
  return text;
}

function compactJson(value: unknown) {
  if (value === null || value === undefined) {
    return "-";
  }
  return JSON.stringify(value);
}

function escapeMarkdownCell(value: string) {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function isAutomationRunRecord(value: unknown): value is AutomationRunRecord {
  const record = value as Partial<AutomationRunRecord> | null;
  return Boolean(
    record &&
    typeof record.runTime === "string" &&
    typeof record.source === "string" &&
    typeof record.category === "string" &&
    typeof record.taskFamily === "string" &&
    typeof record.taskKey === "string" &&
    typeof record.cronJobId === "string" &&
    typeof record.businessJobId === "string" &&
    typeof record.status === "string" &&
    typeof record.recordedAt === "number",
  );
}

function formatShanghaiTime(timestampMs: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestampMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} Asia/Shanghai`;
}

async function ensureDirFor(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function withStoreLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = storeLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current);
  storeLocks.set(filePath, next);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (storeLocks.get(filePath) === next) {
      storeLocks.delete(filePath);
    }
  }
}
