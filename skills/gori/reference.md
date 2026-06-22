# gori — reference

Deep detail, loaded on demand. The core workflow lives in SKILL.md; this file covers recovery paths and edge cases.

## Reconnecting after a restart

A session's binding lives outside the conversation, so a restart or context compaction loses nothing:

- `gori_attach <task-id>` rebinds this session to a task it already belongs to.
- If both sides share the same directory and the side is ambiguous (`SIDE_AMBIGUOUS`), pass the side explicitly: `gori_attach <task-id> pair-A` (or `pair-B`).

## `CWD_IN_USE` on create

If `gori_create` returns `CWD_IN_USE`, this directory already belongs to an open task — you almost certainly meant to:

- `gori_link` (join the partner's task), or
- `gori_attach` (reconnect to your own task).

Use `force` only to deliberately start a second task in the same directory.

## note to spec promotion

The `log` is a running log for points in the flow; durable decisions live in the spec. When `gori_log` reports the timeline is getting long (around 30 lines), move durable decisions into `gori_scope`, or raise open questions with `gori_ask`.

## Natural-language triggers (non-Claude-Code agents)

Outside Claude Code, slash invocation may not exist. These phrasings map to the flow:

- "pair with the backend session on this" → `gori_status`, then `gori_create` or `gori_link`
- "log that we renamed the endpoint" → `gori_log`
- "ask the partner whether ..." → `gori_ask`
- "what did the partner change?" → `gori_read`

## Worked example

    A (api-server):  gori_create "billing-webhook" "add POST /webhooks/billing"
    B (webapp):      gori_link              # shows candidates, then gori_link <task-id>
    B:               gori_read              # see A's scope
    B:               gori_ask "what's the auth header on the webhook?"
    A:               gori_answer "#1" "X-Signature, HMAC-SHA256"
    A:               gori_log "endpoint merged to main"
    both:            gori_close             # once both queues are empty
