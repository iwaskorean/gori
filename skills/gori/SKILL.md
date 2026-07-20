---
name: gori
description: A pairing bridge between two AI sessions working on one task across separate repos, directories, or contexts (e.g. backend + frontend on one change). Engage when this session needs a partner session to share scope, decisions, and open questions, or when the user mentions gori or pairing. Drives the gori_* MCP tools, falling back to the `gori` CLI.
---

# gori — pairing bridge

Pair this session with a partner session in a separate repo or directory. One shared task carries a timeline (`log`) and a structured spec (`scope` plus questions and answers). The two sides are symmetric peers. The only difference is who started.

## Using gori

Prefer the `gori_*` MCP tools. If they are not available, run the `gori <verb>` CLI; both wrap the same core, so behavior is identical. Never reimplement gori's logic; the tools own it.

## Core flow

- Begin by calling `gori_status`. If it shows 🆕 (the partner made the last change), call `gori_read` to catch up before acting.
- Log progress as it happens with `gori_log`.
- Ask about the partner's side with `gori_ask`; answer the questions waiting on you with `gori_answer`.

## Which channel

Three channels, three jobs; don't record the same thing in two:

- **`gori_log`**: a running log of what happened, in order. Cheap, append-only. When `gori_log` reports the log is getting long, `gori_read` it, write a short summary of what still matters, and `gori_recap` to replace the timeline — gori archives the full log to `note.archive.md` (recoverable, but kept out of the read view), so nothing is lost while the live note stays small.
- **`gori_scope`**: durable decisions and your side's boundary. Re-edit a `### ` sub-section in place as they change; don't restate a decision as a fresh log line.
- **`gori_ask` / `gori_answer`**: open questions you need the partner to resolve, tracked by stable `#id`.

## Connecting to a task — pick the right verb

Check `gori_status` and the `gori_link` candidate list FIRST. Only create when nothing is open for this work.

- Starting new work that needs a partner → `gori_create` (pass the keyword and your scope in one call).
- The partner already started the task → `gori_link`.
- Reconnecting to a task this session already belongs to, e.g. after a restart → `gori_attach`.

## Closing

`gori_close` marks the task closed for **both** sides. It is non-destructive and reopenable with `gori_reopen`. Suggest closing once both question queues are empty. If you close while the partner still has open questions, say so explicitly.

## Blocking (escalation)

When the two sides hit an impasse that needs a decision neither can make — a call from outside the pairing, e.g. the user or a product owner — `gori_block` with a short reason. It flags the task blocked and surfaces the reason in `gori_status` and `gori_list`, so the impasse is visible instead of stalling silently or finishing as if done. The task stays editable, so keep working on anything that does not depend on the decision. Once the call is made, `gori_unblock` resumes it.

## Talking about the other side

Refer to it as the **partner session**.

## Edge cases

For reconnect recovery, ambiguous side, duplicate-create handling, note-to-spec promotion, and natural-language triggers in non-Claude-Code agents, see [reference.md](reference.md).
