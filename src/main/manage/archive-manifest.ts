import { dotnetJson, dotnetUtc, parseDotnetDate } from './archive-zip'

/** manifest.json of a ClaudeMemoryTool / Delegatto export (port of the C#
 *  ArchiveManifest records). In the zip the property names are PascalCase and
 *  the kind is a string ("Projects" / "Notes"), exactly as System.Text.Json
 *  writes the C# records with JsonStringEnumConverter and default naming. */

export const ARCHIVE_FORMAT = 'claude-memory-tool-export'
export const ARCHIVE_VERSION = 1
export const MANIFEST_ENTRY = 'manifest.json'

export type ArchiveKind = 'Projects' | 'Notes'

/** A .claude.json githubRepoPaths reference: `path` is the string exactly as stored. */
export type ArchivedRepoPath = { repo: string; path: string }

export type ArchivedProject = {
  workingDir: string
  /** Zip folder holding this project's files (claude/, temp/, workdir/, claude-json-entry.json, history.jsonl). */
  folder: string
  /** The projects[...] key exactly as stored, or null when the project had no entry. */
  claudeJsonKey: string | null
  githubRepoPaths: ArchivedRepoPath[]
  historyLines: number
  files: number
  bytes: number
  /** The projects\<encoded> folder name; with it a project whose working dir is unknown restores too. */
  encodedName: string | null
}

export type ArchivedNote = { path: string; workingDir: string; relativePath: string; entry: string; modifiedUtc: Date }

export type ArchiveManifest = {
  format: string
  version: number
  kind: ArchiveKind
  createdUtc: Date
  machine: string
  projects: ArchivedProject[]
  notes: ArchivedNote[]
}

/** Not an export made by either tool, or a manifest that can't be read
 *  (the C# InvalidDataException). */
export class InvalidArchiveError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidArchiveError' }
}

// ------------------------------------------------------------------ write

export function serializeManifest(m: ArchiveManifest): string {
  // Property order = the C# record parameter order (System.Text.Json writes them in that order).
  return dotnetJson({
    Format: m.format,
    Version: m.version,
    Kind: m.kind,
    CreatedUtc: dotnetUtc(m.createdUtc),
    Machine: m.machine,
    Projects: m.projects.map(p => ({
      WorkingDir: p.workingDir,
      Folder: p.folder,
      ClaudeJsonKey: p.claudeJsonKey,
      GithubRepoPaths: p.githubRepoPaths.map(r => ({ Repo: r.repo, Path: r.path })),
      HistoryLines: p.historyLines,
      Files: p.files,
      Bytes: p.bytes,
      EncodedName: p.encodedName
    })),
    Notes: m.notes.map(n => ({
      Path: n.path,
      WorkingDir: n.workingDir,
      RelativePath: n.relativePath,
      Entry: n.entry,
      ModifiedUtc: dotnetUtc(n.modifiedUtc)
    }))
  })
}

// ------------------------------------------------------------------ read

type Obj = Record<string, unknown>

/** A type mismatch System.Text.Json would reject with a JsonException. */
class Mismatch extends Error {}

/** 0001-01-01T00:00:00Z, DateTime.MinValue: what a missing date deserializes to. */
const MIN_DATE = new Date(Date.parse('0001-01-01T00:00:00.000Z'))

function own(o: Obj, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined
}

/** string?: missing/null -> null; anything else but a string is a mismatch. */
function str(o: Obj, k: string): string | null {
  const v = own(o, k)
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new Mismatch(`${k} is not a string`)
  return v
}

/** int / long: missing -> 0; null or a non-integer is a mismatch. */
function int(o: Obj, k: string): number {
  const v = own(o, k)
  if (v === undefined) return 0
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Mismatch(`${k} is not an integer`)
  return v
}

function date(o: Obj, k: string): Date {
  const v = own(o, k)
  if (v === undefined) return new Date(MIN_DATE)
  const d = typeof v === 'string' ? parseDotnetDate(v) : null
  if (d === null) throw new Mismatch(`${k} is not a date`)
  return d
}

function kind(o: Obj): ArchiveKind {
  const v = own(o, 'Kind')
  if (v === undefined || v === 0) return 'Projects'
  if (v === 1) return 'Notes'
  if (typeof v === 'string') {
    if (v.toLowerCase() === 'projects') return 'Projects'
    if (v.toLowerCase() === 'notes') return 'Notes'
  }
  throw new Mismatch('Kind is not Projects or Notes')
}

/** List<T>: missing/null -> []; each element an object or null (null kept, dropped later). */
function list(o: Obj, k: string): Array<Obj | null> {
  const v = own(o, k)
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Mismatch(`${k} is not a list`)
  return v.map(e => {
    if (e === null) return null
    if (typeof e !== 'object' || Array.isArray(e)) throw new Mismatch(`${k} holds a non-object`)
    return e as Obj
  })
}

/** Parses manifest.json text; port of the C# ReadManifest validation. A damaged or
 *  hand-edited manifest must not crash the import part-way: incomplete project,
 *  repo-link and note entries are dropped here. */
export function parseManifest(text: string): ArchiveManifest {
  let m: ArchiveManifest
  let rawProjects: Array<Obj | null>
  let rawNotes: Array<Obj | null>
  try {
    const root = JSON.parse(text.replace(/^﻿/, '')) as unknown
    if (root === null) throw new InvalidArchiveError('Not a Claude Memory Tool export.')
    if (typeof root !== 'object' || Array.isArray(root)) throw new Mismatch('not an object')
    const o = root as Obj
    rawProjects = list(o, 'Projects')
    rawNotes = list(o, 'Notes')
    m = {
      format: str(o, 'Format') ?? '',
      version: int(o, 'Version'),
      kind: kind(o),
      createdUtc: date(o, 'CreatedUtc'),
      machine: str(o, 'Machine') ?? '',
      projects: [],
      notes: []
    }
    if (m.format === ARCHIVE_FORMAT) {
      for (const p of rawProjects) {
        if (p === null) continue
        const workingDir = str(p, 'WorkingDir')
        const folder = str(p, 'Folder')
        const repos: ArchivedRepoPath[] = []
        for (const r of list(p, 'GithubRepoPaths')) {
          if (r === null) continue
          const repo = str(r, 'Repo')
          const path = str(r, 'Path')
          if (repo !== null && path !== null) repos.push({ repo, path })
        }
        const entry: ArchivedProject = {
          workingDir: workingDir ?? '', folder: folder ?? '', claudeJsonKey: str(p, 'ClaudeJsonKey'),
          githubRepoPaths: repos, historyLines: int(p, 'HistoryLines'), files: int(p, 'Files'),
          bytes: int(p, 'Bytes'), encodedName: str(p, 'EncodedName')
        }
        if (workingDir !== null && folder !== null) m.projects.push(entry)
      }
      for (const n of rawNotes) {
        if (n === null) continue
        const path = str(n, 'Path')
        const workingDir = str(n, 'WorkingDir')
        const relativePath = str(n, 'RelativePath')
        const entry = str(n, 'Entry')
        const modifiedUtc = date(n, 'ModifiedUtc')
        if (path !== null && workingDir !== null && relativePath !== null && entry !== null) {
          m.notes.push({ path, workingDir, relativePath, entry, modifiedUtc })
        }
      }
    }
  } catch (e) {
    if (e instanceof InvalidArchiveError) throw e
    throw new InvalidArchiveError("The export's manifest.json could not be read: " + (e as Error).message)
  }
  if (m.format !== ARCHIVE_FORMAT) throw new InvalidArchiveError('Not a Claude Memory Tool export.')
  if (m.version > ARCHIVE_VERSION) throw new InvalidArchiveError(`This export was made by a newer version (format ${m.version}).`)
  return m
}
