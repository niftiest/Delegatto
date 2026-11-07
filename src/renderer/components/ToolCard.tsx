import { useContext } from 'react'
import type { RenderItem } from '../../shared/types'
import { OpenSubagentContext, isAgentTool } from './SubagentViewer'

type ToolItem = Extract<RenderItem, { kind: 'tool' }>

export function ToolCard({ item, defaultOpen = false, pending = false }: { item: ToolItem; defaultOpen?: boolean; pending?: boolean }) {
  const isError = item.result?.isError === true
  const openSubagent = useContext(OpenSubagentContext)
  const summary = typeof item.input === 'object' && item.input !== null
    ? Object.entries(item.input as Record<string, unknown>)
        .slice(0, 2)
        .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
        .join(' ')
    : ''
  // Some tool calls (Write, Edit) can carry megabytes of file content in the
  // input payload; an unbounded JSON.stringify + <pre> would stall the
  // renderer on those. Cap it the same way the result text already is.
  const inputJson = JSON.stringify(item.input, null, 2) ?? ''
  return (
    <details className={isError ? 'tool err' : 'tool'} open={defaultOpen || undefined}>
      <summary>
        <span className="caret" aria-hidden="true">▸</span>
        <span className="nm">{item.name}</span>
        <span className="tool-args">{summary}</span>
        <span className="meta">{item.result === null ? (pending ? 'running…' : 'no result') : isError ? 'error' : `${item.result.text.length} chars`}</span>
      </summary>
      {isAgentTool(item.name) && openSubagent !== null && (
        <button type="button" className="btn-secondary tool-open-agent" onClick={() => openSubagent(item.toolUseId)}>View what it did</button>
      )}
      <pre>{inputJson.slice(0, 8000)}</pre>
      {item.result !== null && <pre>{item.result.text.slice(0, 8000)}</pre>}
    </details>
  )
}
