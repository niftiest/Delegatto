import { defineConfig } from 'vitest/config'

// Tests run in node. A component test opts into a DOM with a `// @vitest-environment happy-dom`
// docblock; tests/dom/setup.ts then gives it the fake preload bridge.
export default defineConfig({
  test: { globals: true, environment: 'node', include: ['tests/**/*.test.{ts,tsx}'], setupFiles: ['tests/dom/setup.ts'] }
})
