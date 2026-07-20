# gori — reference

Deep detail, loaded on demand. The core workflow lives in SKILL.md; this file covers recovery paths and edge cases.

## Reconnecting after a restart

A session's binding lives outside the conversation, so a restart or context compaction loses nothing:

- `gori_attach <task-id>` rebinds this session to a task it already belongs to.
- If both sides share the same directory and the side is ambiguous (`SIDE_AMBIGUOUS`), pass the side explicitly: `gori_attach <task-id> pair-A` (or `pair-B`).

## `CWD_IN_USE` on create

If `gori_create` returns `CWD_IN_USE`, this directory already belongs to an open task, so you almost certainly meant to:

- `gori_link` (join the partner's task), or
- `gori_attach` (reconnect to your own task).

Use `force` only to deliberately start a second task in the same directory.

## note to spec promotion

The `log` is a running log for points in the flow; durable decisions live in the spec. When `gori_log` reports the timeline is getting long (around 30 lines), move durable decisions into `gori_scope`, or raise open questions with `gori_ask`.

## recap — condensing a long log

Promotion moves individual items out of the log; `gori_recap` condenses the log itself. When the timeline has grown long and the back-and-forth is mostly settled, `gori_read` it, write a short summary of what still matters, and call `gori_recap "<summary>"`. The summary becomes the new note; the full prior timeline is appended to `note.archive.md` in the task directory.

gori has no LLM, so it never summarizes on its own — you write the recap. The archive is non-destructive cold storage: the reading view never loads it (so it costs no tokens), and it is never auto-deleted. To recover the full history, read `note.archive.md` in the task's directory (`$GORI_HOME/tasks/<task-id>/note.archive.md`, default `~/.gori`). `gori_recap` is rejected on a closed task and when the note is empty (`NOTHING_TO_RECAP`).

## Blocking and unblocking

`gori_block "<reason>"` flags the active task as blocked on a decision neither side can make, recording the reason (shown in `gori_status` and `gori_list`). It is reversible and non-destructive: the task stays editable, so keep working toward the resolution, and `gori_unblock` returns it to in-progress once the decision is made.

- Block is rejected on a closed task (`ALREADY_CLOSED` — reopen first) and on one already blocked (`ALREADY_BLOCKED`); unblock is rejected when the task is not blocked (`NOT_BLOCKED`).
- `gori_reopen` is for closed tasks only. A blocked task resumes with `gori_unblock`, not reopen (reopen on a blocked task returns `ALREADY_BLOCKED`).

## Natural-language triggers (non-Claude-Code agents)

Outside Claude Code, slash invocation may not exist. These phrasings map to the flow:

- "pair with the backend session on this" → `gori_status`, then `gori_create` or `gori_link`
- "log that we renamed the endpoint" → `gori_log`
- "ask the partner whether ..." → `gori_ask`
- "what did the partner change?" → `gori_read`
- "we're blocked on X, needs a call" → `gori_block`; "the call was made, resume" → `gori_unblock`

## Worked example

    A (api-server):  gori_create "billing-webhook" "add POST /webhooks/billing"
    B (webapp):      gori_link              # shows candidates, then gori_link <task-id>
    B:               gori_read              # see A's scope
    B:               gori_ask "what's the auth header on the webhook?"
    A:               gori_answer "#1" "X-Signature, HMAC-SHA256"
    A:               gori_log "endpoint merged to main"
    both:            gori_close             # once both queues are empty
