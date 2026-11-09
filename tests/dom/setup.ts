// Runs before every test file. Only a file that opts into a DOM, with a
// `// @vitest-environment happy-dom` docblock, gets anything from it: the fake preload
// bridge on window.delegatto (which src/renderer/api.ts reads as it loads), and a fresh
// fake after each test. A node test file has no window and skips it all.
if (typeof window !== 'undefined') {
  const { fake } = await import('./fake-api')
  const { cleanup } = await import('@testing-library/react')
  Object.defineProperty(window, 'delegatto', { value: fake.api, configurable: true })
  afterEach(() => {
    cleanup()
    fake.reset()
  })
}

export {}
