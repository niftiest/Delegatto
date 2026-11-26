// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { fake } from './fake-api'
import { channel, flush, renderSettled, session } from './render'
import { SplitLauncher } from '../../src/renderer/components/SplitLauncher'

describe("the main window's split view button", () => {
  it('pops the open chat out on its own, with nothing to pick', async () => {
    const project = channel(1, 'PlantPal')
    fake.override({ splitViewGet: () => Promise.resolve(null), splitViewOpen: () => Promise.resolve() })
    await renderSettled(<SplitLauncher session={session(11)} project={project} channels={[project]} settings={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Split view' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'One chat on its own' }))
    await flush()
    expect(fake.fn('splitViewOpen')).toHaveBeenCalledWith('single', [{ sessionPk: 11, projectDir: project.dirName }])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
