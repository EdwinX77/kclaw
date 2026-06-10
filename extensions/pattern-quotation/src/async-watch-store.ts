import fs from "node:fs/promises";
import path from "node:path";

export type AsyncCompletionWakeMode = "now" | "next-heartbeat";
export type AsyncCompletionFollowupMode = "heartbeat-system-event";

export type QuotationRefreshAsyncWatch = {
  kind: "quotation_refresh";
  jobId: string;
  sessionKey: string;
  agentId: string;
  wakeMode: AsyncCompletionWakeMode;
  followupMode: AsyncCompletionFollowupMode;
  source?: string;
  requestKey?: string;
  runLabel?: string;
  refreshDate?: string;
  deliverySnapshot?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  lastRemoteStatus?: string;
  deliveryStatus?: "delivered" | "not-delivered" | "not-requested";
  registeredAt: number;
  updatedAt: number;
  completedAt?: number;
  lastError?: string;
};

type PatternQuotationAsyncWatchStore = {
  version: 1;
  watches: QuotationRefreshAsyncWatch[];
};

const DEFAULT_STORE: PatternQuotationAsyncWatchStore = {
  version: 1,
  watches: [],
};

const storeLocks = new Map<string, Promise<void>>();

function resolveStorePath(stateDir: string) {
  return path.join(stateDir, "pattern-quotation", "async-watches.json");
}

async function ensureDirFor(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readStore(filePath: string): Promise<PatternQuotationAsyncWatchStore> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PatternQuotationAsyncWatchStore> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.watches)) {
      return { ...DEFAULT_STORE };
    }
    return {
      version: 1,
      watches: parsed.watches.filter((entry): entry is QuotationRefreshAsyncWatch => {
        return Boolean(
          entry &&
          entry.kind === "quotation_refresh" &&
          typeof entry.jobId === "string" &&
          typeof entry.sessionKey === "string" &&
          typeof entry.agentId === "string",
        );
      }),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { ...DEFAULT_STORE };
    }
    throw error;
  }
}

async function writeStore(filePath: string, store: PatternQuotationAsyncWatchStore) {
  await ensureDirFor(filePath);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

async function withStoreLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = storeLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  storeLocks.set(
    filePath,
    previous.then(() => current),
  );
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (storeLocks.get(filePath) === current) {
      storeLocks.delete(filePath);
    }
  }
}

export async function listAsyncWatches(stateDir: string): Promise<QuotationRefreshAsyncWatch[]> {
  const filePath = resolveStorePath(stateDir);
  const store = await readStore(filePath);
  return store.watches.toSorted((a, b) => b.updatedAt - a.updatedAt);
}

export async function getAsyncWatch(params: {
  stateDir: string;
  jobId: string;
}): Promise<QuotationRefreshAsyncWatch | null> {
  const watches = await listAsyncWatches(params.stateDir);
  return watches.find((entry) => entry.jobId === params.jobId) ?? null;
}

export async function upsertAsyncWatch(params: {
  stateDir: string;
  watch: QuotationRefreshAsyncWatch;
}): Promise<QuotationRefreshAsyncWatch> {
  const filePath = resolveStorePath(params.stateDir);
  return await withStoreLock(filePath, async () => {
    const store = await readStore(filePath);
    const next = store.watches.filter((entry) => entry.jobId !== params.watch.jobId);
    next.push(params.watch);
    const saved = {
      version: 1 as const,
      watches: next.toSorted((a, b) => b.updatedAt - a.updatedAt),
    };
    await writeStore(filePath, saved);
    return params.watch;
  });
}

export async function updateAsyncWatch(
  stateDir: string,
  jobId: string,
  updater: (existing: QuotationRefreshAsyncWatch) => QuotationRefreshAsyncWatch,
): Promise<QuotationRefreshAsyncWatch | null> {
  const filePath = resolveStorePath(stateDir);
  return await withStoreLock(filePath, async () => {
    const store = await readStore(filePath);
    const idx = store.watches.findIndex((entry) => entry.jobId === jobId);
    if (idx < 0) {
      return null;
    }
    const existing = store.watches[idx]!;
    const updated = updater(existing);
    const next = store.watches.slice();
    next[idx] = updated;
    await writeStore(filePath, { version: 1, watches: next });
    return updated;
  });
}

export async function removeAsyncWatch(params: {
  stateDir: string;
  jobId: string;
}): Promise<boolean> {
  const filePath = resolveStorePath(params.stateDir);
  return await withStoreLock(filePath, async () => {
    const store = await readStore(filePath);
    const next = store.watches.filter((entry) => entry.jobId !== params.jobId);
    if (next.length === store.watches.length) {
      return false;
    }
    await writeStore(filePath, { version: 1, watches: next });
    return true;
  });
}
