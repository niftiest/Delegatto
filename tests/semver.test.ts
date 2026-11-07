import { describe, it, expect } from 'vitest'
import { compareVersions } from '../src/shared/semver'

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '0.9.9', 1], ['0.1.1', '0.1.0', 1], ['0.10.0', '0.9.0', 1], ['1.0.0', '1.0.0', 0],
    ['v1.2.0', '1.2.0', 0], ['1.0', '1.0.0', 0], ['1.0.0-beta.1', '1.0.0', -1], ['1.0.0', '1.0.0-beta.1', 1],
    ['1.0.0-beta.2', '1.0.0-beta.1', 1], ['0.1.0', '0.2.0', -1]
  ])('%s vs %s', (a, b, sign) => expect(Math.sign(compareVersions(a, b))).toBe(sign))
})
