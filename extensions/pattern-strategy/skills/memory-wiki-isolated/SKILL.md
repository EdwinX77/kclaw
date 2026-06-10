---
name: memory-wiki-isolated
description: Use an isolated research-memory workflow for market notes and durable evidence, keeping research memory separate from the execution agent and ready for a future memory-wiki plugin or QMD backend.
---

# Memory Wiki Isolated

Use this skill when you want durable research memory, but you want it isolated from the front-door agent and from the raw strategy execution agent.

## Purpose

Keep long-lived market notes in a dedicated research workspace so that:

- the Feishu-facing agent stays lean
- the Pattern Strategy execution agent stays deterministic
- research context can grow without contaminating execution prompts

## Current recommendation

Until a dedicated memory-wiki plugin is installed and verified, use the isolated memory agent with the default memory tools (`memory_search`, `memory_get`) and a dedicated workspace.

Recommended internal session target:

- `agent:market-memory:main`

## What belongs here

- durable notes about symbol narratives
- repeated catalysts or recurring risk patterns
- sector-level context worth reusing
- analyst-style evidence summaries

## What does not belong here

- transient execution status
- one-off run bookkeeping that only matters for a single job
- unverified rumors without clear labeling

## Future upgrade path

When the memory-wiki plugin is available, attach it to this isolated agent instead of the strategy execution agent. After the rest of the flow is stable, consider upgrading the gateway memory backend to QMD for stronger local recall.

## Community skill note

This skill is intentionally separate from the community skills installed from ClawHub:

- `summarize-pro`
- `web-research-assistant`
- `agent-skills-context-engineering`

Those skills help with summarization, web research, and context design. This skill only defines how to keep research memory isolated from the Feishu-facing and strategy-execution agents.
