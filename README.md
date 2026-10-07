# pi-taste

Retrospective taste learning for pi. Extracts durable coding preferences from a
session, decides which candidates are real preferences with a System One
classifier, and stores them per project plus a global layer that accumulates
preferences recurring across projects.

Status: early. The ledger, config, and cache-safe injection are in place. The
extraction/distill/reconcile/prune pipeline lands next; `/taste consolidate`
runs it.

Design notes:

- Taste is injected into the system prompt, but the injected snapshot is frozen
  between compactions. It refreshes only at session start, after a compaction,
  and on an explicit `/taste consolidate`, so the cached prefix stays stable on
  ordinary turns.
- The project layer is keyed by local working directory, the same encoding pi
  uses for `~/.pi/agent/sessions/<encoded-cwd>/`.
- `taste.enabled` defaults to `false`. `/taste consolidate` and `/taste
  remember` still work while disabled; nothing is injected until enabled.

## Storage

- `~/.pi/agent/taste/<encoded-cwd>/ledger.ndjson` — project ledger
- `~/.pi/agent/taste/global/ledger.ndjson` — global ledger

## Commands

- `/taste status`
- `/taste enable` / `/taste disable` (`--user` for the user-level settings file)
- `/taste view`
- `/taste consolidate`
