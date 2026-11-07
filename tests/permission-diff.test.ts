import { describe, it, expect } from 'vitest'
import { permissionDiff } from '../src/renderer/lib'

describe('permissionDiff', () => {
  it('keeps shared lines as context and shows the change between them', () => {
    const diff = permissionDiff('Edit', { file_path: 'D:\\a.ts', old_string: 'one\ntwo\nthree', new_string: 'one\nTWO\nthree' })
    expect(diff?.path).toBe('D:\\a.ts')
    expect(diff?.lines).toEqual([
      { kind: 'same', text: 'one' },
      { kind: 'removed', text: 'two' },
      { kind: 'added', text: 'TWO' },
      { kind: 'same', text: 'three' }
    ])
  })

  it("doesn't count a line twice when one side is a prefix of the other", () => {
    const diff = permissionDiff('Edit', { file_path: 'a', old_string: 'x\nx', new_string: 'x\nx\nx' })
    expect(diff?.lines.map(l => l.kind)).toEqual(['same', 'same', 'added'])
  })

  it('shows a whole Write as added', () => {
    const diff = permissionDiff('Write', { file_path: 'a', content: 'one\ntwo' })
    expect(diff?.lines).toEqual([{ kind: 'added', text: 'one' }, { kind: 'added', text: 'two' }])
  })

  it('caps a huge file and says how much is left out', () => {
    const diff = permissionDiff('Write', { file_path: 'a', content: Array(450).fill('x').join('\n') })
    expect(diff?.lines.length).toBe(400)
    expect(diff?.hiddenLines).toBe(50)
  })

  it('has nothing to show for other tools or unexpected input', () => {
    expect(permissionDiff('Bash', { command: 'ls' })).toBeNull()
    expect(permissionDiff('Edit', { file_path: 'a' })).toBeNull()
    expect(permissionDiff('Write', null)).toBeNull()
  })
})
