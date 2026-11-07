export type TreeNode = { uuid: string; parentUuid: string | null; seq: number }
export type ActivePath = { path: string[]; branchPoints: Record<string, string[]> }

// Single tie-break rule shared by leaf selection and branchPoints ordering:
// order by seq ascending, then by uuid ascending. This keeps the result
// independent of the order nodes happen to appear in the input array, and
// keeps the two derived views (path's leaf, branchPoints' last sibling)
// pointing at the same node when a seq tie occurs.
function compareBySeqThenUuid(a: TreeNode, b: TreeNode): number {
  return a.seq - b.seq || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0)
}

export function resolveActivePath(nodes: TreeNode[]): ActivePath {
  if (nodes.length === 0) return { path: [], branchPoints: {} }

  const byUuid = new Map<string, TreeNode>()
  const childrenOf = new Map<string, TreeNode[]>()
  for (const node of nodes) {
    byUuid.set(node.uuid, node)
    if (node.parentUuid !== null) {
      const bucket = childrenOf.get(node.parentUuid)
      if (bucket === undefined) childrenOf.set(node.parentUuid, [node])
      else bucket.push(node)
    }
  }

  const branchPoints: Record<string, string[]> = {}
  for (const [parent, children] of childrenOf) {
    if (children.length > 1) {
      branchPoints[parent] = [...children].sort(compareBySeqThenUuid).map(c => c.uuid)
    }
  }

  // Highest (seq, then uuid) wins, so the live leaf is always the node that
  // sorts last among its tied siblings in branchPoints above.
  let leaf = nodes[0]!
  for (const node of nodes) {
    if (compareBySeqThenUuid(node, leaf) > 0) leaf = node
  }

  const reversed: string[] = []
  const visited = new Set<string>()
  let cursor: TreeNode | undefined = leaf
  while (cursor !== undefined && !visited.has(cursor.uuid)) {
    visited.add(cursor.uuid)
    reversed.push(cursor.uuid)
    cursor = cursor.parentUuid === null ? undefined : byUuid.get(cursor.parentUuid)
  }

  return { path: reversed.reverse(), branchPoints }
}
