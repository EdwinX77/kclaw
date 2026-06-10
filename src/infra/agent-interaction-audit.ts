import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type AgentInteractionAuditKind =
  | "sessions_send_request"
  | "sessions_send_result"
  | "subagent_spawn"
  | "subagent_lifecycle"
  | "subagent_wait_result"
  | "async_watch_registered"
  | "async_watch_progress"
  | "async_watch_completed"
  | "async_watch_failed"
  | (string & {});

export type AgentInteractionAuditRecord = {
  ts?: number;
  kind: AgentInteractionAuditKind;
  requesterSessionKey?: string;
  targetSessionKey?: string;
  childSessionKey?: string;
  sessionKey?: string;
  agentId?: string;
  targetAgentId?: string;
  runId?: string;
  jobId?: string;
  status?: string;
  summary?: string;
  data?: Record<string, unknown>;
};

const writesByPath = new Map<string, Promise<void>>();

export function resolveAgentInteractionAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "logs", "agent-interactions.jsonl");
}

export async function appendAgentInteractionAuditRecord(record: AgentInteractionAuditRecord) {
  const filePath = resolveAgentInteractionAuditPath(process.env);
  const line = JSON.stringify({
    ts: typeof record.ts === "number" ? record.ts : Date.now(),
    ...record,
  });
  const prev = writesByPath.get(filePath) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await fs.appendFile(filePath, `${line}\n`, { encoding: "utf-8", mode: 0o600 });
    });
  writesByPath.set(filePath, next);
  try {
    await next;
  } finally {
    if (writesByPath.get(filePath) === next) {
      writesByPath.delete(filePath);
    }
  }
}
