/** Compares two `x.y.z[-pre]` versions: >0 when a is newer, <0 when older, 0
 *  when equal. A prerelease sorts before its release (1.0.0-beta < 1.0.0).
 *  Missing parts count as 0; non-numeric junk compares as 0. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string | null } => {
    const [main = '', ...rest] = v.trim().replace(/^v/i, '').split('-')
    return { nums: main.split('.').map(n => Number.parseInt(n, 10) || 0), pre: rest.length > 0 ? rest.join('-') : null }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d
  }
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre < y.pre ? -1 : 1
}
