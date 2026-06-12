---
name: feishu-report-writer
description: Write compact Feishu reports for group collaboration, strategy review, market recap, and exception alerts.
---

# Feishu Report Writer

Use this skill for Feishu group posts, strategy recaps, market close summaries, exception alerts, and team handoff notes.

## Format

- Start with a one-line conclusion.
- Use short sections: market, strategy, risk, follow-up.
- Keep group reports compact; put long background in a linked artifact or Gmail review draft.
- Use explicit status labels: normal, watch, warning, blocked.
- Include owner or next action only when it is known.

## Safety

- Do not include credentials, auth state, private tokens, raw session IDs, or unredacted personal data.
- Do not claim a cron, MCP server, or channel delivered successfully unless the current run proves it.
- For uncertain data, say "待确认" and name what needs confirmation.
