/** Mutates and persists isolated cron session state around one run. */
import fs from "node:fs";
import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import type { resolveCronSession } from "./session.js";

type MutableSessionStore = Record<string, SessionEntry>;

/** Mutable cron session entry updated by an isolated run before persistence. */
export type MutableCronSessionEntry = SessionEntry;
/** Resolved cron session plus its mutable backing store and active entry. */
export type MutableCronSession = ReturnType<typeof resolveCronSession> & {
  store: MutableSessionStore;
  sessionEntry: MutableCronSessionEntry;
};
/** Live provider/model/auth-profile selection reported by the running session. */
export type CronLiveSelection = LiveSessionModelSelection;

type UpdateSessionStore = (
  storePath: string,
  update: (store: MutableSessionStore) => void,
) => Promise<void>;

/** Persists the currently selected mutable cron session entry to the session store. */
export type PersistCronSessionEntry = () => Promise<void>;

function cronTranscriptExists(entry: SessionEntry): boolean {
  const sessionFile = entry.sessionFile?.trim();
  return Boolean(sessionFile && fs.existsSync(sessionFile));
}

function normalizeSessionField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toNonResumableCronSessionEntry(entry: SessionEntry): SessionEntry {
  const next = { ...entry } as Partial<SessionEntry>;
  // If the transcript never materialized, do not persist stale resume handles
  // that would make the next cron run believe a resumable CLI session exists.
  delete next.sessionId;
  delete next.sessionFile;
  delete next.sessionStartedAt;
  delete next.lastInteractionAt;
  delete next.cliSessionIds;
  delete next.cliSessionBindings;
  delete next.claudeCliSessionId;
  return next as SessionEntry;
}

/** Creates the persistence callback that stores cron session metadata after a run. */
export function createPersistCronSessionEntry(params: {
  isFastTestEnv: boolean;
  cronSession: MutableCronSession;
  agentSessionKey: string;
  updateSessionStore: UpdateSessionStore;
}): PersistCronSessionEntry {
  return async () => {
    if (params.isFastTestEnv) {
      return;
    }
    const persistedEntry =
      isCronSessionKey(params.agentSessionKey) &&
      params.cronSession.sessionEntry.sessionId &&
      !cronTranscriptExists(params.cronSession.sessionEntry)
        ? toNonResumableCronSessionEntry(params.cronSession.sessionEntry)
        : params.cronSession.sessionEntry;
    // Update both the in-memory store and persisted JSON so later operations in
    // this process observe the same session entry that hit disk.
    params.cronSession.store[params.agentSessionKey] = persistedEntry;
    await params.updateSessionStore(params.cronSession.storePath, (store) => {
      store[params.agentSessionKey] = persistedEntry;
    });
  };
}

/** Adopts the session id/file produced by a run and preserves usage-family lineage. */
export function adoptCronRunSessionMetadata(params: {
  entry: MutableCronSessionEntry;
  sessionKey: string;
  runMeta?: {
    sessionId?: string;
    sessionFile?: string;
  };
}): boolean {
  const nextSessionId = normalizeSessionField(params.runMeta?.sessionId);
  const nextSessionFile = normalizeSessionField(params.runMeta?.sessionFile);
  if (!nextSessionFile) {
    return false;
  }

  let changed = false;
  const previousSessionId = params.entry.sessionId;
  if (nextSessionId && nextSessionId !== previousSessionId) {
    params.entry.sessionId = nextSessionId;
    params.entry.usageFamilyKey = params.entry.usageFamilyKey ?? params.sessionKey;
    params.entry.usageFamilySessionIds = Array.from(
      new Set([
        ...(params.entry.usageFamilySessionIds ?? []),
        ...(previousSessionId ? [previousSessionId] : []),
        nextSessionId,
      ]),
    );
    changed = true;
  }

  if (nextSessionFile !== params.entry.sessionFile) {
    params.entry.sessionFile = nextSessionFile;
    changed = true;
  }

  return changed;
}

/** Persists a changed skills snapshot onto the cron session entry outside fast tests. */
export async function persistCronSkillsSnapshotIfChanged(params: {
  isFastTestEnv: boolean;
  cronSession: MutableCronSession;
  skillsSnapshot: SkillSnapshot;
  nowMs: number;
  persistSessionEntry: PersistCronSessionEntry;
}) {
  if (
    params.isFastTestEnv ||
    params.skillsSnapshot === params.cronSession.sessionEntry.skillsSnapshot
  ) {
    return;
  }
  params.cronSession.sessionEntry = {
    ...params.cronSession.sessionEntry,
    updatedAt: params.nowMs,
    skillsSnapshot: params.skillsSnapshot,
  };
  await params.persistSessionEntry();
}

/** Records the selected provider/model before a cron run starts. */
export function markCronSessionPreRun(params: {
  entry: MutableCronSessionEntry;
  provider: string;
  model: string;
}) {
  params.entry.modelProvider = params.provider;
  params.entry.model = params.model;
  params.entry.systemSent = true;
}

type CronResolvedDeliveryContext = {
  ok: boolean;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

function setOptionalSessionField<K extends keyof SessionEntry>(
  entry: SessionEntry,
  key: K,
  value: SessionEntry[K] | undefined,
): void {
  if (value === undefined) {
    delete entry[key];
    return;
  }
  entry[key] = value;
}

/** Mirrors the resolved cron delivery target into the session before tool execution. */
export function seedCronSessionDeliveryContext(params: {
  entry: MutableCronSessionEntry;
  resolvedDelivery: CronResolvedDeliveryContext;
}): boolean {
  if (!params.resolvedDelivery.ok) {
    return false;
  }
  const normalized = normalizeSessionDeliveryFields({
    deliveryContext: {
      channel: params.resolvedDelivery.channel,
      to: params.resolvedDelivery.to,
      accountId: params.resolvedDelivery.accountId,
      threadId: params.resolvedDelivery.threadId,
    },
  });
  if (!normalized.deliveryContext?.channel || !normalized.deliveryContext.to) {
    return false;
  }

  // Async plugin watchers snapshot session routing while the cron turn is
  // running, before the final cron auto-delivery path executes.
  setOptionalSessionField(params.entry, "route", normalized.route);
  setOptionalSessionField(params.entry, "deliveryContext", normalized.deliveryContext);
  setOptionalSessionField(
    params.entry,
    "lastChannel",
    normalized.lastChannel as SessionEntry["lastChannel"],
  );
  setOptionalSessionField(params.entry, "lastTo", normalized.lastTo);
  setOptionalSessionField(params.entry, "lastAccountId", normalized.lastAccountId);
  setOptionalSessionField(params.entry, "lastThreadId", normalized.lastThreadId);
  return true;
}

/** Syncs live model/auth-profile changes from a running cron session back to storage. */
export function syncCronSessionLiveSelection(params: {
  entry: MutableCronSessionEntry;
  liveSelection: CronLiveSelection;
}) {
  params.entry.modelProvider = params.liveSelection.provider;
  params.entry.model = params.liveSelection.model;
  if (params.liveSelection.authProfileId) {
    params.entry.authProfileOverride = params.liveSelection.authProfileId;
    params.entry.authProfileOverrideSource = params.liveSelection.authProfileIdSource;
    if (params.liveSelection.authProfileIdSource === "auto") {
      // Auto-selected profiles are tied to the compaction generation that
      // resolved them; manual overrides should survive later compactions.
      params.entry.authProfileOverrideCompactionCount = params.entry.compactionCount ?? 0;
    } else {
      delete params.entry.authProfileOverrideCompactionCount;
    }
    return;
  }
  delete params.entry.authProfileOverride;
  delete params.entry.authProfileOverrideSource;
  delete params.entry.authProfileOverrideCompactionCount;
}
