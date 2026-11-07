import { describe, it, expect } from 'vitest'
import { resolveActivePath } from '../src/main/jsonl/tree'

const n = (uuid: string, parentUuid: string | null, seq: number) => ({ uuid, parentUuid, seq })

describe('resolveActivePath', () => {
  it('returns a linear chain in order', () => {
    const { path } = resolveActivePath([n('a', null, 0), n('b', 'a', 1), n('c', 'b', 2)])
    expect(path).toEqual(['a', 'b', 'c'])
  })

  it('follows the newest branch and excludes the abandoned one', () => {
    // 'b1' was rewound; 'b2' replaced it under the same parent.
    const { path } = resolveActivePath([n('a', null, 0), n('b1', 'a', 1), n('b2', 'a', 2), n('c', 'b2', 3)])
    expect(path).toEqual(['a', 'b2', 'c'])
    expect(path).not.toContain('b1')
  })

  it('reports every branch point with all its siblings', () => {
    const { branchPoints } = resolveActivePath([n('a', null, 0), n('b1', 'a', 1), n('b2', 'a', 2)])
    expect(branchPoints['a']).toEqual(['b1', 'b2'])
  })

  it('omits parents that have only one child', () => {
    const { branchPoints } = resolveActivePath([n('a', null, 0), n('b', 'a', 1)])
    expect(branchPoints['a']).toBeUndefined()
  })

  it('handles an empty set and a dangling parent without looping forever', () => {
    expect(resolveActivePath([]).path).toEqual([])
    expect(resolveActivePath([n('orphan', 'missing', 0)]).path).toEqual(['orphan'])
  })

  it('does not hang on a cyclic parent reference', () => {
    const { path } = resolveActivePath([n('a', 'b', 0), n('b', 'a', 1)])
    expect(path.length).toBeLessThanOrEqual(2)
  })

  it('reports a branch point mid-conversation, not just at the root', () => {
    // a -> b -> c1 (abandoned) / c2 (live) -> d
    const { path, branchPoints } = resolveActivePath([
      n('a', null, 0),
      n('b', 'a', 1),
      n('c1', 'b', 2),
      n('c2', 'b', 3),
      n('d', 'c2', 4),
    ])
    expect(path).toEqual(['a', 'b', 'c2', 'd'])
    expect(path).not.toContain('c1')
    expect(branchPoints['b']).toEqual(['c1', 'c2'])
    expect(branchPoints['a']).toBeUndefined()
  })

  it('resolves the same leaf regardless of input order when seq ties', () => {
    // b1 and b2 share seq=1 under the same parent; only uuid order distinguishes them.
    const order1 = [n('a', null, 0), n('b1', 'a', 1), n('b2', 'a', 1)]
    const order2 = [n('a', null, 0), n('b2', 'a', 1), n('b1', 'a', 1)]
    const result1 = resolveActivePath(order1)
    const result2 = resolveActivePath(order2)
    expect(result1.path).toEqual(['a', 'b2'])
    expect(result2.path).toEqual(['a', 'b2'])
    expect(result1.path).toEqual(result2.path)
  })

  it('orders tied siblings in branchPoints consistently, agreeing with the chosen leaf', () => {
    // Same seq tie as above, presented in both array orders. branchPoints['a'] must
    // list the siblings identically both times, and the live leaf (last of `path`)
    // must be the sibling that sorts last in branchPoints['a'].
    const order1 = [n('a', null, 0), n('b1', 'a', 1), n('b2', 'a', 1)]
    const order2 = [n('a', null, 0), n('b2', 'a', 1), n('b1', 'a', 1)]
    const result1 = resolveActivePath(order1)
    const result2 = resolveActivePath(order2)

    expect(result1.branchPoints['a']).toEqual(result2.branchPoints['a'])

    const leaf1 = result1.path[result1.path.length - 1]
    const leaf2 = result2.path[result2.path.length - 1]
    const siblings1 = result1.branchPoints['a']!
    const siblings2 = result2.branchPoints['a']!
    expect(siblings1[siblings1.length - 1]).toBe(leaf1)
    expect(siblings2[siblings2.length - 1]).toBe(leaf2)
  })
})
