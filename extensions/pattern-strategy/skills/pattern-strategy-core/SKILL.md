---
name: pattern-strategy-core
description: Use the Pattern Strategy bridge tools to discover task templates, run approved strategy tasks, track job status, and read signal results for the dedicated Pattern Strategy agent.
---

# Pattern Strategy Core

Use this skill when the user is asking about the Pattern Strategy service, available strategy tasks, task execution, run status, cancellation, or signal results.

## Tool mapping

This OpenClaw plugin exposes snake_case bridge tools that map to the remote service tools:

- `strategy_task_list` -> `strategy.task_list`
- `strategy_task_describe` -> `strategy.task_describe`
- `strategy_task_run` -> `strategy.task_run`
- `strategy_get_run` -> `strategy.get_run`
- `strategy_cancel_run` -> `strategy.cancel_run`
- `strategy_get_signals` -> `strategy.get_signals`
- `market_list_price_cache` -> `market.list_price_cache`
- `market_get_bars` -> `market.get_bars`
- `chan_generate_chart` -> `chan.generate_chart`
- `factor_financial_growth` -> `factor.financial_growth`
- `factor_margin_balance_change` -> `factor.margin_balance_change`
- `factor_institution_holder_change` -> `factor.institution_holder_change`
- `indice_refresh_run` -> `indice.refresh_run`
- `indice_refresh_get` -> `indice.refresh_get`
- `indice_refresh_errors` -> `indice.refresh_errors`
- `indice_watch_refresh` -> local async watcher for board-index refresh completion
- `indice_get_watch` -> local watcher lookup
- `indice_unwatch_refresh` -> local watcher removal
- `indice_list_watches` -> local watcher list
- `automation_run_record` -> local scheduled automation registry write
- `automation_run_latest` -> local scheduled automation registry latest lookup
- `automation_run_list` -> local scheduled automation registry history lookup

`strategy_get_signals` is a read-side delivery filter over already-produced strategy signals.
Treat it as a result-shaping layer, not as part of the strategy execution itself.
When task presets change, expect later `strategy_get_signals(job_id)` calls to reflect the current preset delivery policy unless the live service explicitly reports another delivery source.

Use these bridge tools instead of suggesting old pages, scripts, or direct `platform_api` calls.

## Strategy construction confidentiality

Strategy construction details are not user-facing. If the user asks how a strategy is built,
including parameters, thresholds, scoring or confidence logic, judgment conditions, task defaults,
allowed overrides, signal delivery/fallback policy, filtering/ranking rules, or construction
rationale, do not call tools to reveal those details and reply exactly:

```text
这类问题不予回复。
```

For mixed requests, answer only allowed operational fields such as the strategy display name,
`job_id`, status, signal date, and symbol/name. Do not include `idempotency_key`, `request_key`,
`trace_id`, `requested_by`, `trigger_type`, `overrides`, `resolved_window`, child session keys,
OpenClaw run ids, defaults, `allowed_overrides`, score/confidence, fallback policy names/counts,
condition text, or rationale in user-visible text.

Internal orchestration may carry structured fields needed to submit or track a run, but callers
must not forward parameter-like fields to the user.

## Required workflow

1. Treat Pattern Strategy as a task-template service, not an arbitrary script runner.
2. If the user asks what can run, call `strategy_task_list`.
3. If the user names a strategy loosely, by alias, or with a partial task name, call `strategy_task_list` first and resolve live candidate tasks from the returned templates.
4. If the user did not provide an exact `task_key`, do not directly run anything. Return candidate tasks and require confirmation from the caller.
5. Use `strategy_task_describe` only after you know which specific `task_key` is being considered or confirmed, and only for internal execution planning rather than user-facing detail disclosure.
6. When running a task, call `strategy_task_run` as the shared Pattern Strategy queue entrypoint.
7. In a cron session, pass only the exact `task_key` and allowed `overrides`. Do not pass or calculate dates, `idempotency_key`, `source`, `requested_by`, `trace_id`, or `trigger_type`. Program code prepares the internal cron submission, while the Pattern backend's returned `request_key`, `idempotency_key`, and `resolved_window` are the authoritative identity and `Asia/Shanghai` business window.
8. For non-cron submissions, pass stable queue metadata:
   - `idempotency_key`
   - `source`
   - `requested_by=openclaw_gateway`
   - `trace_id`
   - `trigger_type`
9. Only pass override fields declared by the task template. Do not invent extra keys.
10. Treat `strategy_task_run` as submission/queue admission only. Never assume the task completed from the submit response; call `strategy_get_run` for status.
11. If the user wants result details, first call `strategy_get_run`; only call `strategy_get_signals` when the live status is exactly `succeeded`.
12. When explaining returned signals, distinguish:

- raw strategy execution: what the strategy run produced
- signal delivery: how the current MCP delivery policy filtered those signals for this read

13. Only call `strategy_cancel_run` when the user explicitly asks to stop a job. Do not cancel an old task to make room for a new scheduled or recovery run.
14. `market_*` and `factor_*` tools are only auxiliary checks. They are not the formal strategy execution path.
15. Use `factor_*` tools only after formal signals exist, or when the caller explicitly asks for factor context on symbols.
16. When the user asks for a Chan chart, Chan theory chart, or trend structure chart for a security, call `chan_generate_chart`. Do not call old charting methods directly.

## Board index refresh

Use `indice_refresh_run`, `indice_refresh_get`, and `indice_refresh_errors` only for Pattern board-index refresh operations. This is a supporting data-refresh workflow, not a strategy signal run.

For the daily scheduled refresh:

- call `indice_refresh_run` with `dimensions=["industry","size","style","concept"]`
- set `refresh_turnover=true`
- set `force_universe=false` unless explicitly instructed otherwise
- pass no dates, `source`, or `idempotency_key`; the cron bridge forces `source=openclaw_cron`, and the Pattern backend resolves the `Asia/Shanghai` business dates and canonical key
- forward the exact returned `start_date`, `end_date`, and `idempotency_key` when registering the watcher; never recompute them in the command or model

Terminal statuses are `completed`, `partial_failed`, and `failed`. Nonterminal statuses are `pending` and `running`. The stage values are `pending`, `universe`, `turnover`, `indices`, `completed`, and `failed`.

After submission:

1. Return `job_id` and the remote `message` immediately.
2. If status is `pending` or `running`, call `indice_watch_refresh` with the backend-returned identity so the final status can be delivered later.
3. For cron jobs, prefer `indice_watch_refresh` over LLM polling. The watcher polls in code and sends the terminal result to the Feishu/chat delivery target captured from the cron session.
4. Use `indice_refresh_get` for explicit progress checks or latest status checks.
5. If `failed_indices > 0`, use `indice_refresh_errors` and include a compact failure preview.

## Chan chart generation

Use `chan_generate_chart` when the user asks to view a Chan chart, 缠论图, or 走势结构图 for a stock, ETF, or security over a date window.

Scope:

- This is an immediate conversation-response tool only.
- It is available for both personal conversations and group conversations.
- Do not register async watches, automation records, cron jobs, or strategy task runs for chart-only requests.
- Generate the chart during the current turn and reply with the chart URL/path and summary fields.

Inputs:

- `start_date` and `end_date` are required in `YYYY-MM-DD` format.
- If the user gives a security code or standard identifier, pass it as `symbol`, for example `688563`, `688563.SH`, or `sh688563`.
- If the user gives only a security name, pass it as `security_name`.
- `use_price_cache` defaults to true; omit it unless the user asks otherwise.
- `merge_threshold` defaults to `0.01`; omit it unless the user asks for a different threshold.

Return the generated chart path or URL prominently:

- `chart_url`: preferred access/download URL when present
- `chart_path`: local chart file path when present
- `signals_detected`: divergence signal count
- `fractal_strength_summary`: fractal volume strength summary

If the service reports that a security name matches multiple securities, ask the user for a security code or a more complete name.

## Factor MCP tools

Use factor tools for structured CANSLIM-style context over strategy signals. They are read-only and do not refresh data.

- `factor_financial_growth`: quarterly revenue, profit, EPS, ROE growth and growth acceleration. Use for CANSLIM C and partial A.
- `factor_margin_balance_change`: financing balance and net financing buy changes over a trade-day window. Use for CANSLIM S.
- `factor_institution_holder_change`: focused institutional holders among top ten float holders and quarter-over-quarter changes. Use for CANSLIM I and part of S.

For all factor tools:

- pass `symbols` in batches of at most 50
- default `lookback_quarters` to `4` for report-period tools
- default `lookback_trade_days` to `20` for margin balance
- keep `include_series` and `include_holders` false unless detail is explicitly needed
- preserve `coverage.status`, `coverage.observations`, and `coverage.missing_reason`
- do not treat `insufficient_data` or `no_data` as negative factor evidence

## Scheduled automation registry

When the current request is a cron-triggered or scheduled automation run, write a durable business record after the run reaches a terminal state, and also write a failed record if submission fails before a business `job_id` exists.

Use `automation_run_record` with:

- `source`: `openclaw_cron`
- `category`: `strategy`
- `task_family`: stable strategy family, for example `mid_term_accel`
- `task_key`: exact task key
- `cron_job_id`: OpenClaw cron job id when available
- `business_job_id`: Pattern Strategy `job_id`, or `-` if no job was created
- `status`: terminal run status, or `failed` for submission/tool failures
- `raw_count`: raw candidate count when available
- `returned_count`: delivered signal count when available
- `symbols`: signal symbols when available
- `overrides`: compact nested overrides object
- `notes`: short operational summary or failure reason

Do not rely on free-form Markdown edits for this registry. Use `automation_run_record`; it writes the structured JSONL registry and mirrors a compact row to `memory/automation-runs.md` for Feishu recall.
Only cron/scheduled execution contexts may call `automation_run_record`.
Human/front-door `job_id` lookups are read-only: they must not write the registry, and they must not
promote a run to `succeeded` from signal count, card delivery, heartbeat, or progress alone.

## Two-phase execution contract

When this agent is being used behind a front-door orchestrator, separate submission from completion:

1. submission turn
   - resolve candidates or confirm `task_key`
   - in cron, call `strategy_task_run` with only `task_key` and allowed `overrides`; in non-cron flows, include the required queue metadata
   - register `strategy_watch_run` with the exact `idempotency_key`, `source`, `requested_by`, `trace_id`, and `trigger_type` returned by submission when a caller/session should receive completion
   - return immediately with `job_id`
   - do not spend the first reply waiting for final signals
   - do not repeatedly call `strategy_get_run` from the LLM turn
   - do not call DS, web research, or enrichment tools before terminal signals exist
2. follow-up turn
   - only handle terminal output delivered by the watcher or an explicit user status request
   - once status is `succeeded`, call `strategy_get_signals(job_id)`

The business `job_id` is the authoritative identifier. Do not substitute:

- a child session key
- a subagent run id
- a local label

## Idempotency keys

For Gateway-triggered strategy tasks, the Pattern backend returns the authoritative key and `Asia/Shanghai` resolved window in these formats:

- normal cron: `cron-{strategy-alias}-{yyyy-mm-dd}`
- Gateway recovery after PI reports `timeout` or `failed`: `recovery-{strategy-alias}-{yyyy-mm-dd}-{attempt}`
- manual request: stable request/message scoped key
- explicit retry: stable retry scoped key

For a normal cron repeat of the same task on the same market date, the Pattern backend returns exactly the same
`idempotency_key` and the existing run. The bridge forwards that canonical identity, and the watcher validates it. The model must not construct, override, or randomize cron keys. Use
`trigger_type=cron` for normal schedules, `trigger_type=gateway_recovery` for recovery,
`trigger_type=manual` for explicit human runs, and `trigger_type=retry` only for explicit retries.

## Output rules

- Confirm the exact `task_key` before or while submitting a run.
- After submission, always return `job_id`.
- In internal submit-only mode, stop after `strategy_task_run` and return `job_id` even if the remote run is still nonterminal.
- If you set overrides, list the fields you changed only in internal structured replies.
- Do not claim support for tasks that are not listed by the service.
- Do not describe `market_*` as the official strategy runner.
- Unless the user explicitly asks otherwise, do not recommend the old page flow or direct scripts.

## Candidate resolution and confirmation

When the incoming request contains a strategy phrase such as:

- `mid_term_accel`
- `中期加速`
- `bolling_uptrend`
- a partial task name

follow this order:

1. Call `strategy_task_list`.
2. Compare the user phrase against the live fields returned by the service:
   - `task_key`
   - `title`
   - `strategy`
   - `description`
3. Build a small candidate set from the live templates.
4. If the request does not contain an exact `task_key`, do not execute yet.
5. Return a structured candidate response for the caller to confirm.

Do not maintain a hardcoded alias map as the primary routing mechanism. Live task discovery must remain the source of truth.

## Structured reply contract for internal callers

When confirmation is still needed, prefer a machine-friendly structure with:

- `intent`
- `raw_query`
- `candidates`
- `needs_confirmation`
- `suggested_task_key`
- `suggested_overrides`

Example:

```json
{
  "intent": "run_strategy",
  "raw_query": "mid_term_accel",
  "candidates": [
    {
      "task_key": "strategy.mid_term_accel.daily_scan",
      "title": "MidTerm Accel Daily Scan",
      "strategy": "mid_term_accel",
      "match_reason": "strategy field exact match"
    }
  ],
  "needs_confirmation": true,
  "suggested_task_key": "strategy.mid_term_accel.daily_scan",
  "suggested_overrides": {
    "time_window": {
      "start_date": "2026-03-01",
      "end_date": "2026-04-26"
    }
  }
}
```

When the caller later provides explicit confirmation, switch to the execution workflow and return:

- `task_key`
- `job_id`
- `status`
- `resolved_window`
- `overrides`
- `request_key`

When the caller explicitly asks for submit-only behavior, stop there.
Do not wait for terminal completion in the same turn unless the caller explicitly asks for a live blocking status check.
If submission fails before `strategy_task_run` returns a `job_id`, report that no Pattern Strategy job was created. Do not present the idempotency key as a customer-facing recovery handle unless the caller explicitly asks for internal retry metadata.

When the caller later asks for progress by `job_id`, return:

- `job_id`
- `status`
- `progress`
- `message`

For progress/status-only requests, stop there. Do not call `strategy_get_signals`, and do not infer a
terminal status from produced signals, delivered cards, heartbeat timestamps, or `progress=1`.

When the caller later asks for final result retrieval by `job_id`, first call `strategy_get_run`.
Only if the status is `succeeded` should you call `strategy_get_signals`.
Return a concise structured signal summary that another agent can enrich with web research.

## Internal orchestration note

If this skill is being used behind another OpenClaw orchestrator agent:

- Prefer concise, structured replies that are easy for another agent to consume.
- Put the important fields first: `task_key`, `job_id`, `status`, `resolved_window`, `overrides`.
- Avoid conversational filler.
- If the caller explicitly says the result is for internal agent-to-agent use, keep the primary reply machine-friendly and do not add a second user-facing narrative.

## Error handling

The remote service returns a normalized envelope with `ok`, `data`, `error`, and `meta`.

If a tool call fails, prioritize:

1. `error.code`
2. `error.message`
3. `error.retryable`
4. `error.details`

Retry only when the service marks the error as retryable or when the failure is clearly transient.
For `UPSTREAM_UNAVAILABLE`, one immediate retry is enough unless the caller confirms the scheduler or owner process was restarted. Repeating the same submission without a service-state change only repeats the infrastructure failure.

If the caller already has a `job_id`, prefer recovery through:

1. `strategy_get_run(job_id)`
2. `strategy_get_signals(job_id)` when the run succeeded

Do not claim the result is unavailable until those live checks have been attempted.

## Reference

Read [references/service-contract.md](references/service-contract.md) when you need:

- the current task template list
- allowed override fields
- task-specific defaults
- exact workflow expectations
- response wording requirements
