# Pattern Strategy Service Contract

You are connected to the Pattern Strategy OpenClaw service. The service runs on the same host and exposes tools through `openclaw_mcp`, while `platform_api` executes the underlying strategy work.

Important:

- Treat live tool responses as authoritative.
- If `strategy.task_list` or `strategy.task_describe` returns values that differ from this reference file, trust the live tool output.
- This file is only an operational reference and can lag behind runtime task-preset changes.

## Access

- `openclaw_mcp` base URL: `http://127.0.0.1:18080`
- tool discovery: `GET /tools`
- tool invoke: `POST /tools/{tool_name}/invoke`
- health check: `GET /healthz`
- `platform_api`: `http://127.0.0.1:18000`

If another OpenClaw deployment needs to wire this service in, the target is:

- `base_url: http://127.0.0.1:18080`
- `list_tools: GET /tools`
- `invoke_tool: POST /tools/{tool_name}/invoke`

## Boundaries

- `openclaw_mcp`: unified tool exposure, response normalization, error normalization, Feishu command forwarding
- `platform_api`: task template definitions, parameter validation, run submission, status polling, signal retrieval
- old pages and `TaskScheduler`: legacy paths, not the preferred route

## Primary rules

1. Prefer `strategy.task_run` for execution.
2. If task details are missing, inspect with `strategy.task_list` or `strategy.task_describe`.
3. Pass only template-declared overrides.
4. Manual and recovery `strategy.task_run` calls require stable Gateway queue metadata:
   `idempotency_key`, `source`, `requested_by`, `trace_id`, and `trigger_type`. In an OpenClaw cron session the model passes only `task_key` and allowed `overrides`; the Pattern backend's returned identity and `resolved_window` are authoritative and must be forwarded unchanged.
5. Track nonterminal states with `strategy.get_run`.
6. Read detailed results with `strategy.get_signals` after success.
7. Cancel only on explicit user request; never cancel to preempt a scheduled run.
8. Use `market.*` only for auxiliary market checks.

Interpretation note:

- `signal_delivery` is a read-side result filter for signal retrieval.
- It should be explained separately from the underlying strategy execution.
- If live tool output shows a delivery-source field, trust that field to explain whether the current task preset or another source shaped the returned signals.

## Available remote tools

### `strategy.task_list`

- Lists registered task templates.
- Key output: `task_key`, `title`, `strategy`, `description`, `defaults`, `allowed_overrides`

### `strategy.task_describe`

- Input: `task_key`
- Key output: default time window, default selection scope, default strategy params, allowed override paths

### `strategy.task_run`

- Manual/recovery input: `task_key`, `idempotency_key`, `source`, `requested_by`, `trace_id`, `trigger_type`
- OpenClaw cron bridge input: `task_key` plus optional `overrides`; the Pattern backend returns the canonical `request_key`, `idempotency_key`, and `resolved_window`, which the bridge forwards unchanged
- Optional: `overrides`, `run_label`
- Key output: `job_id`, `run_id`, `strategy`, `status`, `backend`, `request_key`, `resolved_window`
- `job_id` and `run_id` can currently be treated as the same execution identifier
- Treat the output as submission/queue state. Always use `strategy.get_run` for completion status.

### `strategy.get_run`

- Input: `job_id`
- Key output: `job_id`, `job_type`, `strategy`, `status`, `backend`, `progress`, `message`
- Statuses include `accepted`, `queued`, `running`, `succeeded`, `failed`, `cancelled`,
  `cancelling`, and `timeout`.

### `strategy.cancel_run`

- Input: `job_id`
- Key output: `status`

### `strategy.get_signals`

- Input: `job_id`
- Optional: `limit`, `order`
- Returns signal rows produced by the run
- Applies the MCP-facing signal-delivery policy when shaping the returned result set
- Returns delivery metadata describing how the read was filtered

### `indice.refresh_run`

- Starts a Pattern board-index refresh.
- Manual input: explicit `start_date`, `end_date`, dimensions/options, and a stable idempotency key.
- OpenClaw cron bridge input: dimensions/options only. The bridge forces `source=openclaw_cron`; Pattern resolves the `Asia/Shanghai` business window and canonical idempotency key.
- Key output: `job_id`, `status`, `start_date`, `end_date`, `idempotency_key`, `source`.
- Treat the returned dates and key as authoritative and forward them unchanged to `indice_watch_refresh`.

### `market.list_price_cache`

- Lists local market cache metadata

### `market.get_bars`

- Input: `symbol`
- Optional: `adjustment`, `window`, `compare_live`
- Key output: `metadata`, `rows`, `live_rows`

### `chan.generate_chart`

- Generates a Chan theory chart using the current chart pipeline.
- Intended only for immediate conversation responses.
- Available from both personal and group conversations.
- Do not route chart-only requests through cron, async watch registration, automation records, or strategy task execution.
- Required: `start_date`, `end_date`
- Optional identifier: `symbol` or `security_name`
- Optional: `use_price_cache` (default true), `merge_threshold` (default `0.01`)
- Key output: `chart_url`, `chart_path`, `signals_detected`, `fractal_strength_summary`
- Use `security_name` when the user gives only a security name. Use `symbol` when the user gives a code or standard security identifier.

## Registered task templates

Note:

- The task template values below are only a snapshot.
- Runtime-managed defaults can change through the MCP admin surface and runtime config overrides.
- For any mutable fields such as `selection.*`, `execution.*`, or `signal_delivery.*`, always prefer live `strategy.task_list` or `strategy.task_describe` output over this file.

### `strategy.mid_term_accel.daily_scan`

- Description: mid-term acceleration daily scan
- Defaults:
  - `time_window.anchor = latest_trade_day`
  - `time_window.lookback_days = 60`
  - `selection.include_symbols = "*"`
  - `selection.limit = 7000`
  - `strategy_params.lookback_months = 12`
  - `strategy_params.merge_threshold = 0.01`
  - `execution.generate_charts = true`
  - `execution.export_csv = true`
  - `execution.max_workers = 7`
  - `signal_delivery.mode = recent_window_with_fallback`
  - `signal_delivery.date_field = end_date`
  - `signal_delivery.calendar_type = trade_day`
  - `signal_delivery.recent_days = 5`
  - `signal_delivery.fallback_mode = latest_n`
  - `signal_delivery.fallback_count = 3`
  - `signal_delivery.max_items = 10`
  - `signal_delivery.group_by_symbol = false`
- Allowed overrides:
  - `time_window.start_date`
  - `time_window.end_date`
  - `selection.include_symbols`
  - `selection.exclude_symbols`
  - `selection.limit`
  - `strategy_params.lookback_months`
  - `strategy_params.merge_threshold`
  - `execution.generate_charts`
  - `execution.export_csv`
  - `execution.max_workers`
  - `signal_delivery.enabled`
  - `signal_delivery.mode`
  - `signal_delivery.date_field`
  - `signal_delivery.calendar_type`
  - `signal_delivery.recent_days`
  - `signal_delivery.fallback_mode`
  - `signal_delivery.fallback_count`
  - `signal_delivery.max_items`
  - `signal_delivery.group_by_symbol`

### `strategy.mid_term_reversal_opt.daily_scan`

- Description: mid-term reversal optimization daily scan
- Defaults:
  - `time_window.anchor = latest_trade_day`
  - `time_window.lookback_days = 60`
  - `selection.include_symbols = "*"`
  - `selection.limit = 7000`
  - `strategy_params.lookback_months = 6`
  - `strategy_params.merge_threshold = 0.01`
  - `strategy_params.confirm_window_days = 5`
  - `strategy_params.confirm_volume_multiplier_min = 1.2`
  - `strategy_params.confirm_volume_multiplier_max = 1.5`
  - `strategy_params.confirm_max_return_pct = 5.0`
  - `execution.generate_charts = true`
  - `execution.export_csv = true`
  - `execution.max_workers = 7`
- Allowed overrides:
  - `time_window.start_date`
  - `time_window.end_date`
  - `selection.include_symbols`
  - `selection.exclude_symbols`
  - `selection.limit`
  - `strategy_params.lookback_months`
  - `strategy_params.merge_threshold`
  - `strategy_params.confirm_window_days`
  - `strategy_params.confirm_volume_multiplier_min`
  - `strategy_params.confirm_volume_multiplier_max`
  - `strategy_params.confirm_max_return_pct`
  - `execution.generate_charts`
  - `execution.export_csv`
  - `execution.max_workers`

### `strategy.bolling_uptrend.daily_scan`

- Description: Bolling Uptrend daily scan
- Defaults:
  - `time_window.anchor = latest_trade_day`
  - `time_window.lookback_days = 40`
  - `selection.include_symbols = "*"`
  - `selection.limit = 50`
  - `strategy_params.consecutive_days_above_ma20 = 4`
  - `strategy_params.first_day_volume_increase_pct = 50.0`
  - `strategy_params.min_upper_band_touches = 3`
  - `execution.generate_charts = true`
  - `execution.export_csv = true`
  - `execution.max_workers = 4`
- Allowed overrides:
  - `time_window.start_date`
  - `time_window.end_date`
  - `selection.include_symbols`
  - `selection.exclude_symbols`
  - `selection.limit`
  - `strategy_params.consecutive_days_above_ma20`
  - `strategy_params.first_day_volume_increase_pct`
  - `strategy_params.min_upper_band_touches`
  - `execution.generate_charts`
  - `execution.export_csv`
  - `execution.max_workers`

## Override rules

1. `time_window.start_date` and `time_window.end_date` must appear together.
2. If no explicit dates are given, the service resolves the window from `anchor + lookback_days`.
3. Extra fields outside `allowed_overrides` cause validation errors.
4. Suggested idempotency keys for explicit non-cron requests:

- manual: `manual:{task_key}:{timestamp_or_request_id}`
- Feishu: `feishu:{chat_id}:{message_id}`

Scheduled keys come only from the Pattern backend's canonical response; the model and prompt must not construct them.

## Recommended workflows

### Ask what can run

1. Call `strategy.task_list`
2. Summarize task names, strategies, and purpose
3. If needed, call `strategy.task_describe`

### Run a task now

1. Confirm `task_key`
2. Build valid `overrides`
3. For a normal OpenClaw cron session, pass only `task_key` and allowed `overrides`; the Pattern backend derives and returns the authoritative `idempotency_key=cron-{strategy-alias}-{yyyy-mm-dd}` plus `request_key` and `resolved_window` under its `Asia/Shanghai` task policy. Do not calculate or pass those fields from the model. For Gateway recovery after PI reports `timeout` or `failed`, request `trigger_type=gateway_recovery` and forward the backend's canonical recovery identity unchanged.
4. Call `strategy.task_run`
5. Return `job_id`, status, and resolved window
6. If continued tracking is requested, call `strategy.get_run`

### Read results

1. Call `strategy.get_run`
2. If succeeded, call `strategy.get_signals`
3. Summarize count, key symbols, notable structure, and the current delivery interpretation

### Stop a task

1. Confirm `job_id`
2. Call `strategy.cancel_run` only for explicit manual cancellation
3. Return cancel status

## Error envelope

Remote responses follow:

- `ok`
- `tool_name`
- `data`
- `error`
- `meta`

If `ok=false`, inspect:

- `error.code`
- `error.message`
- `error.retryable`
- `error.details`

Common codes:

- `VALIDATION_ERROR`
- `RESOURCE_NOT_FOUND`
- `JOB_CONFLICT`
- `UPSTREAM_UNAVAILABLE`
- `UPSTREAM_TIMEOUT`
- `INTERNAL_ERROR`

## Feishu note

Feishu is only an input surface. It is not a separate execution backend. Feishu-originated requests still map to the same strategy and market tools.

## Wording requirements

1. Prefer `task_key` when confirming the task.
2. Always return `job_id` after submission.
3. List override fields you changed.
4. Do not claim support for missing tasks.
5. Do not describe `market.*` as the official strategy entrypoint.
6. Do not suggest old interfaces unless the user explicitly asks.

## Additional note

- This service is designed as `task template + unified execution entry`, not arbitrary strategy script execution.
- Other OpenClaw deployments need both the prompt/skill guidance and explicit registration of the Pattern Strategy service endpoint: `http://127.0.0.1:18080`.
- New strategies should be introduced as new `task_key` templates, not by stitching old low-level parameters together.
