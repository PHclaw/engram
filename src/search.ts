import type { Memory } from './store'
import { inScope } from './store'

const K1 = 1.2
const B = 0.75

/**
 * Tokenizer with CJK support: latin words, plus unigrams and bigrams for CJK
 * runs (so "缩进偏好" matches "偏好 tab 缩进" without a Chinese segmenter).
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const out: string[] = []
  for (const w of lower.match(/[a-z0-9_]+/g) ?? []) out.push(w)
  for (const seg of lower.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []) {
    for (let i = 0; i < seg.length; i++) out.push(seg[i])
    for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2))
  }
  return out
}

export interface SearchOpts {
  limit?: number
  offset?: number
  scope?: string
  allScopes?: boolean
  kind?: string
  includeSuperseded?: boolean
}

export interface HitParts {
  bm25: number
  importance: number
  recency: number
  scope: number
}

export interface Hit {
  memory: Memory
  score: number
  /** Multiplier breakdown, for `search --explain`. */
  parts?: HitParts
}

/**
 * BM25 over text + tags, then boosted by importance, recency and scope match.
 * Ranking is deliberately explainable — no embeddings, no API keys.
 */
export function searchMemories(memories: Memory[], query: string, opts: SearchOpts = {}): Hit[] {
  const limit = opts.limit ?? 5
  const offset = Math.max(0, opts.offset ?? 0)
  let pool = opts.includeSuperseded ? memories.slice() : memories.filter(m => !m.supersededBy)
  if (opts.kind) pool = pool.filter(m => m.kind === opts.kind)
  pool = pool.filter(m => inScope(m, opts.scope, opts.allScopes))
  if (pool.length === 0) return []

  const qTokens = [...new Set(tokenize(query))]
  if (qTokens.length === 0) {
    return pool
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(offset, offset + limit)
      .map(m => ({ memory: m, score: 1 }))
  }

  const docs = pool.map(m => ({ m, toks: tokenize(`${m.text} ${m.tags.join(' ')}`) }))
  const df = new Map<string, number>()
  let totalLen = 0
  for (const d of docs) {
    totalLen += d.toks.length
    for (const t of new Set(d.toks)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const N = docs.length
  const avg = totalLen / N || 1
  const now = Date.now()
  const hits: Hit[] = []

  for (const d of docs) {
    const tf = new Map<string, number>()
    for (const t of d.toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    let s = 0
    for (const t of qTokens) {
      const f = tf.get(t)
      if (!f) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.toks.length) / avg)))
    }
    if (s <= 0) continue
    const ageDays = (now - d.m.updatedAt) / 86_400_000
    const importance = 1 + 0.12 * (d.m.importance - 3)
    const recency = 1 + 0.35 * Math.exp(-ageDays / 45)
    // A fact learned in this project beats the same keyword in someone else's scope.
    const scopeFactor = opts.scope && !opts.allScopes && d.m.scope === opts.scope ? 1.08 : 1
    hits.push({
      memory: d.m,
      score: s * importance * recency * scopeFactor,
      parts: { bm25: s, importance, recency, scope: scopeFactor },
    })
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(offset, offset + limit)
}

/** Render hits as a prompt-ready context block. */
export function contextBlock(hits: Hit[], maxChars = 1500): string {
  if (hits.length === 0) return ''
  const head = '<memory>'
  const tail = '</memory>'
  const lines: string[] = []
  let used = head.length + tail.length + 1
  for (const h of hits) {
    const line = `- [${h.memory.kind}] ${h.memory.text}`
    const room = maxChars - used - 1
    if (line.length > room) {
      // Never drop the only hit: clip it to the remaining budget instead.
      if (lines.length === 0 && room > 16) lines.push(line.slice(0, room - 1) + '…')
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return ''
  return `${head}\n${lines.join('\n')}\n${tail}`
}
