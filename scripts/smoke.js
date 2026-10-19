#!/usr/bin/env node
/**
 * End-to-end smoke test. Zero dependencies: build first, then `npm run smoke`.
 * Exercises the CLI (add/search/dedupe/supersede/update/delete) and the MCP
 * stdio server (initialize, tools/list, tools/call).
 */
const { spawnSync, spawn } = require('node:child_process')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const bin = path.join(__dirname, '..', 'dist', 'index.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-smoke-'))
const store = path.join(tmp, 'memory.jsonl')
const env = { ...process.env, ENGRAM_STORE: store, NO_COLOR: '1' }

/** Windows can briefly hold temp files after a spawned child exits — retry the wipe. */
function cleanup() {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } catch (err) {
    console.error(`warning: could not remove ${tmp}: ${err.message}`)
  }
}

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

async function okAsync(name, fn) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

function cli(...args) {
  const r = spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`engram ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

function json(...args) {
  return JSON.parse(cli(...args, '--json'))
}

/** Run against an explicit store file, returning the raw result (used for failure cases). */
function runIn(storeFile, ...args) {
  return spawnSync(process.execPath, [bin, ...args], { env: { ...env, ENGRAM_STORE: storeFile }, encoding: 'utf8' })
}

function cliIn(storeFile, ...args) {
  const r = runIn(storeFile, ...args)
  if (r.status !== 0) throw new Error(`engram ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

console.log('CLI')

ok('add returns an id', () => {
  const out = json('add', 'User prefers tabs over spaces', '--kind', 'preference', '--tags', 'style,editor')
  assert.ok(out.created)
  assert.match(out.memory.id, /^[a-z0-9]+$/)
  assert.strictEqual(out.memory.kind, 'preference')
  assert.deepStrictEqual(out.memory.tags, ['style', 'editor'])
})

ok('duplicate text is merged, not stored twice', () => {
  const a = json('add', 'User prefers tabs over spaces')
  assert.strictEqual(a.created, false)
  assert.strictEqual(json('stats').total, 1)
})

ok('chinese memory is stored', () => {
  const out = json('add', '部署流程：先用 npm run build，再推送到生产环境', '--kind', 'task', '--importance', '5')
  assert.ok(out.created)
})

ok('cjk search matches without a segmenter', () => {
  const out = json('search', '生产环境 部署')
  assert.strictEqual(out.count, 1)
  assert.match(out.hits[0].memory.text, /部署流程/)
})

ok('importance boosts ranking', () => {
  cli('add', 'deploy notes for staging', '--importance', '1')
  cli('add', 'deploy notes for production', '--importance', '5')
  const hits = json('search', 'deploy notes').hits
  assert.match(hits[0].memory.text, /production/)
})

ok('context block is prompt-ready', () => {
  const out = cli('context', 'deploy')
  assert.match(out, /^<memory>\n- \[/)
  assert.match(out, /<\/memory>\n$/)
})

ok('supersede hides the old memory by default', () => {
  const old = json('add', 'Use port 3000 for the dev server')
  json('add', 'Use port 4000 for the dev server', '--replaces', old.memory.id)
  assert.strictEqual(json('search', 'dev server port').count, 1)
  const all = json('search', 'dev server port', '--include-superseded')
  assert.strictEqual(all.count, 2)
  assert.strictEqual(all.hits.filter(h => h.memory.supersededBy).length, 1)
})

ok('update patches fields', () => {
  const { memory } = json('add', 'temporary note about cache')
  const patched = json('update', memory.id, '--text', 'cache is warmed every 10 minutes', '--importance', '4')
  assert.strictEqual(patched.importance, 4)
  assert.match(patched.text, /warmed/)
  assert.strictEqual(json('get', memory.id).text, patched.text)
})

ok('rm --yes deletes', () => {
  const { memory } = json('add', 'throwaway fact')
  cli('rm', memory.id, '--yes')
  const r = spawnSync(process.execPath, [bin, 'get', memory.id], { env, encoding: 'utf8' })
  assert.notStrictEqual(r.status, 0)
})

ok('scopes are listed', () => {
  const rows = json('scopes')
  assert.ok(rows.length >= 1)
  assert.ok(rows.every(r => typeof r.scope === 'string' && r.count > 0))
})

ok('list is newest-first and bounded', () => {
  const rows = json('list', '--limit', '3')
  assert.ok(rows.hits.length === 3)
  const ts = rows.hits.map(h => h.memory.updatedAt)
  assert.deepStrictEqual(ts, [...ts].sort((a, b) => b - a))
})

ok('search --offset pages through results', () => {
  const all = json('search', 'deploy', '--limit', '2')
  assert.ok(all.hits.length === 2)
  const page = json('search', 'deploy', '--limit', '1', '--offset', '1')
  assert.strictEqual(page.hits[0].memory.id, all.hits[1].memory.id)
})

ok('search --explain shows the score breakdown', () => {
  const out = cli('search', 'deploy', '--limit', '1', '--explain')
  assert.match(out, /bm25 \d+\.\d\d × imp \d+\.\d\d × rec \d+\.\d\d × scope \d+\.\d\d/)
  assert.ok(json('search', 'deploy', '--limit', '1').hits[0].parts.bm25 > 0)
})

ok('inject builds context from stdin', () => {
  const r = spawnSync(process.execPath, [bin, 'inject'], { env, encoding: 'utf8', input: '部署流程' })
  assert.strictEqual(r.status, 0)
  assert.match(r.stdout, /<memory>[\s\S]*部署流程/)
})

ok('inject unwraps a json hook payload', () => {
  const payload = JSON.stringify({ hook: 'UserPromptSubmit', prompt: '部署流程' })
  const r = spawnSync(process.execPath, [bin, 'inject'], { env, encoding: 'utf8', input: payload })
  assert.strictEqual(r.status, 0)
  assert.match(r.stdout, /<memory>[\s\S]*部署流程/)
})

ok('inject stays silent when nothing matches', () => {
  const r = spawnSync(process.execPath, [bin, 'inject', 'zzzz-no-such-term'], { env, encoding: 'utf8', input: '' })
  assert.strictEqual(r.status, 0)
  assert.strictEqual(r.stdout.trim(), '')
})

ok('inject --json always emits a payload', () => {
  const out = JSON.parse(cli('inject', 'zzzz-no-such-term', '--json'))
  assert.strictEqual(out.count, 0)
  assert.strictEqual(out.context, '')
})

ok('context clips an oversized hit instead of returning an empty block', () => {
  cli('add', `长文本记忆 ${'x'.repeat(300)} zzzuniquetoken`, '--importance', '2')
  const out = cli('context', 'zzzuniquetoken', '--max-chars', '120')
  assert.match(out, /^<memory>\n- \[fact\] 长文本记忆 x+/)
  assert.match(out, /…\n<\/memory>\n$/)
  assert.ok(out.trim().length <= 120, `block is ${out.trim().length} chars`)
})

ok('context returns nothing when the budget is too small', () => {
  assert.strictEqual(cli('context', 'zzzuniquetoken', '--max-chars', '30').trim(), '')
})

ok('doctor reports a healthy store', () => {
  const r = cliIn(store, 'doctor', '--json')
  const out = JSON.parse(r)
  assert.strictEqual(out.ok, true)
  assert.deepStrictEqual(out.issues, [])
})

ok('doctor flags a dangling supersede link', () => {
  const broken = path.join(tmp, 'broken.jsonl')
  const now = Date.now()
  fs.writeFileSync(
    broken,
    JSON.stringify({ id: 'orphan1', text: 'orphan record', kind: 'fact', tags: [], scope: 'global', agent: 'test', importance: 3, createdAt: now, updatedAt: now, supersededBy: 'missing1' }) + '\n',
  )
  const r = runIn(broken, 'doctor', '--json')
  assert.strictEqual(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.ok(out.issues.some(i => /supersededBy/.test(i)), out.issues.join('; '))
})

ok('export/import round-trips ids, timestamps and supersede links', () => {
  const file = path.join(tmp, 'dump.jsonl')
  fs.writeFileSync(file, cli('export'))
  const copy = path.join(tmp, 'copy.jsonl')
  const res = JSON.parse(cliIn(copy, 'import', file, '--json'))
  const before = json('stats')
  assert.strictEqual(res.added, before.total)
  assert.strictEqual(res.skipped, 0)

  const after = JSON.parse(cliIn(copy, 'stats', '--json'))
  assert.strictEqual(after.total, before.total)

  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const old = records.find(m => m.supersededBy)
  if (old) {
    const got = JSON.parse(cliIn(copy, 'get', old.id, '--json'))
    assert.strictEqual(got.supersededBy, old.supersededBy)
    assert.strictEqual(got.updatedAt, old.updatedAt)
  }
  assert.strictEqual(JSON.parse(cliIn(copy, 'doctor', '--json')).ok, true)
})

ok('import merges duplicates instead of duplicating', () => {
  const copy = path.join(tmp, 'copy.jsonl')
  const again = JSON.parse(cliIn(copy, 'import', path.join(tmp, 'dump.jsonl'), '--json'))
  assert.strictEqual(again.added, 0)
  assert.ok(again.merged > 0)
})

ok('dedupe finds near-duplicates and merges them', () => {
  const p = path.join(tmp, 'dedupe.jsonl')
  cliIn(p, 'add', '部署前必须先运行构建脚本再发布到生产环境', '--importance', '4', '--tags', 'deploy,ci', '--json')
  cliIn(p, 'add', '部署前必须先运行构建脚本再发布到线上环境', '--importance', '2', '--tags', 'release', '--json')
  const report = JSON.parse(cliIn(p, 'dedupe', '--threshold', '0.7', '--json'))
  assert.strictEqual(report.count, 1)
  assert.ok(report.pairs[0].similarity >= 0.7)

  const merged = JSON.parse(cliIn(p, 'dedupe', '--threshold', '0.7', '--merge', '--yes', '--json'))
  assert.strictEqual(merged.merged, 1)
  const active = JSON.parse(cliIn(p, 'list', '--all-scopes', '--json')).hits
  assert.strictEqual(active.length, 1)
  assert.deepStrictEqual(active[0].memory.tags.sort(), ['ci', 'deploy', 'release'])
  assert.strictEqual(active[0].memory.importance, 4)
  assert.strictEqual(JSON.parse(cliIn(p, 'doctor', '--json')).ok, true)
})

ok('dedupe ignores unrelated memories', () => {
  const p = path.join(tmp, 'dedupe-neg.jsonl')
  cliIn(p, 'add', 'deploy to production', '--json')
  cliIn(p, 'add', 'user prefers dark mode', '--json')
  assert.strictEqual(JSON.parse(cliIn(p, 'dedupe', '--json')).count, 0)
})

ok('dedupe stays inside a scope unless --cross-scope', () => {
  const p = path.join(tmp, 'dedupe-scope.jsonl')
  cliIn(p, 'add', 'shared deployment checklist runs build first', '--scope', 'project:a', '--json')
  cliIn(p, 'add', 'shared deployment checklist runs build always', '--scope', 'project:b', '--json')
  assert.strictEqual(JSON.parse(cliIn(p, 'dedupe', '--threshold', '0.7', '--json')).count, 0)
  assert.strictEqual(JSON.parse(cliIn(p, 'dedupe', '--threshold', '0.7', '--cross-scope', '--json')).count, 1)
})

ok('prune deletes superseded history', () => {
  const p = path.join(tmp, 'prune.jsonl')
  const old = JSON.parse(cliIn(p, 'add', 'old port is 3000', '--json')).memory
  cliIn(p, 'add', 'old port is 4000', '--replaces', old.id, '--json')
  assert.strictEqual(JSON.parse(cliIn(p, 'stats', '--json')).superseded, 1)
  const res = JSON.parse(cliIn(p, 'prune', '--yes', '--json'))
  assert.strictEqual(res.removed, 1)
  const after = JSON.parse(cliIn(p, 'stats', '--json'))
  assert.strictEqual(after.total, 1)
  assert.strictEqual(after.superseded, 0)
})

ok('prune --days keeps recent history', () => {
  const p = path.join(tmp, 'prune-days.jsonl')
  const old = JSON.parse(cliIn(p, 'add', 'old value 1', '--json')).memory
  cliIn(p, 'add', 'new value 2', '--replaces', old.id, '--json')
  assert.strictEqual(JSON.parse(cliIn(p, 'prune', '--days', '7', '--yes', '--json')).removed, 0)
})

console.log('MCP')

function mcpSession(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    const replies = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`mcp timeout, got ${replies.length} replies`))
    }, 8000)
    child.stdout.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) replies.push(JSON.parse(line))
      }
      if (replies.length >= messages.length) {
        clearTimeout(timer)
        child.kill()
        resolve(replies)
      }
    })
    child.stderr.on('data', d => process.stderr.write(`[mcp] ${d}`))
    child.on('error', reject)
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n')
  })
}

;(async () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { query: '部署', all_scopes: true } } }
  const add = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_add', arguments: { text: 'MCP 写入的记忆', kind: 'fact', tags: ['mcp'] } } }
  const ctx = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory_context', arguments: { query: 'MCP 记忆', all_scopes: true } } }
  const bad = { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } }
  const firstId = json('list', '--limit', '1').hits[0].memory.id
  const resList = { jsonrpc: '2.0', id: 7, method: 'resources/list' }
  const resTpl = { jsonrpc: '2.0', id: 8, method: 'resources/templates/list' }
  const resRead = { jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: `engram://memory/${firstId}` } }
  const resBad = { jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'engram://nope' } }

  const out = await mcpSession([init, list, call, add, ctx, bad, resList, resTpl, resRead, resBad])

  ok('initialize reports a protocol version, server info and usage instructions', () => {
    assert.strictEqual(out[0].result.serverInfo.name, 'engram')
    assert.strictEqual(typeof out[0].result.protocolVersion, 'string')
    assert.match(out[0].result.instructions ?? '', /memory_search/)
  })

  ok('tools/list exposes the memory tools', () => {
    const names = out[1].result.tools.map(t => t.name)
    for (const n of ['memory_add', 'memory_search', 'memory_context', 'memory_list', 'memory_get', 'memory_update', 'memory_delete', 'memory_stats']) {
      assert.ok(names.includes(n), `missing tool ${n}`)
    }
    assert.ok(out[1].result.tools.every(t => t.inputSchema && t.description))
  })

  ok('memory_search returns cjk hits over stdio', () => {
    assert.match(out[2].result.content[0].text, /部署流程/)
  })

  ok('memory_add writes through mcp', () => {
    assert.match(out[3].result.content[0].text, /Saved/)
  })

  ok('memory_context returns a <memory> block', () => {
    assert.match(out[4].result.content[0].text, /<memory>[\s\S]*MCP 写入的记忆[\s\S]*<\/memory>/)
  })

  ok('unknown tool is a json-rpc error, not a crash', () => {
    assert.strictEqual(out[5].error.code, -32602)
  })

  ok('resources/list exposes stats and scopes', () => {
    const uris = out[6].result.resources.map(r => r.uri)
    assert.ok(uris.includes('engram://stats'), uris.join(', '))
    assert.ok(uris.some(u => u.startsWith('engram://scope/')), uris.join(', '))
  })

  ok('resources/templates/list advertises memory and scope templates', () => {
    const tpl = out[7].result.resourceTemplates.map(t => t.uriTemplate)
    assert.deepStrictEqual(tpl, ['engram://memory/{id}', 'engram://scope/{scope}'])
  })

  ok('resources/read returns a memory as json', () => {
    const body = JSON.parse(out[8].result.contents[0].text)
    assert.strictEqual(out[8].result.contents[0].uri, `engram://memory/${firstId}`)
    assert.strictEqual(body.id, firstId)
  })

  ok('resources/read rejects an unknown uri', () => {
    assert.strictEqual(out[9].error.code, -32602)
  })

  await okAsync('parallel writers keep every memory', async () => {
    const p = path.join(tmp, 'parallel.jsonl')
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [bin, 'add', `parallel fact ${i}`, '--json'], {
          env: { ...env, ENGRAM_STORE: p },
          stdio: 'ignore',
        })
        child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`parallel add ${i} exited ${code}`))))
        child.on('error', reject)
      })),
    )
    const st = JSON.parse(cliIn(p, 'stats', '--json'))
    assert.strictEqual(st.total, 8)
    assert.strictEqual(JSON.parse(cliIn(p, 'doctor', '--json')).ok, true)
  })

  cleanup()
  console.log(`\n${passed} checks passed`)
})().catch(err => {
  cleanup()
  console.error(err)
  process.exit(1)
})
