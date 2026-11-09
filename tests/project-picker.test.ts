import { describe, it, expect } from 'vitest'
import type { ChannelRow } from '../src/shared/types'
import type { ChannelGroup, ChannelMeta } from '../src/shared/shell-types'
import { pickerEmptyText, pickerSections } from '../src/renderer/project-picker'

function row(id: number, cwd: string | null, meta: Partial<ChannelMeta> = {}, extra: Partial<ChannelRow> = {}): ChannelRow {
  const dirName = `C--${id}`
  return {
    id, dirName, cwd, sessionCount: 1, lastActivity: null, preview: null,
    meta: { dirName, friendlyName: null, starred: false, groupId: null, icon: { kind: 'initials' }, hidden: false, ...meta },
    ...extra
  }
}

const NOW = Date.parse('2026-11-08T12:00:00Z')
const groups: ChannelGroup[] = [{ id: 7, name: 'Work', sortOrder: 0, icon: { kind: 'initials' } }]
const plant = row(1, 'D:\\GIT\\PlantPal', {}, { lastActivity: '2026-11-08T11:00:00Z' })
const ledger = row(2, 'D:\\GIT\\LedgerLite', { starred: true })
const site = row(3, 'D:\\GIT\\Site', { friendlyName: 'Company website', groupId: 7 })
const all = [plant, ledger, site]

describe('the slot picker project list', () => {
  it('follows the nav: starred first, then groups, then by recency', () => {
    const sections = pickerSections(all, groups, '', [], NOW)
    expect(sections.map(s => s.title)).toEqual(['Starred', 'Work', 'Today'])
    expect(sections.flatMap(s => s.channels.map(c => c.id))).toEqual([2, 3, 1])
  })
  it('searches the shown name and the folder, ignoring case', () => {
    expect(pickerSections(all, groups, 'WEBSITE', [], NOW).flatMap(s => s.channels.map(c => c.id))).toEqual([3])
    expect(pickerSections(all, groups, 'git\\plant', [], NOW).flatMap(s => s.channels.map(c => c.id))).toEqual([1])
  })
  it('leaves out projects other panes show, and sections left empty', () => {
    const sections = pickerSections(all, groups, '', ['c--2', 'C--3'], NOW)
    expect(sections.map(s => s.title)).toEqual(['Today'])
    expect(sections[0]!.channels.map(c => c.id)).toEqual([1])
  })
})

describe('the slot picker with nothing to list', () => {
  it('says there are no projects when there are none', () => {
    expect(pickerEmptyText(0, '')).toBe('There are no projects yet.')
    expect(pickerEmptyText(0, 'plant')).toBe('There are no projects yet.')
  })
  it('says every project is in a pane, or that the search found none', () => {
    expect(pickerEmptyText(3, '')).toBe('Every project is already in a pane.')
    expect(pickerEmptyText(3, '  ')).toBe('Every project is already in a pane.')
    expect(pickerEmptyText(3, 'zzz')).toBe('No projects match.')
  })
})
