import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8')

describe('a reply while it streams', () => {
  it('keeps only a closing paragraph inline, so a list at the end keeps its indent and markers', () => {
    expect(css).toContain('.bubble-claude.streaming .md > p:last-child { display:inline; }')
    expect(css).not.toMatch(/\.bubble-claude\.streaming \.md > :last-child/)
  })
})
