import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'orchestra',
  props: { title: 'Orchestra', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} },
  viewport: { columns: 220, rows: 60 },
} as const

const keysOf = async (ui: { findAll: (q: { type: string }) => Promise<{ key?: unknown }[]> }, prefix: string) =>
  (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith(prefix))

test('tasks pick their model, new tasks can be added, accounts show sign-in', async ($, on) => {
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  // Every CLI is installed but none reports a signed-in account.
  on('process.run', (_$, e) => ({ value: { exitCode: JSON.stringify(e).includes('oauth_creds') ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...PANE })

  // Every task row has its own model picker; the pipeline row shows its chain instead.
  expect(await ui.find({ key: 'who:plan' })).toBeDefined()
  expect(await ui.find({ key: 'who:review-pr' })).toBeDefined()
  expect(await ui.find({ key: 'who:pipeline' })).toBeUndefined()

  // Accounts: every provider reads signed out and offers sign in.
  await ui.press({ key: 'refresh-accounts' })
  expect(await keysOf(ui, 'signin:')).toEqual(['signin:claude', 'signin:codex', 'signin:cursor', 'signin:gemini'])

  // Changing a task's model is the routing.
  await ui.select({ key: 'who:plan', value: 'opus:read' })
  expect((await ui.find({ key: 'who:plan' }))?.props).toMatchObject({ value: 'opus:read' })

  // Add a task with the model picked beside it.
  await ui.select({ key: 'new-task-model', value: 'composer:write' })
  await ui.input({ key: 'new-task', text: 'Write tests' })
  const added = (await keysOf(ui, 'task:')).filter(k => !['task:pipeline', 'task:plan'].includes(k)).pop()
  expect(await keysOf(ui, 'del:')).toHaveLength(1)
  expect((await ui.findAll({ type: 'Select' })).some(s => s.key !== undefined && String(s.key).startsWith('who:') && (s.props as { value?: string }).value === 'composer:write')).toBe(true)
  expect(added).toBeDefined()

  // Run the plan task: it goes to the model picked for it.
  await ui.press({ key: 'task:plan' })
  await ui.input({ key: 'input', text: 'add rate limiting' })
  const rows = await keysOf(ui, 'job:')
  expect(rows).toHaveLength(1)
  await ui.press({ key: rows[0]! })
  expect(await ui.find({ key: 'next' })).toBeDefined()
  expect(await ui.find({ key: 'reply' })).toBeDefined()
  await ui.press({ key: 'back' })

  await ui.press({ key: 'settings' })
  for (const k of ['guard', 'pipelines', 'template', 'restore-presets']) expect(await ui.find({ key: k })).toBeDefined()
  await ui.unmount()
})

test('draws on desktop too', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'desktop', ...PANE })
  await ui.press({ key: 'task:pipeline' })
  await ui.press({ key: 'settings' })
  expect(await ui.drawn()).toMatchObject({ type: 'Box' })
  await ui.unmount()
})

test('a missing CLI drops its models from the pickers', async ($, on) => {
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => ({ value: { exitCode: JSON.stringify(e).includes('cursor-agent') ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...PANE })
  await ui.press({ key: 'refresh-accounts' })
  expect(await ui.find({ key: 'signin:cursor' })).toBeUndefined()
  expect(await ui.find({ key: 'signin:codex' })).toBeDefined()
  const options = ((await ui.find({ key: 'new-task-model' }))?.props as { options: { value: string }[] }).options.map(o => o.value)
  expect(options.some(v => v.startsWith('composer'))).toBe(false)
  expect(options).toContain('astra:read')
  await ui.unmount()
})

test('read-only work stays read-only, and prompts never become flags', async ($, on) => {
  const spawned: string[][] = []
  const stdin: (string | undefined)[] = []
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('process.spawn', async function* (_$: unknown, e: { argv: readonly string[]; input?: string }) {
    spawned.push([...e.argv])
    stdin.push(e.input)
    yield* []
    return { code: 0, signal: null }
  } as never)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', ...PANE })
  await ui.press({ key: 'refresh-accounts' })

  // Gemini read-only uses plan mode and fuses the prompt into one token.
  await ui.press({ key: 'task:investigate' })
  await ui.input({ key: 'input', text: '--help' })
  const gemini = spawned.find(a => a.includes('gemini'))!
  expect(gemini).toContain('plan')
  expect(gemini).not.toContain('--yolo')
  expect(gemini).not.toContain('--help')

  // Codex gets its prompt on stdin, read-only sandbox for a read-only row.
  await ui.press({ key: 'task:review-pr' })
  await ui.input({ key: 'input', text: '--help' })
  const codex = spawned.find(a => a.includes('codex'))!
  expect(codex).toContain('read-only')
  expect(codex).not.toContain('--help')
  expect(stdin).toContain('Review PR --help (use gh pr view and gh pr diff). Report correctness bugs ranked most severe first with file:line and a failure scenario. Mark what you could not confirm. Do not post anything to GitHub.')

  // Replacement tokens in task text stay literal.
  await ui.press({ key: 'task:explain' })
  await ui.select({ key: 'who:explain', value: 'gemini:read' })
  await ui.input({ key: 'input', text: "explain $& and $' syntax" })
  expect(spawned.some(a => a.some(x => x.includes("explain $& and $' syntax")))).toBe(true)
  await ui.unmount()
})
