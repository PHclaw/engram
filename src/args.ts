export interface ParsedArgs {
  _: string[]
  flags: Record<string, string | boolean>
}

const BOOL_FLAGS = new Set([
  'json',
  'all-scopes',
  'include-superseded',
  'yes',
  'help',
  'h',
  'version',
  'v',
  'quiet',
  'q',
  'explain',
  'merge',
  'cross-scope',
])

/** Minimal zero-dependency argv parser: `--key value` / `--key=value` / `--bool`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (BOOL_FLAGS.has(body)) {
        flags[body] = true
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
    } else if (a.startsWith('-') && a.length > 1) {
      flags[a.slice(1)] = true
    } else {
      positional.push(a)
    }
  }
  return { _: positional, flags }
}
