import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteText } from './manage/safe-file'
import type { MemoryFile, MemoryFileContent } from '../shared/project-memory-types'

/** The files that shape what Claude remembers for a project. Only paths built here
 *  can be read or written: a request names a file by id, and that id has to turn up
 *  in a fresh listing, so nothing else on disk can be reached this way. */

const MAX_BYTES = 2 * 1024 * 1024

type Listed = MemoryFile & { path: string }

function mtimeOf(path: string): number | null {
  try { return statSync(path).mtimeMs } catch { return null }
}

export function listMemoryFiles(cwd: string | null, projectDir: string): Listed[] {
  const out: Listed[] = []
  const add = (id: string, path: string, label: string, note: string, offerIfMissing: boolean): void => {
    const mtime = mtimeOf(path)
    if (mtime !== null || offerIfMissing) out.push({ id, path, label, note, exists: mtime !== null })
  }
  if (cwd !== null && cwd.length > 0) {
    add('project', join(cwd, 'CLAUDE.md'), 'CLAUDE.md', 'Instructions for this project. Usually committed, so it’s shared with the repo.', true)
    add('project-dir', join(cwd, '.claude', 'CLAUDE.md'), '.claude/CLAUDE.md', 'Instructions for this project, kept inside .claude.', false)
    add('local', join(cwd, 'CLAUDE.local.md'), 'CLAUDE.local.md', 'Your private instructions for this project, not meant to be committed.', true)
  }
  const memoryDir = join(projectDir, 'memory')
  let names: string[] = []
  try { names = readdirSync(memoryDir).filter(n => /\.md$/i.test(n)) } catch { /* no memories yet */ }
  names.sort((a, b) => Number(b === 'MEMORY.md') - Number(a === 'MEMORY.md') || a.localeCompare(b))
  for (const name of names) {
    add(`memory:${name}`, join(memoryDir, name), name, name === 'MEMORY.md'
      ? 'Claude’s auto memory: the index it reads at the start of each chat.'
      : 'One of the notes Claude saved for itself in auto memory.', false)
  }
  return out
}

function find(cwd: string | null, projectDir: string, id: string): Listed {
  const file = listMemoryFiles(cwd, projectDir).find(f => f.id === id)
  if (file === undefined) throw new Error('That file is no longer available.')
  return file
}

export function readMemoryFile(cwd: string | null, projectDir: string, id: string): MemoryFileContent {
  const file = find(cwd, projectDir, id)
  if (!file.exists) return { text: '', mtimeMs: null }
  if (statSync(file.path).size > MAX_BYTES) throw new Error('That file is too large to edit here.')
  return { text: readFileSync(file.path, 'utf8'), mtimeMs: mtimeOf(file.path) }
}

/** Refuses if the file changed since it was read: Claude writes to these too, and
 *  saving over that would lose it. */
export function writeMemoryFile(cwd: string | null, projectDir: string, id: string, text: string, expectedMtimeMs: number | null): MemoryFileContent {
  const file = find(cwd, projectDir, id)
  if (mtimeOf(file.path) !== expectedMtimeMs) throw new Error('This file changed on disk while you were editing. Copy your text, reopen the file, and try again.')
  atomicWriteText(file.path, text)
  return { text, mtimeMs: mtimeOf(file.path) }
}
