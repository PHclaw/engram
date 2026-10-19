import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const LOCK_WAIT_MS = 3000
const LOCK_STALE_MS = 10_000

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Windows refuses to rename over a file another process has open (readers, AV,
 * indexers), so retry with a short backoff instead of failing the write.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 20) {
        try {
          fs.unlinkSync(from)
        } catch {
          // best effort
        }
        throw err
      }
      sleep(10 + attempt * 10)
    }
  }
}

export const KINDS = ['fact', 'preference', 'decision', 'task', 'snippet'] as const
export type Kind = (typeof KINDS)[number]

export interface Memory {
  id: string
  text: string
  kind: Kind
  tags: string[]
  scope: string
  agent: string
  source?: string
  importance: number
  supersededBy?: string
  createdAt: number
  updatedAt: number
}

export interface AddInput {
  text: string
  kind?: Kind
  tags?: string[]
  scope?: string
  agent?: string
  source?: string
  importance?: number
  replaces?: string
}

export type UpdateInput = Partial<Pick<Memory, 'text' | 'kind' | 'tags' | 'scope' | 'agent' | 'source' | 'importance'>> & {
  replaces?: string
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** Normalize text for dedupe: lowercase, strip punctuation (incl. CJK), collapse spaces. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u3000-\u303f\uff00-\uffef]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function hashOf(text: string): string {
  return crypto.createHash('sha1').update(normalize(text)).digest('hex').slice(0, 16)
}

/** Default scope for a working directory: project:<name>. */
export function projectScope(cwd: string = process.cwd()): string {
  const base = path.basename(cwd)
  return `project:${base || 'root'}`
}

/** Store location: $ENGRAM_STORE or ~/.engram/memory.jsonl */
export function defaultStore(): string {
  const env = process.env.ENGRAM_STORE
  if (env && env.length > 0) return path.resolve(env)
  return path.join(os.homedir(), '.engram', 'memory.jsonl')
}

/** A memory is visible when it is in the given scope or in "global". */
export function inScope(m: Memory, scope?: string, allScopes = false): boolean {
  if (allScopes || !scope || scope === '*') return true
  if (scope === 'global') return m.scope === 'global'
  return m.scope === scope || m.scope === 'global'
}

export class Store {
  readonly file: string
  memories: Memory[] = []
  private byHash = new Map<string, string>()

  constructor(file: string = defaultStore()) {
    this.file = file
    this.load()
  }

  load(): void {
    this.memories = []
    this.byHash.clear()
    if (!fs.existsSync(this.file)) return
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const m = JSON.parse(t) as Memory
        if (!m.id || !m.text) continue
        this.memories.push(m)
        this.byHash.set(hashOf(m.text), m.id)
      } catch {
        // skip corrupt line
      }
    }
  }

  /** Atomic write: unique temp file + rename (rename is retried on Windows EPERM). */
  save(): void {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    const body = this.memories.map(m => JSON.stringify(m)).join('\n')
    fs.writeFileSync(tmp, this.memories.length ? body + '\n' : '', 'utf8')
    renameWithRetry(tmp, this.file)
  }

  /**
   * Advisory lock so several agents can share one store. The lock file is created
   * exclusively; stale locks (crashed process) are reaped after LOCK_STALE_MS.
   * If the lock cannot be taken in time we continue unlocked — the rename in
   * save() still guarantees a parseable file, only last-writer-wins is lost.
   */
  private lock(): () => void {
    const lockFile = `${this.file}.lock`
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx')
        fs.writeSync(fd, String(process.pid))
        fs.closeSync(fd)
        return () => {
          try {
            fs.unlinkSync(lockFile)
          } catch {
            // already reaped
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lockFile)
            continue
          }
        } catch {
          continue
        }
        if (Date.now() >= deadline) return () => {}
        sleep(20)
      }
    }
  }

  /** Read-modify-write under the lock, reloading first so parallel writers merge. */
  private mutate<T>(fn: () => T): T {
    const release = this.lock()
    try {
      this.load()
      const out = fn()
      this.save()
      return out
    } finally {
      release()
    }
  }

  add(input: AddInput): { memory: Memory; created: boolean } {
    const text = input.text.trim()
    if (text.length === 0) throw new Error('memory text is empty')
    return this.mutate(() => {
      const h = hashOf(text)
      const existingId = this.byHash.get(h)
      if (existingId) {
        const m = this.memories.find(x => x.id === existingId)
        if (m) {
          m.updatedAt = Date.now()
          if (input.tags?.length) m.tags = [...new Set([...m.tags, ...input.tags])]
          if (input.importance) m.importance = Math.max(m.importance, input.importance)
          return { memory: m, created: false }
        }
      }
      const now = Date.now()
      const memory: Memory = {
        id: newId(),
        text,
        kind: input.kind ?? 'fact',
        tags: unique(input.tags ?? []),
        scope: input.scope ?? projectScope(),
        agent: input.agent ?? 'cli',
        importance: clamp(input.importance ?? 3, 1, 5),
        createdAt: now,
        updatedAt: now,
      }
      if (input.source) memory.source = input.source
      if (input.replaces) {
        const old = this.get(input.replaces)
        if (old) old.supersededBy = memory.id
      }
      this.memories.push(memory)
      this.byHash.set(h, memory.id)
      return { memory, created: true }
    })
  }

  get(id: string): Memory | undefined {
    return this.memories.find(m => m.id === id)
  }

  /** Partial update. Returns the memory, or undefined when the id is unknown. */
  update(id: string, patch: UpdateInput): Memory | undefined {
    if (patch.text !== undefined && patch.text.trim().length === 0) throw new Error('memory text is empty')
    return this.mutate(() => {
      const m = this.get(id)
      if (!m) return undefined
      if (patch.text !== undefined) {
        const text = patch.text.trim()
        if (text !== m.text) {
          const clash = this.byHash.get(hashOf(text))
          if (clash && clash !== id) throw new Error(`duplicate of ${clash}`)
          this.byHash.delete(hashOf(m.text))
          this.byHash.set(hashOf(text), id)
          m.text = text
        }
      }
      if (patch.kind !== undefined) m.kind = patch.kind
      if (patch.tags !== undefined) m.tags = unique(patch.tags)
      if (patch.scope !== undefined) m.scope = patch.scope
      if (patch.agent !== undefined) m.agent = patch.agent
      if (patch.source !== undefined) m.source = patch.source
      if (patch.importance !== undefined) m.importance = clamp(patch.importance, 1, 5)
      if (patch.replaces !== undefined) {
        const old = this.get(patch.replaces)
        if (old && old.id !== id) old.supersededBy = id
      }
      m.updatedAt = Date.now()
      return m
    })
  }

  remove(id: string): boolean {
    return this.removeMany([id]) > 0
  }

  /** Point memories at a surviving one in a single write — used by `dedupe --merge`. */
  markSuperseded(ids: string[], byId: string): number {
    if (ids.length === 0) return 0
    return this.mutate(() => {
      let n = 0
      for (const id of ids) {
        const m = this.get(id)
        if (!m || m.id === byId || m.supersededBy) continue
        m.supersededBy = byId
        n++
      }
      return n
    })
  }

  /** Bulk delete under one lock/write — used by `engram prune`. */
  removeMany(ids: string[]): number {
    const drop = new Set(ids)
    if (drop.size === 0) return 0
    return this.mutate(() => {
      let removed = 0
      this.memories = this.memories.filter(m => {
        if (!drop.has(m.id)) return true
        this.byHash.delete(hashOf(m.text))
        removed++
        return false
      })
      return removed
    })
  }

  /**
   * Bulk insert used by `engram import`. Ids and timestamps survive the round trip
   * (so recency ranking is preserved); collisions fall back to a fresh id / merge.
   */
  importMany(records: unknown[]): { added: number; merged: number; skipped: number } {
    return this.mutate(() => {
      const now = Date.now()
      let added = 0
      let merged = 0
      let skipped = 0
      for (const raw of records) {
        if (!raw || typeof raw !== 'object') {
          skipped++
          continue
        }
        const r = raw as Partial<Memory>
        const text = typeof r.text === 'string' ? r.text.trim() : ''
        if (!text) {
          skipped++
          continue
        }
        const h = hashOf(text)
        if (this.byHash.has(h)) {
          merged++
          continue
        }
        const id = typeof r.id === 'string' && r.id.length > 0 && !this.get(r.id) ? r.id : newId()
        const kind: Kind = isKind(r.kind) ? r.kind : 'fact'
        const createdAt = typeof r.createdAt === 'number' ? r.createdAt : now
        const memory: Memory = {
          id,
          text,
          kind,
          tags: unique(Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : []),
          scope: typeof r.scope === 'string' && r.scope.length > 0 ? r.scope : projectScope(),
          agent: typeof r.agent === 'string' && r.agent.length > 0 ? r.agent : 'import',
          importance: clamp(typeof r.importance === 'number' ? r.importance : 3, 1, 5),
          createdAt,
          updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : createdAt,
        }
        if (typeof r.source === 'string' && r.source.length > 0) memory.source = r.source
        if (typeof r.supersededBy === 'string' && r.supersededBy.length > 0) memory.supersededBy = r.supersededBy
        this.memories.push(memory)
        this.byHash.set(h, id)
        added++
      }
      return { added, merged, skipped }
    })
  }

  scopes(): { scope: string; count: number }[] {
    const map = new Map<string, number>()
    for (const m of this.memories) map.set(m.scope, (map.get(m.scope) ?? 0) + 1)
    return [...map.entries()].map(([scope, count]) => ({ scope, count })).sort((a, b) => b.count - a.count)
  }

  stats(): { total: number; active: number; superseded: number; byKind: Record<string, number> } {
    const byKind: Record<string, number> = {}
    let active = 0
    for (const m of this.memories) {
      byKind[m.kind] = (byKind[m.kind] ?? 0) + 1
      if (!m.supersededBy) active++
    }
    return { total: this.memories.length, active, superseded: this.memories.length - active, byKind }
  }
}

export function isKind(v: unknown): v is Kind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v)
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.map(x => x.trim()).filter(Boolean))]
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)))
}
