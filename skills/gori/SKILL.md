---
name: gori
description: Real-time pairing bridge between two AI coding sessions working in separate repos or directories (e.g. backend + frontend on one change). Engage when this session's work needs a partner session to share scope, decisions, and open questions, or when the user mentions gori or pairing. Drives the gori_* MCP tools, falling back to the `gori` CLI.
---

# gori — pairing bridge

Pair this session with a partner AI session in a separate repo or directory. One shared task carries a timeline (`log`) and a structured spec (`scope` plus questions and answers). The two sides are symmetric peers — the only difference is who started.

## Using gori

Prefer the `gori_*` MCP tools. If they are not available, run the `gori <verb>` CLI — both wrap the same core, so behavior is identical. Never reimplement gori's logic; the tools own it.

## Core flow

- Begin by calling `gori_status`. If it shows 🆕 (the partner made the last change), call `gori_read` to catch up before acting.
- Record meaningful progress, decisions, and blockers with `gori_log`.
- Ask about the partner's side with `gori_ask`; answer the questions waiting on you with `gori_answer`.

## Connecting to a task — pick the right verb

Check `gori_status` and the `gori_link` candidate list FIRST. Only create when nothing is open for this work.

- Starting new work that needs a partner → `gori_create` (pass the keyword and your scope in one call).
- The partner already started the task → `gori_link`.
- Reconnecting to a task this session already belongs to, e.g. after a restart → `gori_attach`.

## Closing

`gori_close` marks the task closed for **both** sides. It is non-destructive and reopenable with `gori_reopen`. Suggest closing once both question queues are empty. If you close while the partner still has open questions, say so explicitly.

## Talking about the other side

Refer to it as the **partner session**.

## Edge cases

For reconnect recovery, ambiguous side, duplicate-create handling, note-to-spec promotion, and natural-language triggers in non-Claude-Code agents, see [reference.md](reference.md).
