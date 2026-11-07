import type { LiveEvent } from './engine-types'

/** What each running subagent is doing, built from Claude Code's live frames. */

export type AgentRun = { toolUseId: string; description: string; steps: string[] }

const MAX_STEPS = 4
const MAX_LABEL = 90

function shorten(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? ''
  return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}…` : line
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(p => p.length > 0).pop() ?? path
}

/** One tool call in a line: its name, and the part of its input that says what it's for. */
export function stepLabel(name: string, input: unknown): string {
  const args = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  const path = args.file_path ?? args.notebook_path ?? args.path
  if (typeof path === 'string' && path.length > 0) return `${name} ${baseName(path)}`
  for (const key of ['command', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return shorten(`${name} ${value}`)
  }
  return name
}

/** What a line of the subagent's own writing shows. */
export function textStep(text: string): string {
  return shorten(text)
}

export function reduceAgentRuns(runs: AgentRun[], ev: LiveEvent): AgentRun[] {
  switch (ev.kind) {
    case 'taskStarted':
      if (runs.some(r => r.toolUseId === ev.toolUseId)) return runs
      return [...runs, { toolUseId: ev.toolUseId, description: ev.description, steps: [] }]
    case 'subagentStep': {
      if (!runs.some(r => r.toolUseId === ev.parent)) return runs
      return runs.map(r => r.toolUseId === ev.parent ? { ...r, steps: [...r.steps, ev.label].slice(-MAX_STEPS) } : r)
    }
    case 'taskEnded':
      return runs.filter(r => r.toolUseId !== ev.toolUseId)
    // The process has gone, and whatever it was running with it.
    case 'exit':
      return runs.length === 0 ? runs : []
    default:
      return runs
  }
}
