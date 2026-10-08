# pi-taste

Per-project and global taste learning for pi.

pi-taste watches a coding session retrospectively, extracts durable preferences
from what you actually said and corrected, distills them into one-line entries,
and injects the result into the system prompt so the agent follows your taste
without being told twice.

Taste exists at two layers:

- **Project** entries learned from one working directory.
- **Global** entries promoted from a preference seen across multiple projects.

## How it works

A run moves through five stages. The first four run on `/taste consolidate`; the
last two run on `/taste prune`.

1. **extract**: an LLM agent reads the branch after the last coverage watermark
   in chunks and records `signals`, each a single-line preference in your words
   with the source entry ids that support it. A chunk with no durable preference
   records nothing. Coverage advances per chunk, so a rerun never re-reads the
   same span.
2. **distill**: decides which signals are real, durable preferences. With a
   classifier configured it asks five typed questions per signal
   (`is_preference`, `category`, `explicit`, `confidence`, `general`) and uses
   the answers; without one it falls back to a kind-based heuristic.
3. **reconcile**: merges each candidate into the project ledger. Because entry
   ids are content hashes, the same preference recurring later resolves to the
   same entry, its confidence rises, and its provenance grows instead of
   duplicating. A preference seen in enough distinct projects, or judged
   `general` by the classifier, is promoted to the global ledger.
4. **prune**: retracts entries that no longer earn their place. Inferred entries
   below a confidence floor are dropped. With a classifier configured, pairs of
   same-category entries are checked for contradictions and the loser is
   retracted.
5. **reflect** (only on `/taste prune`): an LLM consolidation pass over the
   active project pool. Related entries are rewritten into one statement that
   preserves every fact from the group. The consolidated entry replaces its
   sources, which are tombstoned and aliased to it, so a later observation that
   hashes to an old wording reaffirms the merged entry instead of recreating it.

### Injection

The rendered `<taste>` section is a frozen snapshot held in memory. It is built
only at session start, immediately after a compaction, and when you enable
taste. Between those points it is byte-identical, so the system prompt is
unchanged on ordinary turns and the provider's cached prefix survives. A
compaction already invalidates the cache, which is why that is the moment the
snapshot refreshes.

Writes from `/taste remember`, `/taste consolidate`, `/taste prune`, and
`/taste promote` therefore do **not** appear in the prompt until the next
compaction.

If no entry clears the confidence floor, nothing is injected at all.

## Install

pi-taste is a pi extension. It declares `./dist/index.ts` under `pi.extensions`
in `package.json`.

- `dist/index.ts` is committed. pi loads it directly, so there is no build step
  to use the extension.
- After changing anything in `src/`, run `npm run build`. Committing source
  without rebuilding `dist/` leaves pi running stale code.
- Peer dependencies are provided by pi. For development: `npm install`, then
  `npm run typecheck` and `npm test`.

Point pi at the extension directory (for example through your pi settings), then
start a session and run `/taste status`.

## Commands

All behavior lives behind `/taste`.

| Command | Description |
| --- | --- |
| `/taste status` | Enabled state, project and global entry counts, injectable count, prune floor, classifier mode. |
| `/taste enable [--project]` | Turn taste on and refresh the snapshot. Writes the user settings file by default, or the project file with `--project`. |
| `/taste disable [--project]` | Turn taste off. Nothing is injected while disabled. |
| `/taste view` | List merged project and global entries, highest confidence first. |
| `/taste consolidate` | Run extract, distill, reconcile, and prune over this session's branch. Repeated runs continue where coverage left off. |
| `/taste prune` | Run reflect and then prune over the project pool. This is the dedup pass: it merges related entries and retracts contradictions. |
| `/taste remember <text>` | Record a preference explicitly, at full confidence with no model call. Merges into an existing entry and still promotes by recurrence. |
| `/taste forget <text\|id:...>` | Retract one entry. Matches text, or an id (full or prefix) when prefixed with `id:`. |
| `/taste promote <text\|id:...>` | Force an entry into the global layer. Same selector rules as forget. |
| `/taste export` | Write `./taste.md` in the current directory with the merged project and global view. |

`/taste consolidate` and `/taste remember` still write the ledger while taste is
disabled, since both are explicit user actions. Nothing is injected until it is
enabled.

## Storage

Everything lives under `~/.pi/agent/taste/`:

- `<encoded-cwd>/ledger.ndjson` — the project ledger, append-only.
- `global/ledger.ndjson` — the global ledger.
- `distill-scores/<session>.ndjson` — classifier calibration rows: entry ids,
  decisions, and numbers only, never conversation text.

The project key is your working directory encoded the same way pi encodes
session directories, so a project's taste sits beside its sessions and stays
stable across runs. Move the checkout and it is a new project.

The ledger is the source of truth. No markdown is stored: `/taste export`
renders `./taste.md` in the current directory on demand and overwrites it on the
next export. Four record types make up a ledger: `signal.recorded`,
`entry.upserted`, `entry.retracted`, and `entry.merged`. Malformed lines are
skipped on read, so one bad write never takes the whole file down.

## Configuration

Settings are read from the `taste` key in `~/.pi/agent/settings.json`, then
`./.pi/settings.json` (project wins), then the `PI_TASTE_PASSIVE` environment
variable. The `classifier` block merges field-wise, so a project can override
one field without restating the rest.

```json
{
  "taste": {
    "enabled": true,
    "classifier": { "mode": "shadow", "provider": "local-jev" },
    "injectionConfidenceFloor": 0.5,
    "maxInjectedTokens": 1200,
    "promoteAtProjectCount": 2,
    "pruneConfidenceFloor": 0.3
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. When false, nothing is injected. |
| `classifier.mode` | `shadow` | `off` (never classify), `shadow` (score but keep the heuristic), `primary` (classifier decides). |
| `classifier.provider` | `local-jev` | Classifier provider registered by another extension. If none is registered, distilling falls back to the heuristic. |
| `classifier.model` | provider default | Classifier model id within the provider. |
| `classifier.preferenceThreshold` | `0.5` | Minimum `is_preference` probability for a signal to become an entry. |
| `classifier.maxQuestionsPerRequest` | `250` | Questions per classifier request; batches fan out against one shared state. |
| `classifier.requestTimeoutMs` | `60000` | Classifier request timeout. |
| `injectionConfidenceFloor` | `0.5` | Entries below this confidence are not injected. |
| `maxInjectedTokens` | `1200` | Approximate token budget for the injected section. |
| `promoteAtProjectCount` | `2` | Distinct projects before a preference is promoted to global. |
| `pruneConfidenceFloor` | `0.3` | Inferred entries below this are pruned. Explicit entries are exempt. |
| `extractChunkMaxTokens` | derived | Token cap for one extraction chunk; unset uses roughly a fifth of the model window. |
| `consolidateMaxChunks` | `8` | Chunks one consolidate run may process. Hitting the cap reports that more remain. |
| `reflectMaxEntries` | `60` | Most recently updated entries one reflection call may consider. |
| `agentMaxTurns` | `12` | Turn cap for a worker agent. |
| `agentMaxTokens` | `16000` | Output token cap for a worker agent. |
| `model`, `fallbackModel` | unset | Explicit worker model, and a fallback retried when the primary is unusable. |
| `modelMap` | `[]` | Glob routing per stage: `{ "match": "<provider>/<id>", "stages": [...], "model": "..." }` with `$provider`, `$id`, `$model`, `$thinking` substitution. |
| `debugLog` | `false` | Verbose stage logging. |
| `passive` | `false` | Disable all work without touching settings. Also set by `PI_TASTE_PASSIVE`. |

Stages that can be routed through `modelMap` are `extract`, `distill`,
`reflect`, `reconcile`, and `prune`.

## Design notes

- **Identity is content.** An entry id is a hash of its normalized statement, so
  recurrence is structural rather than tracked. Reflection rewrites break that
  assumption on purpose, which is why merges record aliases: old ids redirect to
  the consolidated entry.
- **Confidence is evidence.** Re-observing a preference combines probabilistically
  (`1 - (1 - old)(1 - new)`), rising with recurrence and saturating. A merge takes
  the maximum of its sources instead, because re-wording the same evidence is not
  new evidence.
- **Explicit is protected.** Entries you stated or recorded with `/taste remember`
  are never pruned on confidence. Only inferred entries are.
- **Contradiction and duplication are separate jobs.** The classifier handles
  contradictions with typed answers; the reflector handles merging with
  generation. Keeping them apart keeps each prompt focused.
- **Nothing is deleted.** Retraction and merging are tombstones in an
  append-only ledger, so history stays auditable and a re-stated preference
  revives its entry.

## Prior work

pi-taste's tiered design, and some of its worker plumbing, follows
[pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)
by elpapi42, which applies the same ledger-and-reflection approach to session
memory. pi-taste is a separate extension focused on preferences rather than
memory.

## License

MIT.
