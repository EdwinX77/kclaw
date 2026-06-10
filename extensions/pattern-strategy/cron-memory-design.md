# Pattern Strategy Cron Memory Design

## Goal

Provide a durable execution registry for OpenClaw-triggered scheduled tasks so the Feishu front-door agent can answer questions such as:

- latest strategy execution
- latest mid-term acceleration run
- latest market capture job
- whether a cron-triggered task has completed
- latest job id, status, signals, and follow-up context

The design must support more than one strategy. It should also cover future market monitoring or signal-capture jobs that are not strictly Pattern Strategy scans.

## Current Problem

Feishu interactive requests run in the `tas-dispatch` direct-message session. Cron jobs usually run as isolated sessions under `cron:<jobId>:run:<sessionId>`.

That isolation is correct for reliability, but it means the Feishu session does not automatically know what a scheduled run did. Cron run logs contain execution status, but the business identifiers that matter to users, such as Pattern Strategy `job_id`, `task_key`, signal counts, and symbols, are buried in a separate run transcript.

The missing bridge is a shared, durable business index.

## Design Summary

Use three complementary records:

1. Cron job registry
   - Source: `.openclaw-runtime/cron/jobs.json`
   - Purpose: scheduler state, cron job ids, next run, last run status.

2. Cron run history
   - Source: `.openclaw-runtime/cron/runs/<cronJobId>.jsonl`
   - Purpose: technical execution history, errors, duration, delivery status, isolated session id.

3. Business run memory
   - Source: `.openclaw-runtime/workspace/tas-dispatch/memory/automation-runs.md`
   - Purpose: queryable business index for Feishu. This is the primary lookup surface for Tas.

The cron agentTurn must write a normalized record into `memory/automation-runs.md` after every run, regardless of success or failure.

## Data Model

Use one row per scheduled business run.

Required fields:

| Field | Description |
|---|---|
| `run_time` | Run completion time, ISO or `YYYY-MM-DD HH:mm Asia/Shanghai` |
| `source` | `openclaw_cron` |
| `category` | `strategy`, `market_capture`, `research`, or future category |
| `task_family` | Stable family name, for example `mid_term_accel` |
| `task_key` | Concrete task key, for example `strategy.mid_term_accel.daily_scan` |
| `cron_job_id` | OpenClaw cron job id |
| `business_job_id` | Pattern Strategy `job_id`, market capture id, or equivalent business run id |
| `status` | `queued`, `running`, `succeeded`, `failed`, `skipped`, or provider-native terminal status |
| `raw_count` | Raw candidate count if available |
| `returned_count` | Returned or delivered item count if available |
| `symbols` | Comma-separated symbols if available |
| `overrides` | Compact JSON string for important params |
| `notes` | Short human-readable summary |

Recommended file:

```md
# Automation Runs

| run_time | source | category | task_family | task_key | cron_job_id | business_job_id | status | raw_count | returned_count | symbols | overrides | notes |
|---|---|---|---|---|---|---|---|---:|---:|---|---|---|
```

For large result sets, keep the table row compact and add details below it:

```md
## claw_xxx

- run_time: 2026-04-30 15:20 Asia/Shanghai
- source: openclaw_cron
- category: strategy
- task_family: mid_term_accel
- task_key: strategy.mid_term_accel.daily_scan
- cron_job_id: cron_xxx
- business_job_id: claw_xxx
- status: succeeded
- raw_count: 64
- returned_count: 1
- symbols: 300054.SZ
- overrides: {"selection":{"limit":7000},"execution":{"max_workers":7}}
- notes: signal_delivery returned one recent signal.
```

## Cron Job Prompt Contract

Every scheduled task prompt should include an explicit write-back contract.

Template:

```text
Execute the scheduled automation task.

Task metadata:
- category: strategy
- task_family: mid_term_accel
- task_key: strategy.mid_term_accel.daily_scan

Execution rules:
1. Submit the live task and capture the business job id.
2. Poll until terminal status when feasible.
3. Fetch final business result, including raw_count, returned_count, and symbols when available.
4. Append a normalized record to memory/automation-runs.md.
5. The memory record must include run_time, source, category, task_family, task_key, cron_job_id, business_job_id, status, raw_count, returned_count, symbols, overrides, and notes.
6. If the task fails before a business_job_id is created, still write a failed record with error details in notes.

Parameter rules:
- Pattern Strategy overrides must use nested objects, not dotted path keys.
- Example overrides: {"selection":{"limit":7000},"execution":{"max_workers":7}}

Final response:
Return a concise Chinese summary with task_key, business_job_id, status, raw_count, returned_count, and symbols.
```

For the current mid-term acceleration task:

```text
Execute the scheduled automation task.

Task metadata:
- category: strategy
- task_family: mid_term_accel
- task_key: strategy.mid_term_accel.daily_scan

Execution rules:
1. Submit Pattern Strategy task strategy.mid_term_accel.daily_scan without asking the user for confirmation.
2. Use nested overrides only: {"selection":{"limit":7000},"execution":{"max_workers":7}}
3. Poll until the run reaches a terminal status.
4. Fetch signals after success.
5. Append a normalized record to memory/automation-runs.md.
6. Use source=openclaw_cron.
7. Use business_job_id for the Pattern Strategy job_id.
8. Include raw_count, returned_count, symbols, and overrides in the memory record.

Final response:
Summarize in Chinese: task_key, job_id, status, raw_count, returned_count, and signal symbols.
```

## Feishu Query Contract

Add this rule to the `tas-dispatch` workspace instructions:

```md
When the user asks for latest strategy execution, latest signal run, latest cron-triggered task, latest market capture, or job_id:
1. Search `memory/automation-runs.md` first.
2. If needed, call cron list/runs to inspect scheduler history.
3. Use the latest `business_job_id` to call the live business system, such as Pattern Strategy get_run/get_signals.
4. Treat live business status as authoritative over memory.
5. Reply with the latest run time, task family, business job id, status, counts, and symbols.
```

## Tool Requirements

The front-door agent `tas-dispatch` should have:

```json5
tools: {
  allow: [
    "read",
    "write",
    "cron",
    "group:memory",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
    "pattern-strategy",
    "group:web",
    "browser",
  ],
}
```

Rationale:

- `cron`: inspect scheduled jobs and run history.
- `group:memory`: search and read `memory/automation-runs.md`.
- `write`: allow scheduled agent turns to append/update memory records.
- `pattern-strategy`: validate latest business status from the source of truth.

For stricter security, create a dedicated writer agent with only `read`, `write`, and relevant business tools, then run cron jobs under that agent instead of granting broad write access to `tas-dispatch`.

## Query Flow

When user asks: "最新中期加速任务怎么样了?"

1. `memory_search`
   - query: `latest mid_term_accel automation run business_job_id`
2. `memory_get`
   - path: `memory/automation-runs.md`
   - read the latest matching lines.
3. Pattern Strategy live lookup
   - `get_run` with `business_job_id`
   - `get_signals` if status is succeeded.
4. Feishu answer
   - latest run time
   - task key
   - job id
   - status
   - raw count
   - returned count
   - signals
   - notes or next action

## Failure Handling

The cron job should write memory even when the task fails:

```md
| 2026-04-30 15:20 Asia/Shanghai | openclaw_cron | strategy | mid_term_accel | strategy.mid_term_accel.daily_scan | cron_xxx | - | failed | 0 | 0 | - | {"selection":{"limit":7000}} | submission failed: timeout connecting to Pattern Strategy |
```

This prevents Feishu from saying it has no context. It can report that the latest scheduled attempt failed and why.

## Extension To Other Tasks

For another strategy:

- `category`: `strategy`
- `task_family`: strategy slug, for example `bolling_uptrend`
- `task_key`: concrete task key
- `business_job_id`: Pattern Strategy job id

For market capture:

- `category`: `market_capture`
- `task_family`: capture type, for example `sector_rotation`, `limit_up_watch`, `news_sentiment`
- `task_key`: stable capture key
- `business_job_id`: capture run id, feed batch id, or generated run id
- `raw_count`: scanned items
- `returned_count`: surfaced items
- `symbols`: symbols or sectors

The Feishu query path stays the same: search `automation-runs.md`, then validate against the live system if one exists.

## Implementation Phases

Phase 1: Prompt-only write-back

- Add `memory/automation-runs.md`.
- Update cron job prompt to append records after each run.
- Add Feishu query rule to `tas-dispatch` instructions.
- Add needed tool permissions.

Phase 2: Dedicated automation registry

- Add a small local tool or plugin action, for example `automation_run_record`.
- The tool validates required fields and appends JSONL/Markdown deterministically.
- Cron prompts call that tool instead of free-form writing Markdown.

Phase 3: First-class lookup

- Add `automation_run_list` and `automation_run_latest` tools.
- Feishu agent can query latest run by `category`, `task_family`, `status`, or time window.
- Keep memory summary for semantic recall, but use the registry tool as source of truth.

## Recommended Starting Point

Start with Phase 1.

It requires no new code and solves the immediate issue. Once several strategies or market tasks are added, move to Phase 2 so records are written by a structured tool rather than model-authored Markdown.
