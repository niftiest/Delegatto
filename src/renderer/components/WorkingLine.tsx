import { useEffect, useState } from 'react'
import { backgroundTaskLabel, taskHasOutput, workingDetails, type PendingTool } from '../lib'
import type { AgentRun } from '../../shared/subagent-activity'
import type { BackgroundTask } from '../../shared/engine-types'

/** The line under a chat while Claude works, like the terminal's spinner. The word
 *  is Delegatto's own: Claude Code picks its words inside the terminal and doesn't
 *  send them. The times, tokens and running tool are real. */
const VERBS = [
  'Pondering', 'Tinkering', 'Noodling', 'Scheming', 'Percolating', 'Rummaging', 'Conjuring', 'Whirring',
  'Mulling', 'Puzzling', 'Crunching', 'Untangling', 'Hatching', 'Brewing', 'Wrangling', 'Sleuthing',
  'Fiddling', 'Simmering', 'Spelunking', 'Marinating', 'Cogitating', 'Doodling', 'Unravelling', 'Beavering'
]

export function pickVerb(seed: number): string {
  return VERBS[Math.abs(Math.floor(seed)) % VERBS.length]!
}

const MAX_TASK_ROWS = 4

/** Work still going after Claude's turn ended. Without this a chat waiting on it looks
 *  finished, until a reply turns up by itself. */
export function BackgroundTasksLine({ tasks, running, onStop, onShowOutput }: { tasks: BackgroundTask[]; running: boolean; onStop: (taskId: string) => void; onShowOutput?: (taskId: string, title: string) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (tasks.length === 0) return null
  const count = tasks.length === 1 ? '1 background task' : `${tasks.length} background tasks`
  return (
    <div className="background-tasks" role="status">
      {!running && (
        <div className="working-line background-tasks-head">
          <span className="working-star" aria-hidden="true">✻</span> Waiting on {count}… <span className="working-details">(Claude picks this up when it finishes; you can keep chatting)</span>
        </div>
      )}
      {tasks.slice(0, MAX_TASK_ROWS).map(task => {
        const { title, details } = backgroundTaskLabel(task, now)
        return (
          <div className="background-task" key={task.id}>
            <span className="background-task-text" title={title}>{title} <span className="working-details">({details.join(' · ')})</span></span>
            {onShowOutput !== undefined && taskHasOutput(task.type) && <button type="button" className="background-task-output" onClick={() => onShowOutput(task.id, title)}>Output</button>}
            <button type="button" className="queue-btn queue-remove background-task-stop" title="Stop this task" aria-label={`Stop ${title}`} onClick={() => onStop(task.id)}>✕</button>
          </div>
        )
      })}
      {tasks.length > MAX_TASK_ROWS && <div className="background-task"><span className="background-task-text working-details">and {tasks.length - MAX_TASK_ROWS} more</span></div>}
    </div>
  )
}

/** What each running subagent is doing right now, as it happens. */
export function SubagentsLive({ runs, onView }: { runs: AgentRun[]; onView: (toolUseId: string) => void }) {
  if (runs.length === 0) return null
  return (
    <div className="subagents-live" role="status">
      {runs.map(run => (
        <div className="subagent-live" key={run.toolUseId}>
          <div className="subagent-live-head">
            <span className="working-star" aria-hidden="true">⤷</span>
            <span className="subagent-live-title" title={run.description}>Subagent{run.description.length > 0 ? `: ${run.description}` : ''}</span>
            <button type="button" className="background-task-output" onClick={() => onView(run.toolUseId)}>View</button>
          </div>
          {run.steps.map((step, i) => <div className="subagent-live-step" key={`${i}:${step}`} title={step}>{step}</div>)}
        </div>
      ))}
    </div>
  )
}

export function WorkingLine({ startedAt, tokens, pending, lastActivity, status, waitingOnYou, activity = null }: {
  startedAt: number
  tokens: number
  /** This turn's tool calls still waiting for a result. */
  pending: PendingTool[]
  /** When Claude Code last sent anything. */
  lastActivity: number
  status: string | null
  waitingOnYou: boolean
  /** Something holding the turn up: an API retry, or a hook running. */
  activity?: string | null
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const label = waitingOnYou ? 'Waiting for your answer'
    : activity !== null ? activity
    : status === 'compacting' ? 'Compacting conversation'
    : pickVerb(startedAt)
  const details = workingDetails({ now, startedAt, tokens, pending, lastActivity, quiet: waitingOnYou || status !== null || activity !== null })
  return (
    <div className="working-line" role="status">
      <span className="working-star" aria-hidden="true">✻</span> {label}… <span className="working-details">({details.join(' · ')})</span>
    </div>
  )
}
