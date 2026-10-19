#!/usr/bin/env node
import { run } from './cli'

run(process.argv.slice(2))
  .then(code => {
    process.exitCode = code
  })
  .catch(err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
