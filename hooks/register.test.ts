import { test, expect, mock } from 'claude-code/testing'

test('/vector-edit explains itself when no canvas is known', async ($, on) => {
  on('tool.call', { tool: 'Artifact' }, () => ({ deny: 'no network in tests' }))
  const { text } = await $.command.run({ command: 'vector-edit', args: '' })
  expect(text).toMatch(/canvas/)
})

test('/vector-edit with a url but an unreadable canvas reports the failure instead of hanging', async ($, on) => {
  mock.store(on)
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('tool.call', { tool: 'Artifact' }, () => ({ deny: 'no network in tests' }))
  const { text } = await $.command.run({ command: 'vector-edit', args: 'https://claude.ai/artifact/TESTID Shapes.dc.html' })
  expect(text).toMatch(/Could not (get|find)/)
})
