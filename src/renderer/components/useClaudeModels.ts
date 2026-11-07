import { useEffect, useState } from 'react'
import { api } from '../api'
import { sortModels } from '../../shared/models'
import type { ClaudeModel } from '../../shared/claude-info-types'

let request: Promise<ClaudeModel[]> | null = null
let loaded: ClaudeModel[] = []

/** Claude Code's own model list: the only models the app offers. Asked when the app loads, from
 *  the home folder, because the list doesn't depend on the project and asking starts a brief
 *  process. If Claude can't answer the list stays empty, and the next window that needs it asks again. */
export function loadClaudeModels(): Promise<ClaudeModel[]> {
  request ??= api.claudeInfo(null).then(r => {
    if (r.ok && r.info.models.length > 0) {
      loaded = sortModels(r.info.models)
      return loaded
    }
    request = null
    return []
  }).catch(() => { request = null; return [] })
  return request
}

export function useClaudeModels(): ClaudeModel[] {
  const [models, setModels] = useState(loaded)
  useEffect(() => {
    let alive = true
    void loadClaudeModels().then(m => { if (alive) setModels(m) })
    return () => { alive = false }
  }, [])
  return models
}

/** The list's own value for a stored model, which may be a resolved id such as
 *  "claude-opus-5-5" where the list says "opus". */
export function modelOption(models: ClaudeModel[], stored: string): string {
  return models.find(m => m.value === stored || m.resolved === stored)?.value ?? stored
}
