import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteText } from '../manage/safe-file'
import { backupUserFile, excludeLocalSettingsFromGit, readJsonFile, settingsPath, type SettingsLocations } from './files'
import type { HookScope } from '../../shared/command-panels-types'
import type { ClaudeSettingsTarget } from '../../shared/claude-settings-types'

/** Adds and removes hooks in Claude Code's settings files, as its /hooks screen does.
 *  The file's layout: `hooks: { Event: [{ matcher, hooks: [{ type, command }] }] }`.
 *  Everything else in the file is kept as it was. */

type Group = { matcher?: unknown; hooks?: unknown }

function targetOf(scope: HookScope, cwd: string | null): ClaudeSettingsTarget {
  if (scope === 'user') return { scope: 'user' }
  if (cwd === null) throw new Error('This chat’s folder is unknown, so its project settings can’t be changed.')
  return { scope, cwd }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function edit(loc: SettingsLocations, target: ClaudeSettingsTarget, change: (hooks: Record<string, unknown>) => void): void {
  const path = settingsPath(loc, target)
  const current = readJsonFile(path)
  if (current.error !== null) throw new Error(`${path} could not be read (${current.error}). Fix or remove it first.`)
  const data = current.data
  const hooks = typeof data.hooks === 'object' && data.hooks !== null && !Array.isArray(data.hooks) ? data.hooks as Record<string, unknown> : {}
  change(hooks)
  if (Object.keys(hooks).length === 0) delete data.hooks
  else data.hooks = hooks
  if (target.scope === 'user') backupUserFile(loc, path)
  mkdirSync(dirname(path), { recursive: true })
  atomicWriteText(path, JSON.stringify(data, null, 2) + '\n')
  if (target.scope === 'local' && !current.exists) excludeLocalSettingsFromGit(target.cwd)
}

export function addHook(loc: SettingsLocations, scope: HookScope, cwd: string | null, hook: { event: string; matcher: string | null; command: string; timeout?: number }): void {
  const event = hook.event.trim(), command = hook.command.trim(), matcher = (hook.matcher ?? '').trim()
  if (!/^[A-Za-z]+$/.test(event)) throw new Error('Pick an event for the hook.')
  if (command === '') throw new Error('Type the command the hook runs.')
  const config: Record<string, unknown> = { type: 'command', command }
  if (hook.timeout !== undefined && Number.isFinite(hook.timeout) && hook.timeout > 0) config.timeout = Math.round(hook.timeout)
  edit(loc, targetOf(scope, cwd), hooks => {
    const groups = Array.isArray(hooks[event]) ? hooks[event] as Group[] : []
    const group = groups.find(g => (typeof g.matcher === 'string' ? g.matcher : '') === matcher && Array.isArray(g.hooks))
    if (group !== undefined) {
      const list = group.hooks as unknown[]
      if (list.some(h => sameJson(h, config))) return
      list.push(config)
    } else groups.push(matcher === '' ? { hooks: [config] } : { matcher, hooks: [config] })
    hooks[event] = groups
  })
}

/** Removes the first hook that is exactly `config`, under `event` and `matcher`. A group it
 *  leaves empty goes too, and so does an event with no groups left. */
export function removeHook(loc: SettingsLocations, scope: HookScope, cwd: string | null, hook: { event: string; matcher: string | null; config: Record<string, unknown> }): boolean {
  let removed = false
  edit(loc, targetOf(scope, cwd), hooks => {
    const groups = Array.isArray(hooks[hook.event]) ? hooks[hook.event] as Group[] : null
    if (groups === null) return
    const matcher = hook.matcher ?? ''
    for (const group of groups) {
      if ((typeof group.matcher === 'string' ? group.matcher : '') !== matcher || !Array.isArray(group.hooks)) continue
      const i = (group.hooks as unknown[]).findIndex(h => sameJson(h, hook.config))
      if (i < 0) continue
      ;(group.hooks as unknown[]).splice(i, 1)
      removed = true
      break
    }
    const left = groups.filter(g => !Array.isArray(g.hooks) || g.hooks.length > 0)
    if (left.length === 0) delete hooks[hook.event]
    else hooks[hook.event] = left
  })
  return removed
}
