# KClaw Research Platform Cron Migration

This file tracks the KClaw cron migration from the MyClaw runtime. It is not
runtime state. KClaw stores cron definitions in the OpenClaw SQLite state store,
not in `openclaw.json`.

## Current State

- KClaw cron store: empty at migration time.
- Source reference: MyClaw runtime `cron/jobs.json`.
- Registration path: use `openclaw cron add` through the KClaw Docker CLI.
- Do not copy MyClaw state, sessions, auth stores, pairing files, cron run
  history, or job ids into KClaw.
- Delivery targets are intentionally not stored here. Pass them at registration
  time with `KCLAW_CRON_FEISHU_MARKET_TO` and
  `KCLAW_CRON_FEISHU_STRATEGY_TO`.

## Activation Gate

- The registration script creates disabled jobs by default.
- Set `KCLAW_CRON_ENABLE=1` only after Feishu delivery, DeepSeek Pro model
  access, Pattern Strategy, Pattern Quotation, and watcher delivery have been
  validated in KClaw.
- If the script is rerun, it can create duplicate jobs. List existing jobs first
  and remove or keep intentionally.

## MyClaw Jobs

These are the MyClaw recurring jobs to preserve in KClaw:

| Job                              | Agent               | Cron           | TZ            | Timeout |
| -------------------------------- | ------------------- | -------------- | ------------- | ------- |
| quotation pre-market refresh     | `pattern-quotation` | `10 4 * * 1-6` | Asia/Shanghai | 1800s   |
| mid_term_accel daily scan        | `tas-dispatch`      | `10 5 * * 1-6` | Asia/Shanghai | 7200s   |
| strong_pivot_breakout daily scan | `tas-dispatch`      | `10 6 * * 1-6` | Asia/Shanghai | 7200s   |
| mid_term_reversal_opt daily scan | `tas-dispatch`      | `10 7 * * 1-6` | Asia/Shanghai | 7200s   |
| board index daily refresh        | `pattern-strategy`  | `0 9 * * 1-6`  | Asia/Shanghai | 1800s   |
| quotation post-open refresh      | `pattern-quotation` | `0 10 * * 1-6` | Asia/Shanghai | 1800s   |

All jobs use isolated agent sessions, `wake=now`, Feishu announce delivery, and
code-driven watchers. Quotation and board-index jobs are market-data jobs and
must use a direct Feishu user target (`user:<feishu-open-id>`) so terminal
completion reaches the operator DM. Strategy scan announcements may use the
research chat target. The first LLM turn must submit/register the watcher and
stop; it must not poll long-running Pattern jobs with the LLM.

## KClaw Prerequisites

- `pattern-quotation` must exist as an agent, not only as a plugin.
- `tas-dispatch`, `pattern-strategy`, and `pattern-quotation` should inherit the
  global DeepSeek Pro model.
- `pattern-quotation` only needs the `pattern-quotation-core` skill and the
  `pattern-quotation` tool group.

## Registration Commands

List current jobs first:

```bash
./scripts/docker/openclaw-service.sh cli cron list --all
```

Create the MyClaw-derived jobs as disabled jobs:

```bash
KCLAW_CRON_FEISHU_MARKET_TO='user:<feishu-open-id>' \
KCLAW_CRON_FEISHU_STRATEGY_TO='chat:<feishu-chat-id>' \
  ./scripts/kclaw/register-research-cron.sh
```

Create them enabled only after validation:

```bash
KCLAW_CRON_ENABLE=1 \
KCLAW_CRON_FEISHU_MARKET_TO='user:<feishu-open-id>' \
KCLAW_CRON_FEISHU_STRATEGY_TO='chat:<feishu-chat-id>' \
  ./scripts/kclaw/register-research-cron.sh
```

After registration:

```bash
./scripts/docker/openclaw-service.sh cli cron list --all
./scripts/docker/openclaw-service.sh cli cron status
```

Enable or disable individual jobs with the ids shown by `cron list --all`:

```bash
./scripts/docker/openclaw-service.sh cli cron enable <job-id>
./scripts/docker/openclaw-service.sh cli cron disable <job-id>
```
