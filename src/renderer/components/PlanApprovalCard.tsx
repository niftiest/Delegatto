import { useState } from 'react'
import type { PermissionRequest } from '../../shared/engine-types'
import { planTextFromInput } from '../lib'

type Decision = 'allow' | 'allow_always' | 'deny'

/** Inline card for a plan-mode approval request (Plan 2 Task 9): the CLI
 *  surfaces "review this plan" as a `tool === 'ExitPlanMode'` permission
 *  request (see `isPlanApproval` in lib.ts), which Transcript routes here
 *  instead of to the ordinary PermissionCard. Simpler than PermissionCard on
 *  purpose -- no allow-always rule to persist, no editable JSON input, just
 *  the plan text and an accept/reject choice.
 *
 *  As in the terminal: approve and accept edits from here on, approve and keep asking,
 *  or keep planning, saying what to change. */
export function PlanApprovalCard({ req, onResolve }: {
  req: PermissionRequest
  onResolve: (id: string, decision: Decision, editedInput?: unknown, denyMessage?: string) => void
}) {
  const [resolved, setResolved] = useState<Decision | null>(null)
  const disabled = resolved !== null
  const planText = planTextFromInput(req.input)

  const [feedback, setFeedback] = useState('')
  function resolve(decision: Decision) {
    if (disabled) return // already answered -- one decision per request
    setResolved(decision)
    const said = feedback.trim()
    onResolve(req.id, decision, undefined, decision === 'deny' ? (said.length > 0 ? `Keep planning. ${said}` : 'Keep planning') : undefined)
  }

  return (
    <div className="perm-card plan-card">
      <div className="perm-head">
        <span className="perm-badge">📝 Plan ready for review</span>
      </div>
      <pre className="perm-input">{planText.slice(0, 8000)}</pre>
      <div className="question">
        <input type="text" className="question-other" placeholder="To keep planning: tell Claude what to change" aria-label="What to change in the plan"
          disabled={disabled} value={feedback} onChange={e => setFeedback(e.target.value)} />
      </div>
      <div className="perm-actions">
        <button type="button" className="btn-primary" disabled={disabled} onClick={() => resolve('allow_always')}>
          Approve and accept edits
        </button>
        <button type="button" className="btn-secondary" disabled={disabled} onClick={() => resolve('allow')}>
          Approve, keep asking
        </button>
        <button type="button" className="btn-secondary" disabled={disabled} onClick={() => resolve('deny')}>
          Keep planning
        </button>
      </div>
      {disabled && <div className="perm-resolved">{resolved === 'deny' ? 'Still planning' : 'Approved'}</div>}
    </div>
  )
}
