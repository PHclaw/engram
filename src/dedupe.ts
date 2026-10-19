import type { Memory } from './store'
import { tokenize } from './search'

export interface DuplicatePair {
  a: Memory
  b: Memory
  similarity: number
}

export interface DedupeOpts {
  threshold?: number
  limit?: number
  /** Compare memories across scopes (default: only within the same scope). */
  crossScope?: boolean
}

/**
 * Near-duplicate detection via Jaccard similarity over BM25 tokens.
 * Pairs are gathered through an inverted index (only reasonably specific tokens
 * are indexed) so a large store does not degrade into an O(n²) scan.
 */
export function findDuplicates(memories: Memory[], opts: DedupeOpts = {}): DuplicatePair[] {
  const threshold = clamp(opts.threshold ?? 0.8, 0.1, 1)
  const limit = opts.limit ?? 50

  const groups = new Map<string, Memory[]>()
  for (const m of memories) {
    if (m.supersededBy) continue
    const key = opts.crossScope ? '*' : m.scope
    const bucket = groups.get(key)
    if (bucket) bucket.push(m)
    else groups.set(key, [m])
  }

  const pairs: DuplicatePair[] = []
  for (const group of groups.values()) {
    if (group.length > 1) pairs.push(...pairsInGroup(group, threshold))
  }
  pairs.sort((x, y) => y.similarity - x.similarity)
  return pairs.slice(0, limit)
}

function pairsInGroup(memories: Memory[], threshold: number): DuplicatePair[] {
  const docs = memories
    .map(m => ({ m, set: new Set(tokenize(m.text)) }))
    .filter(d => d.set.size > 1)
  if (docs.length < 2) return []

  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.set) df.set(t, (df.get(t) ?? 0) + 1)

  // Tokens shared by a large share of the store (common CJK unigrams, "the"…) are
  // not evidence of duplication, so they are left out of the index.
  const maxDf = Math.max(3, Math.ceil(docs.length * 0.1))
  const index = new Map<string, number[]>()
  docs.forEach((d, i) => {
    for (const t of d.set) {
      if ((df.get(t) ?? 0) > maxDf) continue
      const bucket = index.get(t)
      if (bucket) bucket.push(i)
      else index.set(t, [i])
    }
  })

  const out: DuplicatePair[] = []
  const seen = new Set<number>()
  for (const bucket of index.values()) {
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        const i = bucket[x]
        const j = bucket[y]
        const key = i * docs.length + j
        if (seen.has(key)) continue
        seen.add(key)
        const A = docs[i]
        const B = docs[j]
        if (Math.min(A.set.size, B.set.size) / Math.max(A.set.size, B.set.size) < threshold) continue
        const [small, big] = A.set.size <= B.set.size ? [A, B] : [B, A]
        let inter = 0
        for (const t of small.set) if (big.set.has(t)) inter++
        const similarity = inter / (A.set.size + B.set.size - inter)
        if (similarity >= threshold) out.push({ a: A.m, b: B.m, similarity })
      }
    }
  }
  return out
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
