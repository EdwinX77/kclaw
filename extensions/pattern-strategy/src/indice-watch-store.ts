import fs from "node:fs/promises";
import path from "node:path";
import type { AsyncCompletionWakeMode } from "./async-watch-store.js";

export type IndiceRefreshAsyncWatch = {
  kind: "indice_refresh";
  jobId: string;
  sessionKey: string;
  agentId: string;
  wakeMode: AsyncCompletionWakeMode;
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

type IndiceRefreshAsyncWatchStore = {
  version: 1;
  watches: IndiceRefreshAsyncWatch[];
};

const DEFAULT_STORE: IndiceRefreshAsyncWatchStore = {
  version: 1,
  watches: [],
};

const storeLocks = new Map<string, Promise<void>>();

function resolveStorePath(stateDir: string) {
  return path.join(stateDir, "pattern-strategy", "indice-watches.json");
}

async function ensureDirFor(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readStore(filePath: string): Promise<IndiceRefreshAsyncWatchStore> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<IndiceRefreshAsyncWatchStore> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.watches)) {
      return { ...DEFAULT_STORE };
    }
    return {
      version: 1,
      watches: parsed.watches.filter((entry): entry is IndiceRefreshAsyncWatch => {
        return Boolean(
          entry &&
          entry.kind === "indice_refresh" &&
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

async function writeStore(filePath: string, store: IndiceRefreshAsyncWatchStore) {
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

export async function listIndiceAsyncWatches(stateDir: string): Promise<IndiceRefreshAsyncWatch[]> {
  const filePath = resolveStorePath(stateDir);
  const store = await readStore(filePath);
  return store.watches.toSorted((a, b) => b.updatedAt - a.updatedAt);
}

export async function getIndiceAsyncWatch(params: {
  stateDir: string;
  jobId: string;
}): Promise<IndiceRefreshAsyncWatch | null> {
  const watches = await listIndiceAsyncWatches(params.stateDir);
  return watches.find((entry) => entry.jobId === params.jobId) ?? null;
}

export async function upsertIndiceAsyncWatch(params: {
  stateDir: string;
  watch: IndiceRefreshAsyncWatch;
}): Promise<IndiceRefreshAsyncWatch> {
  const filePath = resolveStorePath(params.stateDir);
  return await withStoreLock(filePath, async () => {
    const store = await readStore(filePath);
    const next = store.watches.filter((entry) => entry.jobId !== params.watch.jobId);
    next.push(params.watch);
    await writeStore(filePath, {
      version: 1,
      watches: next.toSorted((a, b) => b.updatedAt - a.updatedAt),
    });
    return params.watch;
  });
}

export async function updateIndiceAsyncWatch(
  stateDir: string,
  jobId: string,
  updater: (existing: IndiceRefreshAsyncWatch) => IndiceRefreshAsyncWatch,
): Promise<IndiceRefreshAsyncWatch | null> {
  const filePath = resolveStorePath(stateDir);
  return await withStoreLock(filePath, async () => {
    const store = await readStore(filePath);
    const idx = store.watches.findIndex((entry) => entry.jobId === jobId);
    if (idx < 0) {
      return null;
    }
    const existing = store.watches[idx]!;
    const next = store.watches.slice();
    next[idx] = updater(existing);
    await writeStore(filePath, { version: 1, watches: next });
    return next[idx];
  });
}

export async function removeIndiceAsyncWatch(params: {
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
