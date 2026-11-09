import type { ChannelRow } from '../shared/types'
import type { ChannelGroup } from '../shared/shell-types'
import { sameProjectDir } from '../shared/split-view'
import { groupChannels, resolveChannelName } from './lib'

export type PickerSection = { title: string; channels: ChannelRow[] }

/** The slot picker's project list: the nav's sections in the nav's order (starred first),
 *  narrowed to the projects whose name or folder holds `query`, without the projects in
 *  `exclude` (shown in another pane). Sections left with nothing are dropped. */
export function pickerSections(channels: ChannelRow[], groups: ChannelGroup[], query: string, exclude: string[], now: number = Date.now()): PickerSection[] {
  const q = query.trim().toLowerCase()
  const matches = (c: ChannelRow): boolean => {
    if (exclude.some(dir => sameProjectDir(dir, c.dirName))) return false
    if (q === '') return true
    const name = resolveChannelName(c.meta, c.cwd, c.dirName).toLowerCase()
    return name.includes(q) || (c.cwd ?? '').toLowerCase().includes(q)
  }
  return groupChannels(channels, groups, now)
    .map(s => ({ title: s.title, channels: s.channels.filter(matches) }))
    .filter(s => s.channels.length > 0)
}

/** What the picker says when its list is empty, given how many projects there are at all. */
export function pickerEmptyText(total: number, query: string): string {
  if (total === 0) return 'There are no projects yet.'
  return query.trim() === '' ? 'Every project is already in a pane.' : 'No projects match.'
}
