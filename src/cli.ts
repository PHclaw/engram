import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { parseArgs, type ParsedArgs } from './args'
import { KINDS, Store, hashOf, projectScope, type Kind, type Memory, type UpdateInput } from './store'
import { contextBlock, searchMemories, type Hit, type HitParts } from './search'
import { findDuplicates } from './dedupe'
import { die, fmt, relTime, str, timeStr, truncate } from './ui'
import { serve } from './mcp'

export const VERSION = '0.1.0'

const HELP = `${fmt.bold('engram')} — one memory for all your agents

${fmt.bold('USAGE')}
  engram <command> [options]

${fmt.bold('COMMANDS')}
  add <text>                 Save a memory (deduped by content hash)
  search <query>             BM25 search, ranked by relevance + importance + recency
  context <query>            Print a <memory> block ready to paste into a prompt
  inject [prompt]            Hook helper: context block from argv or stdin, silent when empty
  list                       List recent memories
  get <id>                   Show one memory
  update <id>                Patch an existing memory
  rm <id>                    Delete a memory (asks first; -y to skip)
  stats                      Store summary
  scopes                     List scopes and counts
  doctor                     Validate the store and report problems
  dedupe                     Find near-duplicate memories (--merge to supersede)
  prune                      Delete superseded memories (--days n keeps recent history)
  export                     Dump every memory as JSONL
  import <file>              Load JSONL or a JSON array (- for stdin)
  mcp                        Run the MCP server on stdio
  help | version

${fmt.bold('OPTIONS')}
  --kind <k>                 ${KINDS.join(' | ')} (default: fact)
  --tags a,b,c               Comma-separated tags
  --tag <t>                  Filter reads by a single tag
  --scope <s>                Scope, e.g. project:engram (default: project:<cwd>)
  --all-scopes               Ignore scope filtering
  --include-superseded       Include replaced memories in reads
  --importance <1-5>         Ranking weight (default: 3)
  --limit <n>                Max results (default: 5 search / 20 list)
  --offset <n>               Skip the first n results (paging)
  --explain                  Show the score breakdown per result
  --replaces <id>            Mark an older memory as superseded by this one
  --source <s>               Where the memory came from
  --store <path>             Store file for this call (overrides ENGRAM_STORE)
  --max-chars <n>            Budget for the context block (default: 1500)
  --days <n>                 prune: only history older than n days
  --threshold <0-1>          dedupe: similarity cutoff (default: 0.8)
  --cross-scope              dedupe: compare memories across scopes
  --merge                    dedupe: mark duplicates superseded by the newer one
  --json                     Machine-readable output
  --quiet, -q                Suppress human chatter
  --yes, -y                  Skip confirmation prompts

${fmt.bold('ENV')}
  ENGRAM_STORE               Store file (default: ~/.engram/memory.jsonl)

${fmt.bold('EXAMPLES')}
  engram add "User prefers tabs over spaces" --kind preference --tags style
  engram search "缩进 偏好" --limit 3
  engram context "how do I deploy" --json
  engram inject "$USER_PROMPT"
  engram export > backup.jsonl && engram import backup.jsonl
  engram list --all-scopes --include-superseded`

function tagsOf(v: string | boolean | undefined): string[] {
  return typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : []
}

function kindOf(a: ParsedArgs, dflt: Kind = 'fact'): Kind {
  const raw = str(a.flags.kind, dflt)
  if (!isKind(raw)) die(`unknown kind "${raw}" — use one of: ${KINDS.join(', ')}`)
  return raw
}

function isKind(v: string): v is Kind {
  return (KINDS as readonly string[]).includes(v)
}

function intFlag(a: ParsedArgs, name: string, dflt: number): number {
  const raw = a.flags[name]
  if (typeof raw !== 'string') return dflt
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) die(`--${name} expects a positive integer`)
  return n
}

function ratioFlag(a: ParsedArgs, name: string, dflt: number): number {
  const raw = a.flags[name]
  if (typeof raw !== 'string') return dflt
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 1) die(`--${name} expects a number between 0 and 1`)
  return n
}

function offsetOf(a: ParsedArgs): number {
  const raw = a.flags.offset
  if (typeof raw !== 'string') return 0
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) die('--offset expects a non-negative integer')
  return n
}

/** Scope used for reads: explicit --scope, everything with --all-scopes, else the cwd project. */
function scopeOf(a: ParsedArgs): { scope?: string; allScopes: boolean } {
  const explicit = str(a.flags.scope)
  if (explicit) return { scope: explicit, allScopes: a.flags['all-scopes'] === true }
  if (a.flags['all-scopes']) return { scope: undefined, allScopes: true }
  return { scope: projectScope(), allScopes: false }
}

function json(a: ParsedArgs): boolean {
  return a.flags.json === true
}

/** Prompt piped in from a hook; empty string when attached to a terminal. */
function readStdin(): string {
  if (process.stdin.isTTY) return ''
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** Hook payloads arrive as JSON — pull the prompt out instead of searching the whole envelope. */
function promptFromStdin(raw: string): string {
  const body = raw.trim()
  if (!body.startsWith('{')) return raw
  try {
    const obj = JSON.parse(body) as Record<string, unknown>
    for (const key of ['prompt', 'user_prompt', 'userPrompt', 'text', 'message', 'query']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim().length > 0) return v
    }
  } catch {
    // plain text after all
  }
  return raw
}

function say(a: ParsedArgs, msg: string): void {
  if (!json(a) && a.flags.quiet !== true && a.flags.q !== true) console.log(msg)
}

function memoryLine(m: Memory, score?: number, parts?: HitParts): string {
  const tags = m.tags.length ? ' ' + fmt.dim(m.tags.map(t => `#${t}`).join(' ')) : ''
  const gone = m.supersededBy ? ' ' + fmt.yellow(`→ ${m.supersededBy}`) : ''
  const meta = [
    m.scope,
    `imp ${m.importance}`,
    relTime(m.updatedAt),
    ...(score === undefined ? [] : [`score ${score.toFixed(2)}`]),
  ].join(' · ')
  const explain =
    parts && score !== undefined
      ? `\n${' '.repeat(14)}${fmt.dim(
          `bm25 ${parts.bm25.toFixed(2)} × imp ${parts.importance.toFixed(2)} × rec ${parts.recency.toFixed(2)} × scope ${parts.scope.toFixed(2)}`,
        )}`
      : ''
  return `${fmt.dim(m.id)}  ${fmt.cyan(m.kind.padEnd(10))} ${m.text}${tags}${gone}\n${' '.repeat(14)}${fmt.dim(meta)}${explain}`
}

function printHits(a: ParsedArgs, hits: Hit[]): void {
  if (json(a)) {
    console.log(JSON.stringify({ count: hits.length, hits }, null, 2))
    return
  }
  if (hits.length === 0) {
    say(a, fmt.dim('no matches'))
    return
  }
  const explain = a.flags.explain === true
  for (const h of hits) console.log(memoryLine(h.memory, h.score, explain ? h.parts : undefined) + '\n')
}

function requireId(a: ParsedArgs): string {
  const id = a._[1]
  if (!id) die('missing <id>')
  return id
}

async function confirm(a: ParsedArgs, question: string): Promise<boolean> {
  if (a.flags.yes === true || a.flags.y === true) return true
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} ${fmt.dim('[y/N]')} `)
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

function detail(m: Memory): string {
  const rows = [
    ['id', m.id],
    ['kind', m.kind],
    ['scope', m.scope],
    ['agent', m.agent],
    ['importance', String(m.importance)],
    ['tags', m.tags.length ? m.tags.join(', ') : '—'],
    ['source', m.source ?? '—'],
    ['superseded by', m.supersededBy ?? '—'],
    ['created', timeStr(m.createdAt)],
    ['updated', timeStr(m.updatedAt)],
  ]
  return rows.map(([k, v]) => `${fmt.dim(k.padEnd(13))} ${v}`).join('\n') + `\n${fmt.dim('text'.padEnd(13))} ${m.text}`
}

function parsePatch(a: ParsedArgs): UpdateInput {
  const patch: UpdateInput = {}
  const text = str(a.flags.text) || a._.slice(2).join(' ')
  if (text) patch.text = text
  if (a.flags.kind !== undefined) patch.kind = kindOf(a)
  if (a.flags.tags !== undefined) patch.tags = tagsOf(a.flags.tags)
  if (a.flags.scope !== undefined) patch.scope = str(a.flags.scope)
  if (a.flags.agent !== undefined) patch.agent = str(a.flags.agent)
  if (a.flags.source !== undefined) patch.source = str(a.flags.source)
  if (a.flags.importance !== undefined) patch.importance = intFlag(a, 'importance', 3)
  if (a.flags.replaces !== undefined) patch.replaces = str(a.flags.replaces)
  return patch
}

export async function run(argv: string[]): Promise<number> {
  const a = parseArgs(argv)
  const cmd = a._[0] ?? (a.flags.version || a.flags.v ? 'version' : 'help')

  if (a.flags.help === true || a.flags.h === true) {
    console.log(HELP)
    return 0
  }
  if (cmd === 'mcp') {
    serve(str(a.flags.store) || undefined)
    return 0
  }

  const store = new Store(str(a.flags.store) || undefined)

  switch (cmd) {
    case 'help':
    case '--help':
      console.log(HELP)
      return 0

    case 'version':
      console.log(VERSION)
      return 0

    case 'add': {
      const text = str(a.flags.text) || a._.slice(1).join(' ')
      if (!text.trim()) die('nothing to remember — pass the text to save')
      const { memory, created } = store.add({
        text,
        kind: kindOf(a),
        tags: tagsOf(a.flags.tags),
        scope: str(a.flags.scope) || undefined,
        agent: str(a.flags.agent) || undefined,
        source: str(a.flags.source) || undefined,
        importance: a.flags.importance === undefined ? undefined : intFlag(a, 'importance', 3),
        replaces: str(a.flags.replaces) || undefined,
      })
      if (json(a)) {
        console.log(JSON.stringify({ created, memory }, null, 2))
      } else if (a.flags.quiet !== true && a.flags.q !== true) {
        console.log(`${created ? fmt.green('+ saved') : fmt.yellow('= already known')} ${fmt.dim(memory.id)}`)
        console.log(`  ${memory.text}`)
        if (memory.supersededBy === undefined && created) {
          console.log(fmt.dim(`  ${memory.scope} · ${memory.kind} · imp ${memory.importance}`))
        }
      }
      return 0
    }

    case 'search':
    case 'find': {
      const query = a._.slice(1).join(' ')
      if (!query.trim()) die('missing search query')
      const { scope, allScopes } = scopeOf(a)
      const tag = str(a.flags.tag)
      const hits = searchMemories(store.memories, query, {
        limit: intFlag(a, 'limit', 5),
        offset: offsetOf(a),
        scope,
        allScopes,
        kind: a.flags.kind === undefined ? undefined : kindOf(a),
        includeSuperseded: a.flags['include-superseded'] === true,
      }).filter(h => !tag || h.memory.tags.includes(tag))
      printHits(a, hits)
      return 0
    }

    case 'context':
    case 'recall': {
      const query = a._.slice(1).join(' ')
      if (!query.trim()) die('missing search query')
      const { scope, allScopes } = scopeOf(a)
      const tag = str(a.flags.tag)
      const hits = searchMemories(store.memories, query, {
        limit: intFlag(a, 'limit', 8),
        offset: offsetOf(a),
        scope,
        allScopes,
        kind: a.flags.kind === undefined ? undefined : kindOf(a),
        includeSuperseded: a.flags['include-superseded'] === true,
      }).filter(h => !tag || h.memory.tags.includes(tag))
      const block = contextBlock(hits, intFlag(a, 'max-chars', 1500))
      if (json(a)) {
        console.log(JSON.stringify({ count: hits.length, context: block, hits }, null, 2))
      } else {
        console.log(block)
      }
      return 0
    }

    case 'inject': {
      const fromArgv = a._.slice(1).join(' ')
      const prompt = fromArgv || promptFromStdin(readStdin())
      if (!prompt.trim()) {
        if (json(a)) console.log(JSON.stringify({ count: 0, context: '' }))
        return 0
      }
      const { scope, allScopes } = scopeOf(a)
      const tag = str(a.flags.tag)
      const hits = searchMemories(store.memories, prompt, {
        limit: intFlag(a, 'limit', 6),
        offset: offsetOf(a),
        scope,
        allScopes,
        kind: a.flags.kind === undefined ? undefined : kindOf(a),
        includeSuperseded: false,
      }).filter(h => !tag || h.memory.tags.includes(tag))
      const block = contextBlock(hits, intFlag(a, 'max-chars', 1200))
      if (json(a)) {
        console.log(JSON.stringify({ count: hits.length, context: block }))
      } else if (block) {
        console.log(block)
      }
      return 0
    }

    case 'list':
    case 'ls': {
      const { scope, allScopes } = scopeOf(a)
      const tag = str(a.flags.tag)
      const hits = searchMemories(store.memories, '', {
        limit: intFlag(a, 'limit', 20),
        offset: offsetOf(a),
        scope,
        allScopes,
        kind: a.flags.kind === undefined ? undefined : kindOf(a),
        includeSuperseded: a.flags['include-superseded'] === true,
      }).filter(h => !tag || h.memory.tags.includes(tag))
      printHits(a, hits)
      return 0
    }

    case 'get':
    case 'show': {
      const m = store.get(requireId(a))
      if (!m) die(`no memory with id ${a._[1]}`)
      console.log(json(a) ? JSON.stringify(m, null, 2) : detail(m))
      return 0
    }

    case 'update':
    case 'edit': {
      const id = requireId(a)
      const existing = store.get(id)
      if (!existing) die(`no memory with id ${id}`)
      const patch = parsePatch(a)
      if (Object.keys(patch).length === 0) die('nothing to update — pass --text/--tags/--kind/--scope/--importance')
      const m = store.update(id, patch)
      if (!m) die(`no memory with id ${id}`)
      if (json(a)) {
        console.log(JSON.stringify(m, null, 2))
      } else {
        say(a, `${fmt.green('✓ updated')} ${fmt.dim(m.id)}`)
        console.log(m.text)
      }
      return 0
    }

    case 'rm':
    case 'delete':
    case 'forget': {
      const id = requireId(a)
      const m = store.get(id)
      if (!m) die(`no memory with id ${id}`)
      if (!(await confirm(a, `Delete "${m.text}"?`))) {
        say(a, fmt.dim('cancelled'))
        return 1
      }
      store.remove(id)
      say(a, `${fmt.green('✓ deleted')} ${fmt.dim(id)}`)
      return 0
    }

    case 'stats': {
      const s = store.stats()
      if (json(a)) {
        console.log(JSON.stringify({ ...s, file: store.file, scopes: store.scopes() }, null, 2))
        return 0
      }
      console.log(`${fmt.bold(String(s.total))} memories · ${fmt.green(String(s.active))} active · ${fmt.yellow(String(s.superseded))} superseded`)
      const kinds = Object.entries(s.byKind).sort((x, y) => y[1] - x[1])
      if (kinds.length) console.log(kinds.map(([k, n]) => `${k} ${fmt.dim(String(n))}`).join(fmt.dim(' · ')))
      console.log(fmt.dim(store.file))
      return 0
    }

    case 'scopes': {
      const rows = store.scopes()
      if (json(a)) {
        console.log(JSON.stringify(rows, null, 2))
        return 0
      }
      if (rows.length === 0) {
        console.log(fmt.dim('no memories yet'))
        return 0
      }
      for (const r of rows) console.log(`${fmt.cyan(r.scope.padEnd(24))} ${r.count}`)
      return 0
    }

    case 'doctor': {
      const issues: string[] = []
      const seenIds = new Set<string>()
      const seenText = new Map<string, string>()
      const known = new Set(store.memories.map(m => m.id))
      for (const m of store.memories) {
        const label = m.id || '(missing id)'
        if (!m.id) issues.push('a memory has no id')
        else if (seenIds.has(m.id)) issues.push(`${label}: duplicate id`)
        seenIds.add(m.id)
        const text = typeof m.text === 'string' ? m.text.trim() : ''
        if (!text) {
          issues.push(`${label}: empty text`)
        } else {
          const dup = seenText.get(hashOf(text))
          if (dup) issues.push(`${label}: duplicate text of ${dup}`)
          else seenText.set(hashOf(text), label)
        }
        if (!(KINDS as readonly string[]).includes(m.kind)) issues.push(`${label}: invalid kind "${String(m.kind)}"`)
        if (!Array.isArray(m.tags)) issues.push(`${label}: tags is not an array`)
        if (typeof m.importance !== 'number' || !Number.isFinite(m.importance) || m.importance < 1 || m.importance > 5) {
          issues.push(`${label}: importance out of range (${String(m.importance)})`)
        }
        if (m.supersededBy) {
          if (m.supersededBy === m.id) issues.push(`${label}: superseded by itself`)
          else if (!known.has(m.supersededBy)) issues.push(`${label}: supersededBy points at missing ${m.supersededBy}`)
        }
      }
      const s = store.stats()
      if (json(a)) {
        console.log(JSON.stringify({ ok: issues.length === 0, issues, file: store.file, scopes: store.scopes(), ...s }, null, 2))
        return issues.length === 0 ? 0 : 1
      }
      console.log(
        issues.length === 0
          ? `${fmt.green('✓ healthy')} ${fmt.dim(store.file)}`
          : `${fmt.red(`✗ ${issues.length} problem(s)`)} ${fmt.dim(store.file)}`,
      )
      console.log(fmt.dim(`${s.total} memories · ${s.active} active · ${s.superseded} superseded · ${store.scopes().length} scopes`))
      for (const i of issues) console.log(`  ${fmt.red('•')} ${i}`)
      return issues.length === 0 ? 0 : 1
    }

    case 'dedupe':
    case 'dupes': {
      const merge = a.flags.merge === true
      const pairs = findDuplicates(store.memories, {
        threshold: ratioFlag(a, 'threshold', 0.8),
        limit: intFlag(a, 'limit', 50),
        crossScope: a.flags['cross-scope'] === true,
      })
      const showPairs = (): void => {
        for (const p of pairs) {
          console.log(`${fmt.yellow(p.similarity.toFixed(2))}  ${fmt.dim(p.a.id)}  ${truncate(p.a.text, 72)}`)
          console.log(`      ${fmt.dim(p.b.id)}  ${truncate(p.b.text, 72)}`)
        }
      }
      if (pairs.length === 0) {
        if (json(a)) console.log(JSON.stringify(merge ? { count: 0, merged: 0 } : { count: 0, pairs: [] }))
        else say(a, fmt.dim('no near-duplicates found'))
        return 0
      }
      if (!merge) {
        if (json(a)) console.log(JSON.stringify({ count: pairs.length, pairs }, null, 2))
        else {
          showPairs()
          say(a, fmt.dim(`${pairs.length} pair(s) — rerun with --merge to supersede the older copy`))
        }
        return 0
      }
      if (!json(a)) showPairs()
      if (!(await confirm(a, `Merge ${pairs.length} near-duplicate pair(s)?`))) {
        if (json(a)) console.log(JSON.stringify({ count: pairs.length, merged: 0, cancelled: true }))
        else say(a, fmt.dim('cancelled'))
        return 1
      }
      const done = new Set<string>()
      let merged = 0
      for (const p of pairs) {
        if (done.has(p.a.id) || done.has(p.b.id)) continue
        const [keep, drop] = p.a.updatedAt >= p.b.updatedAt ? [p.a, p.b] : [p.b, p.a]
        const current = store.get(keep.id)
        if (!current) continue
        store.update(keep.id, {
          tags: [...new Set([...current.tags, ...drop.tags])],
          importance: Math.max(current.importance, drop.importance),
        })
        store.markSuperseded([drop.id], keep.id)
        done.add(drop.id)
        merged++
      }
      if (json(a)) console.log(JSON.stringify({ count: pairs.length, merged }))
      else say(a, `${fmt.green('✓ merged')} ${merged} pair(s) — older copies are superseded, not deleted`)
      return 0
    }

    case 'prune': {
      const days = a.flags.days === undefined ? undefined : intFlag(a, 'days', 30)
      const cutoff = days === undefined ? Number.POSITIVE_INFINITY : Date.now() - days * 86_400_000
      const candidates = store.memories.filter(m => m.supersededBy && m.updatedAt < cutoff)
      if (candidates.length === 0) {
        if (json(a)) console.log(JSON.stringify({ removed: 0, ids: [] }))
        else say(a, fmt.dim(days === undefined ? 'nothing to prune' : `nothing superseded older than ${days}d`))
        return 0
      }
      if (!json(a)) {
        for (const m of candidates) console.log(`${fmt.dim(m.id)}  ${truncate(m.text, 72)}`)
      }
      if (!(await confirm(a, `Delete ${candidates.length} superseded memories?`))) {
        if (json(a)) console.log(JSON.stringify({ removed: 0, ids: [], cancelled: true }))
        else say(a, fmt.dim('cancelled'))
        return 1
      }
      const ids = candidates.map(m => m.id)
      const removed = store.removeMany(ids)
      if (json(a)) console.log(JSON.stringify({ removed, ids }))
      else say(a, `${fmt.green('✓ pruned')} ${removed}`)
      return 0
    }

    case 'export': {
      for (const m of store.memories) console.log(JSON.stringify(m))
      return 0
    }

    case 'import': {
      const file = a._[1]
      if (!file) die('missing <file> (use - for stdin)')
      let raw: string
      try {
        raw = file === '-' ? readStdin() : fs.readFileSync(path.resolve(file), 'utf8')
      } catch (err) {
        die(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
      const records: unknown[] = []
      const body = raw.trim()
      if (body.startsWith('[')) {
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          die(`${file} is not valid JSON`)
        }
        if (!Array.isArray(parsed)) die(`${file} is not a JSON array`)
        records.push(...parsed)
      } else {
        for (const line of body.split('\n')) {
          const t = line.trim()
          if (!t) continue
          try {
            records.push(JSON.parse(t))
          } catch {
            // skip corrupt line, counted by importMany as skipped only if parsed
          }
        }
      }
      const res = store.importMany(records)
      if (json(a)) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        say(a, `${fmt.green('✓ imported')} ${res.added} added · ${res.merged} already known · ${res.skipped} skipped`)
      }
      return 0
    }

    default:
      die(`unknown command "${cmd}" — run \`engram help\``)
  }
}
