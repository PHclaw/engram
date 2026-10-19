<div align="center">

<h1>engram</h1>

<p><strong>One memory for all your agents.</strong><br>
Local, portable, MCP-native.</p>

<p>
  <a href="https://www.npmjs.com/package/engram"><img src="https://img.shields.io/npm/v/engram.svg" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="node"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/dependencies-0-success.svg" alt="dependencies"></a>
</p>

<p>English · <a href="README.zh-CN.md">简体中文</a></p>

<img src="assets/banner.svg" width="100%" alt="engram — one memory for all your agents. Local, portable, MCP-native.">

</div>

---

Your coding agents forget everything the moment a session ends. You re-explain the package manager, the deploy command, the naming convention, the reason you rejected that library — every single time.

`engram` is a **long-term memory store** that lives in one plain JSONL file on your machine. Any agent that speaks [MCP](https://modelcontextprotocol.io) can read and write it. No server, no database, no embeddings, no API keys, no telemetry.

<p align="center">
  <img src="assets/demo.gif" width="820" alt="Terminal demo: engram add saves a release note, then engram context returns it inside a memory block">
</p>

```bash
$ engram add "Releases run pnpm build, then rsync to prod-01" --kind decision --tags deploy
+ saved mvevxbqm9dce

$ engram context "how do I reach prod-01"
<memory>
- [decision] Releases run pnpm build, then rsync to prod-01
</memory>
```

**Contents:** [Why](#why) · [Features](#features) · [Install](#install) · [Quick start](#quick-start) · [Connect your agent](#connect-your-agent) · [CLI](#cli) · [Ranking](#how-ranking-works) · [Data model](#data-model) · [MCP](#mcp-surface) · [Recipes](#recipes) · [FAQ](#faq)

## Why

- **Agents are stateless.** Every new session starts from zero, so you spend the first ten turns re-establishing context you already gave.
- **Cloud memory is a lock-in.** Your preferences and project decisions are not a subscription product.
- **Greppable beats magical.** You can `cat`, `git diff`, back up and hand-edit the whole store. Nothing is hidden in a vector index.

### How it compares

| | engram | Cloud memory APIs | Vector databases |
| --- | --- | --- | --- |
| Storage | one JSONL file you own | hosted service | database + embedding model |
| Dependencies | none (Node built-ins) | SDK, account, network | server, model, index |
| Retrieval | BM25, deterministic | opaque | semantic, approximate |
| Works offline | yes | no | usually not |
| Hand-editable | yes | no | no |
| Best at | local agent context | managed cross-device memory | large semantic corpora |

## Features

- **One file, zero dependencies** — `~/.engram/memory.jsonl`, plain JSONL, human-readable and diff-friendly.
- **BM25 retrieval with CJK support** — Chinese/Japanese/Korean text is indexed as character unigrams **and** bigrams, so `缩进 偏好` matches `偏好 tab 缩进` without a segmenter.
- **Explainable ranking** — relevance × importance × recency × scope match. `--explain` prints every multiplier.
- **Memory lifecycle** — update in place, `--replaces` to supersede a stale fact (history stays queryable), `prune` to clean up.
- **Safe with many agents** — advisory lock + read-modify-write + atomic rename, so parallel writers never lose memories.
- **Built for agents** — 8 MCP tools, 2 resource templates, and an `inject` command for prompt hooks.
- **Scriptable** — `--json` everywhere, stable exit codes, stdin/stdout friendly.

## Install

```bash
npm install -g engram     # provides the `engram` binary
# or run without installing
npx -y engram --help
```

Requires **Node.js ≥ 18**.

From source:

```bash
git clone https://github.com/PHclaw/engram.git
cd engram
npm install
npm run build
node dist/index.js help
```

## Quick start

```bash
# Save what matters
engram add "This repo uses pnpm, never npm" --kind decision --tags tooling
engram add "Indent with 2 spaces, never tabs" --kind preference --tags style --importance 4
engram add "缩进用 2 个空格，不要 tab" --kind preference --tags style,zh --importance 4

# Find it again
engram search "pnpm"
engram search "缩进" --limit 3 --explain

# Get a block you can paste into a prompt
engram context "how should I indent" --max-chars 800

# Review and maintain
engram list --all-scopes
engram stats
engram doctor
```

## Connect your agent

`engram mcp` speaks MCP over stdio (newline-delimited JSON-RPC). Point any client at it.

**Claude Code**

```bash
claude mcp add engram -- npx -y engram mcp
```

**Cursor** — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "engram": { "command": "npx", "args": ["-y", "engram", "mcp"] }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "engram": { "command": "npx", "args": ["-y", "engram", "mcp"] }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`

```toml
[mcp_servers.engram]
command = "npx"
args = ["-y", "engram", "mcp"]
```

**From a local checkout** (no npm install needed):

```json
{
  "mcpServers": {
    "engram": { "command": "node", "args": ["/absolute/path/to/engram/dist/index.js", "mcp"] }
  }
}
```

The server sends `instructions` on `initialize`, telling the model to search before answering questions about prior context and to save durable facts as they come up.

### Prompt hook (no MCP client support needed)

`engram inject` reads a prompt from argv or stdin, prints a `<memory>` block, and stays **completely silent** when nothing matches — safe to wire into a hook that appends to the prompt.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "engram inject" }
        ]
      }
    ]
  }
}
```

It also unwraps JSON hook payloads, pulling the first of `prompt`, `user_prompt`, `userPrompt`, `text`, `message`, `query`.

## CLI

| Command | Description |
| --- | --- |
| `add <text>` | Save a memory. Identical text is merged (tags union, max importance). |
| `search <query>` | BM25 search, ranked by relevance + importance + recency + scope. |
| `context <query>` | Print a `<memory>` block ready to inject into a prompt. |
| `inject [prompt]` | Hook helper: reads argv or stdin, silent when empty. |
| `list` | List active memories, newest first. |
| `get <id>` | Show one memory with timestamps and supersede links. |
| `update <id>` | Patch text, kind, tags, scope, importance or `--replaces`. |
| `rm <id>` | Delete (asks first; `-y` skips). |
| `stats` | Totals, active vs superseded, counts per kind. |
| `scopes` | Every scope with a memory count. |
| `doctor` | Validate the store: duplicate ids/text, bad kinds, dangling supersede links. |
| `dedupe` | Find near-duplicates; `--merge` supersedes the older copy. |
| `prune` | Delete superseded memories; `--days n` keeps recent history. |
| `export` | Dump every memory as JSONL. |
| `import <file>` | Load JSONL or a JSON array (`-` for stdin); ids and timestamps survive. |
| `mcp` | Run the MCP server on stdio. |
| `help`, `version` | Usage / version. |

### Flags

| Flag | Description |
| --- | --- |
| `--kind <k>` | `fact` · `preference` · `decision` · `task` · `snippet` (default `fact`). |
| `--tags a,b,c` | Comma-separated tags. |
| `--tag <t>` | Filter reads by one tag. |
| `--scope <s>` | Scope such as `project:engram`, `user:alice`, `global`. |
| `--all-scopes` | Ignore scope filtering on reads. |
| `--include-superseded` | Include replaced memories in reads. |
| `--importance <1-5>` | Ranking weight (default `3`). |
| `--limit <n>` / `--offset <n>` | Page through results. |
| `--replaces <id>` | Mark an older memory as superseded by the new one. |
| `--source <s>` | Where the memory came from (file, URL, conversation). |
| `--store <path>` | Store file for this call (overrides `ENGRAM_STORE`). |
| `--max-chars <n>` | Budget for `context` / `inject` output. |
| `--days <n>` | `prune`: only history older than n days. |
| `--threshold <0-1>`, `--cross-scope`, `--merge` | `dedupe` tuning. |
| `--explain` | Print the score breakdown per search hit. |
| `--json` | Machine-readable output. |
| `--quiet`, `-q` | Suppress human chatter. |
| `--yes`, `-y` | Skip confirmation prompts. |

### Environment

| Variable | Meaning |
| --- | --- |
| `ENGRAM_STORE` | Store path (default `~/.engram/memory.jsonl`). |
| `NO_COLOR` | Disable ANSI colors. |

## How ranking works

Two stages, both deterministic.

**1. BM25** over memory text + tags (`k1 = 1.2`, `b = 0.75`), pooled by the current scope/kind filters:

```
idf(t) = ln(1 + (N − n(t) + 0.5) / (n(t) + 0.5))
```

CJK runs are tokenized as **unigrams + bigrams**; latin text as lowercased words. Query tokens are deduplicated. That is enough for `部署` to hit `部署流程` and `生产环境` to hit `部署到生产`, with no segmenter and no model.

**2. Multipliers**:

```
score = bm25
      × (1 + 0.12 · (importance − 3))     # 0.76 … 1.24
      × (1 + 0.35 · e^(−ageDays / 45))    # 1.00 … 1.35
      × scopeBoost                        # 1.08 when the memory lives in the queried scope
```

`--explain` prints all four factors, so a surprising result is inspectable instead of mysterious.

## Data model

A memory is one JSON object per line:

```json
{"id":"mvevxbqm9dce","text":"This repo uses pnpm, never npm","kind":"decision","tags":["tooling"],"scope":"project:engram","agent":"cli","importance":4,"createdAt":1760000000000,"updatedAt":1760000000000}
```

| Field | Notes |
| --- | --- |
| `id` | `Date.now()` in base36 + 4 random chars. |
| `text` | The memory, as a standalone statement. |
| `kind` | One of `fact`, `preference`, `decision`, `task`, `snippet`. |
| `tags` | Free-form, indexed by BM25. |
| `scope` | `project:<dirname>` by default; `global` memories are visible from every scope. |
| `importance` | 1–5, clamped. |
| `supersededBy` | Present when a newer memory replaced this one. |
| `createdAt` / `updatedAt` | Epoch milliseconds. |

**Lifecycle:** facts change, so don't delete history — supersede it.

```bash
engram add "Deploys use rsync to prod-01" --replaces mvevxbqm9dce  # old stays queryable with --include-superseded
engram prune --days 30                                             # drop history you no longer need
```

Writes are serialized through `<store>.lock` (stale locks reaped after 10s) and committed with a unique temp file + atomic rename, retried on Windows `EPERM`. Several agents can write to the same store concurrently without losing updates.

## MCP surface

**Tools**

| Tool | Purpose |
| --- | --- |
| `memory_add` | Save a fact, preference, decision, task or snippet. |
| `memory_search` | Ranked search; returns ids, text, tags and scores. |
| `memory_context` | Top matches wrapped in a `<memory>` block. |
| `memory_list` | Recent memories, newest first. |
| `memory_get` | Full JSON for one id. |
| `memory_update` | Patch fields on an existing memory. |
| `memory_delete` | Permanently remove one memory. |
| `memory_stats` | Totals, per-kind counts, scopes, store path. |

**Resources**

| URI | Contents |
| --- | --- |
| `engram://stats` | Store summary. |
| `engram://scope/{scope}` | Every memory in a scope. |
| `engram://memory/{id}` | One memory as JSON. |

Protocol version `2024-11-05`; newline-delimited JSON-RPC on stdin/stdout, stdout reserved for the protocol.

## Recipes

```bash
# Back up, move to another machine, or seed a second agent
engram export > backup.jsonl
ENGRAM_STORE=~/.engram/work.jsonl engram import backup.jsonl

# Share a decision with every project
engram add "Always run tests before committing" --scope global --kind preference

# Audit before a release
engram doctor
engram dedupe --threshold 0.75
engram stats --json | jq '.byKind'

# Feed a long-running agent
engram context "current task: refactor auth" --limit 10 --max-chars 2000
```

## Design principles

- **Zero dependencies.** Only Node built-ins. No install-time supply chain.
- **Local first.** No network calls, no accounts, no telemetry.
- **Explainable retrieval.** BM25 + arithmetic you can read; no embedding drift.
- **Boring storage.** JSONL that survives `cat`, `grep`, `git` and `rsync`.
- **Non-goals:** being a vector database, syncing between machines for you, or storing secrets. Keep credentials out of memories.

## FAQ

**Why not SQLite or embeddings?**
Because the whole store should fit in your head: one file, no binary format, no model download, no re-index. BM25 plus CJK bigrams covers the "find that thing I told you" case, and a 5k-memory store is still fast.

**Where are memories stored?**
`~/.engram/memory.jsonl` unless `ENGRAM_STORE` or `--store` says otherwise. Project memories default to `project:<cwd basename>`; `global` memories are always visible.

**Will two agents clobber each other's writes?**
No. Writers take an advisory lock, reload, mutate, then commit via atomic rename. Readers never see a half-written file.

**Windows?**
Tested on Windows 11 with Node 20+. Rename retries cover `EPERM`/`EBUSY` from AV scanners and indexers. Use `NO_COLOR=1` for clean logs.

**Can I hand-edit the file?**
Yes — it's JSONL. Run `engram doctor` afterwards; it reports duplicate ids, invalid kinds and dangling supersede links.

## Development

```bash
npm install
npm run build     # tsc → dist/
npm test          # build + 39 end-to-end checks (CLI + MCP + concurrency)
npm run clean
```

```
src/store.ts    JSONL store, scopes, dedupe-by-hash, locking, atomic writes
src/search.ts   BM25, CJK tokenizer, ranking multipliers, context block
src/dedupe.ts   Jaccard near-duplicate detection
src/cli.ts      subcommands and terminal output
src/mcp.ts      MCP stdio server (tools + resources)
src/args.ts     zero-dependency argv parser
src/ui.ts       colors, padding, relative time
scripts/smoke.js  end-to-end test runner
assets/         banner.svg, demo.svg (animated source) and demo.gif
```

Contributions are welcome: open an issue with the use case first, keep the zero-dependency rule, and add a smoke check for anything user-visible.

## License

[MIT](LICENSE) © engram contributors

<div align="center"><sub>Named after the <em>engram</em> — the physical trace a memory leaves behind.</sub></div>
