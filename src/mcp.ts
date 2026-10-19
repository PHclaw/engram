import readline from 'node:readline'
import { KINDS, Store, projectScope, type Kind, type Memory, type UpdateInput } from './store'
import { contextBlock, searchMemories } from './search'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_VERSION = '0.1.0'

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)
const bool = (v: unknown): boolean => v === true
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean) : []

function kindOf(v: unknown): Kind | undefined {
  const k = str(v)
  if (!k) return undefined
  if (!(KINDS as readonly string[]).includes(k)) throw new Error(`unknown kind "${k}" — use one of: ${KINDS.join(', ')}`)
  return k as Kind
}

function describe(m: Memory, score?: number): string {
  const meta = [m.scope, m.kind, `importance ${m.importance}`, new Date(m.updatedAt).toISOString().slice(0, 10)]
  if (score !== undefined) meta.push(`score ${score.toFixed(2)}`)
  if (m.supersededBy) meta.push(`superseded by ${m.supersededBy}`)
  const tags = m.tags.length ? ` #${m.tags.join(' #')}` : ''
  return `[${m.id}] ${m.text}${tags}\n  (${meta.join(' · ')})`
}

function tools(store: Store): ToolDef[] {
  const readScope = (args: Record<string, unknown>): { scope?: string; allScopes: boolean } => {
    const explicit = str(args.scope)
    if (explicit) return { scope: explicit, allScopes: bool(args.all_scopes) }
    if (bool(args.all_scopes)) return { scope: undefined, allScopes: true }
    return { scope: projectScope(), allScopes: false }
  }

  return [
    {
      name: 'memory_add',
      description:
        'Save a durable memory: a fact, preference, decision, task or code snippet. Duplicate text is merged instead of duplicated. Use this whenever the user states something worth remembering across sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The memory, written as a standalone statement.' },
          kind: { type: 'string', enum: KINDS, description: 'Category. Default: fact.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags for filtering.' },
          scope: { type: 'string', description: `Namespacing, e.g. "project:engram", "user:alice", "global". Default: ${projectScope()}.` },
          importance: { type: 'number', minimum: 1, maximum: 5, description: 'Ranking weight. Default: 3.' },
          source: { type: 'string', description: 'Where it came from (file, URL, conversation).' },
          replaces: { type: 'string', description: 'Id of an older memory this one supersedes.' },
        },
        required: ['text'],
      },
      run: args => {
        const text = str(args.text)
        if (!text) throw new Error('text is required')
        const { memory, created } = store.add({
          text,
          kind: kindOf(args.kind),
          tags: list(args.tags),
          scope: str(args.scope),
          agent: str(args.agent) ?? 'mcp',
          source: str(args.source),
          importance: num(args.importance),
          replaces: str(args.replaces),
        })
        return created ? `Saved ${memory.id}\n${describe(memory)}` : `Already known — merged into ${memory.id}\n${describe(memory)}`
      },
    },
    {
      name: 'memory_search',
      description:
        'Search memories with BM25 (Chinese text is indexed by character unigram + bigram), then weighted by importance and recency. Call this before answering questions about prior context.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords or a natural-language question.' },
          limit: { type: 'number', minimum: 1, maximum: 50, description: 'Max results. Default: 5.' },
          offset: { type: 'number', minimum: 0, description: 'Skip the first n results (paging).' },
          scope: { type: 'string', description: 'Restrict to one scope (global memories always included).' },
          all_scopes: { type: 'boolean', description: 'Search every scope.' },
          kind: { type: 'string', enum: KINDS },
          include_superseded: { type: 'boolean', description: 'Also return replaced memories.' },
        },
        required: ['query'],
      },
      run: args => {
        const query = str(args.query)
        if (!query) throw new Error('query is required')
        const { scope, allScopes } = readScope(args)
        const hits = searchMemories(store.memories, query, {
          limit: num(args.limit) ?? 5,
          offset: num(args.offset) ?? 0,
          scope,
          allScopes,
          kind: kindOf(args.kind),
          includeSuperseded: bool(args.include_superseded),
        })
        if (hits.length === 0) return `No memories matched "${query}".`
        return `${hits.length} match(es) for "${query}":\n\n` + hits.map(h => describe(h.memory, h.score)).join('\n\n')
      },
    },
    {
      name: 'memory_context',
      description:
        'Return top matching memories already wrapped in a <memory> block, ready to inject into a system prompt. Prefer this when you just need context rather than a list.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the current task is about.' },
          limit: { type: 'number', minimum: 1, maximum: 50, description: 'Max memories. Default: 8.' },
          max_chars: { type: 'number', minimum: 100, description: 'Budget for the block. Default: 1500.' },
          scope: { type: 'string' },
          all_scopes: { type: 'boolean' },
        },
        required: ['query'],
      },
      run: args => {
        const query = str(args.query)
        if (!query) throw new Error('query is required')
        const { scope, allScopes } = readScope(args)
        const hits = searchMemories(store.memories, query, { limit: num(args.limit) ?? 8, scope, allScopes })
        const block = contextBlock(hits, num(args.max_chars) ?? 1500)
        return block || 'No memories matched — nothing to inject.'
      },
    },
    {
      name: 'memory_list',
      description: 'List recent memories, newest first. Useful for reviewing or cleaning up what is stored.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 200, description: 'Default: 20.' },
          offset: { type: 'number', minimum: 0 },
          scope: { type: 'string' },
          all_scopes: { type: 'boolean' },
          kind: { type: 'string', enum: KINDS },
          tag: { type: 'string' },
          include_superseded: { type: 'boolean' },
        },
      },
      run: args => {
        const { scope, allScopes } = readScope(args)
        const tag = str(args.tag)
        const hits = searchMemories(store.memories, '', {
          limit: num(args.limit) ?? 20,
          offset: num(args.offset) ?? 0,
          scope,
          allScopes,
          kind: kindOf(args.kind),
          includeSuperseded: bool(args.include_superseded),
        }).filter(h => !tag || h.memory.tags.includes(tag))
        if (hits.length === 0) return 'No memories stored yet.'
        return hits.map(h => describe(h.memory)).join('\n\n')
      },
    },
    {
      name: 'memory_get',
      description: 'Fetch a single memory by id (full JSON, including timestamps and supersede links).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Memory id, as shown in brackets by other tools.' } },
        required: ['id'],
      },
      run: args => {
        const id = str(args.id)
        if (!id) throw new Error('id is required')
        const m = store.get(id)
        if (!m) throw new Error(`no memory with id ${id}`)
        return JSON.stringify(m, null, 2)
      },
    },
    {
      name: 'memory_update',
      description: 'Patch an existing memory. Only pass the fields that change. Use replaces on a new memory instead when the old one should be kept as history.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          tags: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
          importance: { type: 'number', minimum: 1, maximum: 5 },
          source: { type: 'string' },
        },
        required: ['id'],
      },
      run: args => {
        const id = str(args.id)
        if (!id) throw new Error('id is required')
        const patch: UpdateInput = {}
        if (args.text !== undefined) patch.text = String(args.text)
        if (args.kind !== undefined) patch.kind = kindOf(args.kind)
        if (args.tags !== undefined) patch.tags = list(args.tags)
        if (args.scope !== undefined) patch.scope = String(args.scope)
        if (args.source !== undefined) patch.source = String(args.source)
        if (args.importance !== undefined) {
          const n = num(args.importance)
          if (n === undefined) throw new Error('importance must be a number')
          patch.importance = n
        }
        if (Object.keys(patch).length === 0) throw new Error('nothing to update')
        const m = store.update(id, patch)
        if (!m) throw new Error(`no memory with id ${id}`)
        return `Updated ${m.id}\n${describe(m)}`
      },
    },
    {
      name: 'memory_delete',
      description: 'Permanently delete a memory by id. Prefer memory_add with `replaces` when the fact merely changed.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: args => {
        const id = str(args.id)
        if (!id) throw new Error('id is required')
        if (!store.remove(id)) throw new Error(`no memory with id ${id}`)
        return `Deleted ${id}`
      },
    },
    {
      name: 'memory_stats',
      description: 'Summary of the memory store: totals, active vs superseded, counts per kind and scope.',
      inputSchema: { type: 'object', properties: {} },
      run: () => JSON.stringify({ ...store.stats(), scopes: store.scopes(), file: store.file }, null, 2),
    },
  ]
}

/** Read an `engram://` resource; undefined means "no such resource". */
function readResource(store: Store, uri: string): string | undefined {
  if (uri === 'engram://stats') {
    return JSON.stringify({ ...store.stats(), scopes: store.scopes(), file: store.file }, null, 2)
  }
  const memory = /^engram:\/\/memory\/([^/]+)$/.exec(uri)
  if (memory) {
    const m = store.get(decodeURIComponent(memory[1]))
    return m ? JSON.stringify(m, null, 2) : undefined
  }
  const scope = /^engram:\/\/scope\/([^/]+)$/.exec(uri)
  if (scope) {
    const name = decodeURIComponent(scope[1])
    return JSON.stringify(
      store.memories.filter(m => m.scope === name),
      null,
      2,
    )
  }
  return undefined
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id: RpcRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result })
}

function replyError(id: RpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

function handle(req: RpcRequest, store: Store): void {
  const id = req.id
  const isNotification = id === undefined || id === null
  const toolset = tools(store)

  switch (req.method) {
    case 'initialize':
      reply(id, {
        protocolVersion: str(req.params?.protocolVersion) ?? PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'engram', version: SERVER_VERSION },
        instructions:
          'engram is a local, file-backed long-term memory store. Before answering questions about the user, their preferences, or earlier decisions, call memory_search (or memory_context for a prompt-ready block). When the user states a durable fact, preference, decision or task, call memory_add — and use memory_add with `replaces` when a fact changed, rather than deleting history. Memories are scoped (project/user/global); reads default to the current project plus global.',
      })
      return

    case 'ping':
      reply(id, {})
      return

    case 'tools/list':
      reply(id, { tools: toolset.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      return

    case 'tools/call': {
      const name = str(req.params?.name)
      const tool = toolset.find(t => t.name === name)
      if (!name || !tool) {
        replyError(id, -32602, `unknown tool "${name ?? ''}"`)
        return
      }
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>
      try {
        reply(id, { content: [{ type: 'text', text: tool.run(args) }] })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        reply(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true })
      }
      return
    }

    case 'resources/list':
      reply(id, {
        resources: [
          { uri: 'engram://stats', name: 'Memory store stats', mimeType: 'application/json' },
          ...store.scopes().map(s => ({
            uri: `engram://scope/${encodeURIComponent(s.scope)}`,
            name: `Scope ${s.scope} (${s.count} memories)`,
            mimeType: 'application/json',
          })),
        ],
      })
      return

    case 'resources/templates/list':
      reply(id, {
        resourceTemplates: [
          { uriTemplate: 'engram://memory/{id}', name: 'Memory by id', mimeType: 'application/json' },
          { uriTemplate: 'engram://scope/{scope}', name: 'Every memory in a scope', mimeType: 'application/json' },
        ],
      })
      return

    case 'resources/read': {
      const uri = str(req.params?.uri)
      if (!uri) {
        replyError(id, -32602, 'uri is required')
        return
      }
      const text = readResource(store, uri)
      if (text === undefined) {
        replyError(id, -32602, `unknown resource ${uri}`)
        return
      }
      reply(id, { contents: [{ uri, mimeType: 'application/json', text }] })
      return
    }

    case 'prompts/list':
      reply(id, { prompts: [] })
      return

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return

    default:
      if (isNotification) return
      replyError(id, -32601, `method not found: ${req.method ?? ''}`)
  }
}

/** MCP stdio server: newline-delimited JSON-RPC, stdout reserved for the protocol. */
export function serve(storeFile?: string): void {
  const store = new Store(storeFile)
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  let queue = Promise.resolve()

  const onLine = (line: string): void => {
    const text = line.trim()
    if (!text) return
    queue = queue.then(() => {
      let req: RpcRequest
      try {
        req = JSON.parse(text) as RpcRequest
      } catch {
        replyError(null, -32700, 'parse error')
        return
      }
      try {
        handle(req, store)
      } catch (err) {
        replyError(req.id ?? null, -32603, err instanceof Error ? err.message : String(err))
      }
    })
  }

  rl.on('line', onLine)
  rl.on('close', () => {
    void queue.then(() => process.exit(0))
  })
}
