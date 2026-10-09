import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Access, Account, Draft, Job, ModelId, Pipeline, Preset, Provider, Stage, Ui } from '../types'

const PANE = 'orchestra'
const KEYS = { presets: 'presets', jobs: 'jobs', guard: 'guard', autoAdvance: 'autoAdvance' }

const STAGES: { value: Stage; label: string }[] = [
  { value: 'plan', label: 'Plan' },
  { value: 'critique', label: 'Plan critique' },
  { value: 'implement', label: 'Implement' },
  { value: 'mechanical', label: 'Mechanical bulk' },
  { value: 'review', label: 'Review' },
  { value: 'verify', label: 'Verify' },
  { value: 'research', label: 'Bulk read / research' },
]

const MODELS: { value: ModelId; label: string; via: string }[] = [
  { value: 'fable', label: 'Fable 5.1', via: 'Claude subagent' },
  { value: 'opus', label: 'Opus 5.5', via: 'Claude subagent' },
  { value: 'astra', label: 'GPT-6 Astra', via: 'codex exec' },
  { value: 'composer', label: 'Composer 2.5', via: 'cursor-agent' },
  { value: 'gemini', label: 'Gemini', via: 'gemini -y' },
]

// Settings from the plugin's userConfig; filled in by register().
const CFG = {
  fableModel: 'claude-fable-5-1',
  opusModel: 'claude-opus-5-5',
  codexModel: 'gpt-6-astra',
  cursorModel: 'composer-2.5',
  guard: false,
  shareRouting: true,
}

const CLAUDE_IDS: Partial<Record<ModelId, string>> = {
  fable: CFG.fableModel,
  opus: CFG.opusModel,
}

// Mirrors the routing table in ~/.claude/CLAUDE.md.
const DEFAULT_ROUTING: Record<Stage, ModelId> = {
  plan: 'fable',
  critique: 'astra',
  implement: 'opus',
  mechanical: 'composer',
  review: 'astra',
  verify: 'astra',
  research: 'gemini',
}

const BRIEF_OUT =
  'When a step does not need my input, keep going. Stop and ask only if something fails for a reason you cannot explain, or before anything destructive.'

const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'pipeline',
    title: 'Full pipeline: plan, critique, implement, review',
    stage: 'plan',
    access: 'read',
    template: '{input}',
    then: ['critique', 'implement', 'review'],
  },
  {
    id: 'plan',
    title: 'Plan a change (with reproduction test)',
    stage: 'plan',
    access: 'read',
    template:
      'Plan this change before any code is written. Read the relevant code first. Return: the approach, the files to touch, risks, and the failing reproduction test that defines done (as runnable code plus the command to run it).\n\nChange: {input}',
  },
  {
    id: 'critique',
    title: 'Red-team a plan or design',
    stage: 'critique',
    access: 'read',
    template:
      'Adversarially critique this plan. List what will break, what is missing, wrong assumptions, and simpler alternatives, ranked by severity. Mark anything you could not confirm from the code.\n\n{input}',
  },
  {
    id: 'implement',
    title: 'Implement with a done-criterion',
    stage: 'implement',
    access: 'write',
    template: `Implement this: {input}\n\nDone means the reproduction test (or the test command named above) passes and nothing else regresses. Run it before you report. ${BRIEF_OUT}\n\nUse sub-agents where they help.`,
  },
  {
    id: 'mechanical',
    title: 'Mechanical bulk edit',
    stage: 'mechanical',
    access: 'write',
    template: `Make this mechanical change across the codebase: {input}\n\nKeep the diff minimal and consistent with surrounding code. Run the typecheck and tests when done. ${BRIEF_OUT}`,
  },
  {
    id: 'review-diff',
    title: 'Review uncommitted changes',
    stage: 'review',
    access: 'read',
    template:
      'Review the uncommitted changes in this repo (git diff and git diff --staged). Report correctness bugs ranked most severe first, each with file:line and a concrete failure scenario. Mark what you could not confirm. Extra context: {input}',
  },
  {
    id: 'review-pr',
    title: 'Review a PR',
    stage: 'review',
    access: 'read',
    template:
      'Review PR {input} (use gh pr view and gh pr diff). Report correctness bugs ranked most severe first with file:line and a failure scenario. Mark what you could not confirm. Do not post anything to GitHub.',
  },
  {
    id: 'merge-gate',
    title: 'Merge-risk gate',
    stage: 'review',
    access: 'read',
    template:
      'For {input}: what are the risks of merging this today, and what is the worst thing that happens if we merge it right now? Be concrete and mark what you could not confirm.',
  },
  {
    id: 'verify',
    title: 'Verify a flow in the browser',
    stage: 'verify',
    access: 'write',
    template:
      'Verify this works in the running app using your browser tools: {input}\n\nReport what you did, what you saw, and pass/fail per step with evidence. Do not change code.',
  },
  {
    id: 'investigate',
    title: 'Investigate (logs, big files, many dirs)',
    stage: 'research',
    access: 'read',
    template: 'Investigate and summarize, citing files and lines: {input}',
  },
  {
    id: 'explain',
    title: 'Explain code simply',
    stage: 'research',
    model: 'opus',
    access: 'read',
    template: 'Explain simply and briefly how this works, with the key files: {input}',
  },
].map(p => ({ model: DEFAULT_ROUTING[p.stage as Stage], ...p, isBuiltin: true }) as Preset)

// How a pipeline hands one stage's output to the next.
const HANDOFF: Record<Stage, (goal: string, prev: string) => string> = {
  plan: goal => `Plan this change. Return the approach, files, risks, and the failing reproduction test that defines done.\n\nChange: ${goal}`,
  critique: (goal, prev) =>
    `Adversarially critique this plan for: ${goal}\n\nList what breaks, what is missing, and simpler alternatives, ranked by severity. Then give a corrected final plan. Mark what you could not confirm.\n\nPLAN:\n${prev}`,
  implement: (goal, prev) =>
    `Implement: ${goal}\n\nFollow this plan (with its critique folded in). Done means its reproduction test passes. ${BRIEF_OUT}\n\nPLAN:\n${prev}`,
  mechanical: (goal, prev) => `Apply this mechanically: ${goal}\n\nCONTEXT:\n${prev}`,
  review: (goal, prev) =>
    `Review the uncommitted changes in this repo (git diff) made for: ${goal}\n\nReport bugs ranked by severity with file:line. Mark what you could not confirm.\n\nIMPLEMENTER REPORT:\n${prev}`,
  verify: (goal, prev) => `Verify in the running app that this works: ${goal}\n\nCONTEXT:\n${prev}`,
  research: (goal, prev) => `Investigate: ${goal}\n\nCONTEXT:\n${prev}`,
}


// Models the routing table says never to use for real work.
const BANNED = /haiku|sonnet|opus-4|claude-opus-5$/i

const HINTS: Record<string, string> = {
  pipeline: 'Each step feeds the next, using the models picked for Plan, Red-team, Implement and Review.',
  plan: 'Reads the code first; returns approach, files, risks and the failing repro test.',
  critique: 'Ranks what breaks, what is missing and simpler options.',
  implement: 'Runs until the named test passes. Say what done means.',
  mechanical: 'Minimal consistent diff across the codebase, then typecheck and tests.',
  'review-diff': 'Reviews git diff and staged changes; bugs first, with file:line.',
  'review-pr': 'gh pr view + diff; bugs ranked, nothing posted.',
  'merge-gate': 'What goes wrong if this merges today, and how badly.',
  verify: 'Drives the running app in a browser; pass/fail per step with evidence.',
  investigate: 'Reads big files, logs and many dirs; cites files and lines.',
  explain: 'Short plain explanation with the key files.',
}

const PLACEHOLDERS: Record<string, string> = {
  pipeline: 'Describe the goal',
  'review-pr': 'PR number or URL',
  critique: 'Paste the plan, or say where it is',
  'review-diff': 'Extra context (optional)',
}

// Tasks whose input may be left empty.
const OPTIONAL_INPUT = new Set(['review-diff'])

// Which task row decides the model for each pipeline / hand-off stage.
const STAGE_TASK: Record<Stage, string> = {
  plan: 'plan',
  critique: 'critique',
  implement: 'implement',
  mechanical: 'mechanical',
  review: 'review-diff',
  verify: 'verify',
  research: 'investigate',
}

const PROVIDERS: { id: Provider; name: string; models: string }[] = [
  { id: 'claude', name: 'Claude', models: 'Fable, Opus' },
  { id: 'codex', name: 'ChatGPT', models: 'Astra' },
  { id: 'cursor', name: 'Cursor', models: 'Composer' },
  { id: 'gemini', name: 'Gemini', models: 'Gemini' },
]
const PROVIDER_OF: Record<ModelId, Provider> = { fable: 'claude', opus: 'claude', astra: 'codex', composer: 'cursor', gemini: 'gemini' }

const draft = atom({ plugin: 'orchestra', key: 'draft' } as const, {
  presetId: 'plan',
  stage: 'plan',
  model: 'fable',
  access: 'read',
  input: '',
} as Draft)
const jobs = atom({ plugin: 'orchestra', key: 'jobs' } as const, [] as Job[])
const presets = atom({ plugin: 'orchestra', key: 'presets' } as const, BUILTIN_PRESETS)
const ui = atom({ plugin: 'orchestra', key: 'ui' } as const, { view: 'home', showSettings: false, showPrompt: false } as Ui)
const guard = atom({ plugin: 'orchestra', key: 'guard' } as const, true)
const autoAdvance = atom({ plugin: 'orchestra', key: 'autoAdvance' } as const, false)
const accounts = atom({ plugin: 'orchestra', key: 'accounts' } as const, {
  claude: { status: 'checking', detail: '' },
  codex: { status: 'checking', detail: '' },
  cursor: { status: 'checking', detail: '' },
  gemini: { status: 'checking', detail: '' },
} as Record<Provider, Account>)
const newTask = atom({ plugin: 'orchestra', key: 'newTask' } as const, { title: '', who: 'opus:write' })

// The registered read-only agent type, once session.start has defined it.
let readerAgent: string | undefined
// The session's directory: jobs belong to the repository they ran in.
let sessionCwd = ''
const jobsKey = () => `${KEYS.jobs}:${sessionCwd}`
// Jobs whose next pipeline step has been claimed, so two Continue presses launch it once.
const advancing = new Set<string>()

// Live child processes, so Stop can end them. A reload kills them anyway.
const children = new Map<string, () => void>()

const modelLabel = (model: ModelId) => MODELS.find(m => m.value === model)?.label ?? model
const stageLabel = (stage: Stage) => STAGES.find(s => s.value === stage)?.label ?? stage
const isClaude = (model: ModelId) => model in CLAUDE_IDS
const accessFor = (stage: Stage): Access => (stage === 'implement' || stage === 'mechanical' ? 'write' : 'read')
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const modelOf = (p: Preset) => p.model ?? DEFAULT_ROUTING[p.stage]

// The task table is the routing: a stage runs on the model its task row picks.
const routesOf = (ps: readonly Preset[]): Record<Stage, ModelId> => {
  const out = { ...DEFAULT_ROUTING }
  for (const s of STAGES) {
    const p = ps.find(x => x.id === STAGE_TASK[s.value])
    if (p) out[s.value] = modelOf(p)
  }
  return out
}

// A stage's model and access, both as its task row sets them.
const routeFor = (ps: readonly Preset[], stage: Stage): { model: ModelId; access: Access } => {
  const p = ps.find(x => x.id === STAGE_TASK[stage])
  return p ? { model: modelOf(p), access: p.access } : { model: DEFAULT_ROUTING[stage], access: accessFor(stage) }
}

// "Who" folds access into the model: `astra:write`, `fable`.
const WHO = MODELS.flatMap(m =>
  (['read', 'write'] as const).map(access => ({ value: `${m.value}:${access}`, model: m.value, access })),
)

const whoValue = (model: ModelId, access: Access) => `${model}:${access}`
const whoLabel = (model: ModelId, access: Access) => `${modelLabel(model)} · ${access === 'write' ? 'edits files' : 'read-only'}`

// The prompt never lands where a CLI could read it as a flag: stdin for Codex, after `--`
// for Cursor, and fused into `--prompt=` for Gemini.
function cliCommand(model: ModelId, access: Access, prompt: string): { argv: string[]; input?: string } {
  if (model === 'astra') {
    return { argv: ['codex', 'exec', '--skip-git-repo-check', '-s', access === 'write' ? 'workspace-write' : 'read-only', '-m', CFG.codexModel, '-'], input: prompt }
  }
  if (model === 'composer') {
    const mode = access === 'write' ? ['--force'] : ['--mode', 'ask']
    return { argv: ['cursor-agent', '-p', '--trust', ...mode, '--model', CFG.cursorModel, '--output-format', 'text', '--', prompt] }
  }

  return { argv: ['gemini', '--skip-trust', '--approval-mode', access === 'write' ? 'yolo' : 'plan', `--prompt=${prompt}`] }
}

// CLIs run with the PATH of the user's login shell, read once, so they resolve as in a terminal.
// The argv itself never passes through a shell.
let loginPath: Promise<string | undefined> | undefined
function readLoginPath($: EngineInterface) {
  loginPath ??= (async () => {
    const shell = (await $.process.run(['/bin/sh', '-c', 'printf %s "$SHELL"']).catch(() => ({ stdout: '' }))).stdout.trim()
    const name = shell.split('/').pop() ?? ''
    const script = name === 'fish' ? 'string join : $PATH' : ['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name) ? 'printf %s "$PATH"' : undefined
    if (!script) return undefined
    const { exitCode, stdout } = await $.process.run([shell, '-lc', script], { timeoutMs: 10000 }).catch(() => ({ exitCode: 1, stdout: '' }))
    return exitCode === 0 && stdout.trim() ? stdout.trim() : undefined
  })()
  return loginPath
}
const withPath = async ($: EngineInterface, argv: readonly string[]) => {
  const path = await readLoginPath($)
  return path ? ['/usr/bin/env', `PATH=${path}`, ...argv] : [...argv]
}

// Store writes are best effort: a failed save must never break a dispatch.
const persist = ($: EngineInterface, key: string, value: unknown) =>
  $.store.set(key, value as never).catch(err => $.ui.log(`orchestra: could not save ${key}: ${String(err)}`, { to: 'debug' }))

const saveJobs = async ($: EngineInterface) => {
  const list = await read($, jobs)
  await persist($, jobsKey(), list.slice(0, 40).map(j => ({ ...j, output: j.output.slice(-8000) })))
}

const savePresets = async ($: EngineInterface, fn: (l: Preset[]) => Preset[]) => {
  await update($, presets, fn)
  const after = await read($, presets)
  await persist($, KEYS.presets, after)
  if (routingNote(after) !== lastNote) await noteRouting($, after)
}

// The table reaches Claude as a note in the conversation: the system context is closed to user mods.
let lastNote = ''
async function noteRouting($: EngineInterface, ps: readonly Preset[]) {
  if (!CFG.shareRouting) return
  const text = routingNote(ps)
  lastNote = text
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(err =>
    $.ui.log(`orchestra: could not share the routing table: ${String(err)}`, { to: 'debug' }),
  )
}

const patchJob = ($: EngineInterface, id: string, fn: (job: Job) => Job) =>
  update($, jobs, list => list.map(job => (job.id === id ? fn(job) : job)))

const appendOutput = (output: string, text: string) => (output + text).slice(-60000)

const nextStageOf = (job: Job) => job.pipeline?.stages[(job.step ?? 0) + 1]
const isPaused = (job: Job) => job.status === 'done' && !!nextStageOf(job) && !job.isAdvanced

// ---------- Accounts ----------

const setAccount = ($: EngineInterface, id: Provider, account: Account) => update($, accounts, a => ({ ...a, [id]: account }))

const CLI_OF: Record<Provider, string> = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent', gemini: 'gemini' }

async function checkAccount($: EngineInterface, id: Provider): Promise<Account> {
  const found = await $.process.run(await withPath($, ['which', CLI_OF[id]]), { timeoutMs: 10000 }).catch(() => ({ exitCode: 1 }))
  if (found.exitCode !== 0) return { status: 'missing', detail: `${CLI_OF[id]} is not installed` }
  try {
    if (id === 'claude') {
      const { stdout } = await $.process.run(await withPath($, ['claude', 'auth', 'status', '--json']), { timeoutMs: 20000 })
      const s = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; orgName?: string }
      return s.loggedIn ? { status: 'in', detail: [s.email, s.orgName].filter(Boolean).join(' · ') } : { status: 'out', detail: 'not signed in' }
    }
    if (id === 'codex') {
      const { stdout, stderr } = await $.process.run(await withPath($, ['codex', 'login', 'status']), { timeoutMs: 20000 })
      const text = oneLine(`${stdout} ${stderr}`)
      return /logged in/i.test(text) && !/not logged in/i.test(text) ? { status: 'in', detail: text.replace(/^Logged in /i, '') } : { status: 'out', detail: 'not signed in' }
    }
    if (id === 'cursor') {
      const { stdout, stderr } = await $.process.run(await withPath($, ['cursor-agent', 'status']), { timeoutMs: 20000 })
      const text = oneLine(`${stdout} ${stderr}`).replace(/\x1b\[[0-9;]*m/g, '')
      return /logged in/i.test(text) && !/not logged in/i.test(text) ? { status: 'in', detail: short(text.replace(/^✓?\s*Logged in as\s*/i, ''), 60) } : { status: 'out', detail: 'not signed in' }
    }
    // Google sign-in records the account; an API key or Vertex setup counts as signed in too.
    const { stdout: env } = await $.process.run(['/bin/sh', '-c', 'printf %s "${GEMINI_API_KEY:+key}${GOOGLE_API_KEY:+key}"'])
    if (env) return { status: 'in', detail: 'API key' }
    const settings = await $.process.run(['/bin/sh', '-c', 'cat "$HOME/.gemini/settings.json" 2>/dev/null'], { timeoutMs: 5000 })
    const selected = (JSON.parse(settings.stdout || '{}') as { security?: { auth?: { selectedType?: string } } }).security?.auth?.selectedType
    if (selected && selected !== 'oauth-personal') return { status: 'in', detail: selected }
    // A Google sign-in counts only while its token file exists; the account list outlives it.
    const creds = await $.process.run(['/bin/sh', '-c', 'test -s "$HOME/.gemini/oauth_creds.json"'], { timeoutMs: 5000 })
    if (creds.exitCode !== 0) return { status: 'out', detail: 'not signed in (or the sign-in expired)' }
    const { stdout } = await $.process.run(['/bin/sh', '-c', 'cat "$HOME/.gemini/google_accounts.json" 2>/dev/null'], { timeoutMs: 5000 })
    const active = (JSON.parse(stdout || '{}') as { active?: string | null }).active
    return { status: 'in', detail: active || 'Google account' }
  } catch {
    return { status: 'out', detail: 'not signed in, or the CLI is missing' }
  }
}

async function refreshAccounts($: EngineInterface) {
  await Promise.all(PROVIDERS.map(async p => setAccount($, p.id, await checkAccount($, p.id))))
}

async function signIn($: EngineInterface, id: Provider) {
  if (id === 'gemini') {
    // Gemini signs in from its own interactive screen, so it needs a real terminal.
    const { stdout } = await $.process.run(['uname']).catch(() => ({ stdout: '' }))
    if (stdout.trim() === 'Darwin') {
      await setAccount($, id, { status: 'busy', detail: 'opened a Terminal window: pick "Login with Google", then come back' })
      await $.process
        .run(['osascript', '-e', 'tell application "Terminal" to activate', '-e', 'tell application "Terminal" to do script "gemini"'])
        .catch(err => $.ui.toast(`Could not open Terminal: ${String(err)}`))
    } else {
      await setAccount($, id, { status: 'busy', detail: 'run `gemini` in a terminal, pick "Login with Google", then press refresh' })
    }
    return
  }
  const argv = id === 'claude' ? ['claude', 'auth', 'login'] : id === 'codex' ? ['codex', 'login'] : ['cursor-agent', 'login']
  await setAccount($, id, { status: 'busy', detail: 'opening your browser…' })
  void (async () => {
    const stream = $.process.spawn({ argv: await withPath($, argv) })
    try {
      for await (const { text } of stream) {
        // Surface the sign-in link in case the browser did not open.
        const url = text.match(/https?:\/\/\S+/)?.[0]
        if (url) await setAccount($, id, { status: 'busy', detail: `finish in the browser · ${short(url, 70)}` })
      }
    } catch (err) {
      $.ui.toast(`Sign-in failed: ${String(err)}`)
    }
    const account = await checkAccount($, id)
    await setAccount($, id, account)
    $.ui.toast(account.status === 'in' ? `${PROVIDERS.find(p => p.id === id)?.name} signed in` : 'Not signed in yet')
  })()
}

async function signOut($: EngineInterface, id: Provider) {
  const argv = id === 'codex' ? ['codex', 'logout'] : id === 'cursor' ? ['cursor-agent', 'logout'] : undefined
  if (!argv) return
  await setAccount($, id, { status: 'busy', detail: 'signing out…' })
  await $.process.run(await withPath($, argv), { timeoutMs: 20000 }).catch(() => undefined)
  await setAccount($, id, await checkAccount($, id))
}

// ---------- Jobs ----------

type Dispatch = {
  title: string
  stage: Stage
  model: ModelId
  access: Access
  task: string
  prompt: string
  parentId?: string
  pipeline?: Pipeline
  step?: number
}

async function dispatch($: EngineInterface, input: Dispatch): Promise<string> {
  // Only the dispatch fields: a retry built from an old job must not inherit its run state.
  const { title, stage, model, access, task, prompt, parentId, pipeline, step } = input
  const d: Dispatch = { title, stage, model, access, task, prompt, parentId, pipeline, step }
  const job: Job = { ...d, id: newId(), status: 'running', startedAt: Date.now(), output: '', activity: [] }
  await update($, jobs, list => [job, ...list].slice(0, 60))
  await saveJobs($)
  $.ui.toast(`${short(d.title, 40)} → ${modelLabel(d.model)}`)
  const account = (await read($, accounts))[PROVIDER_OF[d.model]]
  if (account.status === 'missing') $.ui.toast(`${CLI_OF[PROVIDER_OF[d.model]]} is not installed, so this will fail`)
  else if (account.status === 'out') $.ui.toast(`${PROVIDERS.find(p => p.id === PROVIDER_OF[d.model])?.name} looks signed out; sign in at the top if this fails`)

  if (isClaude(d.model)) {
    // Read-only Claude jobs run as an agent with the editing tools removed and its own
    // permission mode, so they cannot inherit an edit-accepting parent session.
    if (d.access === 'read' && !readerAgent) {
      await patchJob($, job.id, j => ({ ...j, status: 'failed', endedAt: Date.now(), output: 'The read-only agent is not available in this session, so this read-only job did not start.' }))
      await finish($, job.id)
      return job.id
    }
    const started = await $.agent.spawn({
      prompt: d.prompt,
      description: `[${modelLabel(d.model).split(' ')[0]!.toUpperCase()}] ${short(d.title, 40)}`,
      subagentType: d.access === 'read' && readerAgent ? readerAgent : 'general-purpose',
      model: CLAUDE_IDS[d.model],
    })
    if (started.deny !== undefined || !started.agentId) {
      await patchJob($, job.id, j => ({ ...j, status: 'failed', endedAt: Date.now(), output: `Spawn refused: ${String(started.deny)}` }))
      await finish($, job.id)
    } else {
      const agentId = started.agentId
      await patchJob($, job.id, j => ({ ...j, agentId }))
    }

    return job.id
  }

  const { argv, input: stdin } = cliCommand(d.model, d.access, d.prompt)
  void (async () => {
    const stream = $.process.spawn({ argv: await withPath($, argv), input: stdin })
    children.set(job.id, () => void stream.return(undefined as never))
    let isFirst = true
    try {
      while (true) {
        const step = await stream.next()
        if (step.done) {
          const { code, signal } = step.value
          await patchJob($, job.id, j => ({
            ...j,
            status: j.status === 'stopped' ? 'stopped' : code === 0 ? 'done' : 'failed',
            endedAt: Date.now(),
            output: code === 0 ? j.output : appendOutput(j.output, `\n[exit ${code ?? signal}]`),
          }))
          break
        }
        await patchJob($, job.id, j => ({ ...j, output: appendOutput(j.output, step.value.text) }))
        if (isFirst) {
          isFirst = false
          // Follow a growing output when its job is the one on screen.
          const u = await read($, ui)
          if (u.view === 'job' && u.jobId === job.id) void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
        }
      }
    } catch (err) {
      await patchJob($, job.id, j => ({
        ...j,
        status: j.status === 'stopped' ? 'stopped' : 'failed',
        endedAt: j.endedAt ?? Date.now(),
        output: appendOutput(j.output, `\n${String(err)}`),
      }))
    } finally {
      children.delete(job.id)
    }
    await finish($, job.id)
  })()

  return job.id
}

// Runs once per job when it ends: toast, persist, and advance a pipeline.
async function finish($: EngineInterface, id: string) {
  const job = (await read($, jobs)).find(j => j.id === id)
  if (!job) return
  await saveJobs($)
  const next = nextStageOf(job)
  if (job.status === 'done' && next && (await read($, autoAdvance))) {
    await advance($, job)
    return
  }
  if (job.status === 'done' && next && job.pipeline) {
    $.ui.toast(`${stageLabel(job.stage)} done · step ${(job.step ?? 0) + 2} of ${job.pipeline.stages.length} waits for you`)
  } else if (job.status === 'done') {
    $.ui.toast(`${modelLabel(job.model)} finished: ${short(job.title, 40)}`)
  } else if (job.status === 'failed') {
    $.ui.toast(`${modelLabel(job.model)} failed: ${short(job.title, 40)}`)
  }
}

async function advance($: EngineInterface, job: Job) {
  const pipeline = job.pipeline
  const step = (job.step ?? 0) + 1
  const stage = pipeline?.stages[step]
  if (!pipeline || !stage || advancing.has(job.id)) return
  // Claim against the current state, not the caller's snapshot.
  const current = (await read($, jobs)).find(j => j.id === job.id)
  if (!current || current.isAdvanced) return
  advancing.add(job.id)
  await patchJob($, job.id, j => ({ ...j, isAdvanced: true }))
  const route = routeFor(await read($, presets), stage)

  return dispatch($, {
    title: `${stageLabel(stage)}: ${short(pipeline.goal, 50)}`,
    stage,
    model: route.model,
    access: route.access,
    task: pipeline.goal,
    prompt: HANDOFF[stage](pipeline.goal, job.output.trim()),
    parentId: job.id,
    pipeline,
    step,
  })
}

async function launch($: EngineInterface, text: string) {
  const d = await read($, draft)
  const preset = (await read($, presets)).find(p => p.id === d.presetId)
  const input = text.trim()
  if (!preset) {
    $.ui.toast('Pick a task first')
    return
  }
  if (!input && !OPTIONAL_INPUT.has(preset.id)) {
    $.ui.toast('Type what you want first')
    return
  }
  const prompt = preset.template.includes('{input}') ? preset.template.replaceAll('{input}', () => input) : `${preset.template}\n\n${input}`.trim()
  const title = input ? short(`${preset.title.split(' (')[0]}: ${input}`, 80) : preset.title
  const pipeline = preset.then ? { id: newId(), stages: [preset.stage, ...preset.then], goal: input } : undefined
  const routes = routesOf(await read($, presets))
  await update($, draft, x => ({ ...x, input: '' }))
  await dispatch($, {
    title,
    stage: preset.stage,
    model: pipeline ? routes[preset.stage] : modelOf(preset),
    access: pipeline ? routeFor(await read($, presets), preset.stage).access : preset.access,
    task: input,
    prompt: pipeline ? HANDOFF[preset.stage](input, '') : prompt,
    pipeline,
    step: pipeline ? 0 : undefined,
  })
}

async function pickTask($: EngineInterface, id: string) {
  const preset = (await read($, presets)).find(p => p.id === id)
  if (!preset) return
  await update($, draft, d => ({ ...d, presetId: id, stage: preset.stage, model: modelOf(preset), access: preset.access }))
  await $.ui.focus({ requestId: PANE, key: 'input' }).catch(() => undefined)
}

async function addTask($: EngineInterface) {
  const t = await read($, newTask)
  const title = oneLine(t.title)
  if (!title) {
    $.ui.toast('Name the task first')
    return
  }
  const w = WHO.find(x => x.value === t.who) ?? { model: "opus" as ModelId, access: "write" as Access }
  const p: Preset = { id: newId(), title, stage: 'research', model: w.model, access: w.access, template: `${title}: {input}` }
  await savePresets($, l => [...l, p])
  await update($, newTask, x => ({ ...x, title: '' }))
  await update($, draft, d => ({ ...d, presetId: p.id, stage: p.stage, model: w.model, access: w.access }))
  $.ui.toast(`Added "${title}" on ${modelLabel(w.model)}`)
}

// Next + Reply: one Select and one Input replace rerun, rerun-on, hand off and follow up.
async function reply($: EngineInterface, job: Job, next: string, text: string) {
  const routes = routesOf(await read($, presets))
  const extra = text.trim()
  const output = job.output.trim()
  const followUp = (model: ModelId) =>
    dispatch($, {
      title: short(`↳ ${extra}`, 80),
      stage: job.stage,
      model,
      access: job.access,
      task: extra,
      prompt: `Earlier task:\n${job.prompt}\n\nThe answer:\n${output}\n\nFollow-up:\n${extra}`,
      parentId: job.id,
    })

  if (next.startsWith('stage:')) {
    const stage = next.slice(6) as Stage
    const base = HANDOFF[stage](job.task || job.title, output)
    return dispatch($, {
      title: short(`${stageLabel(stage)}: ${job.task || job.title}`, 80),
      stage,
      model: routeFor(await read($, presets), stage).model,
      access: routeFor(await read($, presets), stage).access,
      task: job.task,
      prompt: extra ? `${base}\n\nAlso: ${extra}` : base,
      parentId: job.id,
    })
  }
  if (next.startsWith('model:')) {
    const model = next.slice(6) as ModelId
    if (extra) return followUp(model)
    return dispatch($, { ...job, model, title: short(`${job.title} (on ${modelLabel(model)})`, 80), parentId: job.id, pipeline: undefined, step: undefined })
  }
  if (extra) return followUp(job.model)

  return dispatch($, { ...job, parentId: job.parentId, pipeline: job.pipeline, step: job.step })
}

async function sendToClaude($: EngineInterface, job: Job) {
  const text = [
    `Result from the orchestra pane: ${job.title} by ${modelLabel(job.model)} (${job.status}).`,
    '',
    job.output.trim() || '(no output)',
  ].join('\n')
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  await patchJob($, job.id, j => ({ ...j, isSent: true }))
  $.ui.toast('Added to the conversation')
}

const elapsed = (job: Job) => {
  const s = Math.max(0, Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}

type Shown = Job['status'] | 'paused'
const shownStatus = (job: Job): Shown => (isPaused(job) ? 'paused' : job.status)
const MARK: Record<Shown, string> = { paused: '‖', running: '●', done: '✓', failed: '✗', stopped: '■', lost: '?' }
const COLOR: Record<Shown, string> = { paused: 'magenta', running: 'yellow', done: 'green', failed: 'red', stopped: 'gray', lost: 'gray' }
const RANK: Record<Shown, number> = { paused: 0, running: 1, done: 2, failed: 2, stopped: 2, lost: 2 }

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Orchestra', focus: true, holdToasts: true, rows: 60, columns: 110 })

const openJob = async ($: EngineInterface, id: string) => {
  await update($, ui, x => ({ ...x, view: 'job' as const, jobId: id, next: 'again', showPrompt: false }))
  const job = (await read($, jobs)).find(j => j.id === id)
  if (job && isPaused(job)) await $.ui.focus({ requestId: PANE, key: 'continue' }).catch(() => undefined)
}

function routingNote(ps: readonly Preset[]) {
  return [
    'Orchestra routing (set by the user in the /orchestrate pane; it overrides the routing table in CLAUDE.md, follow it when you delegate):',
    ...ps.filter(p => !p.then).map(p => `- ${p.title}: ${whoLabel(modelOf(p), p.access)}`),
    `How to reach each: ${modelLabel('fable')} = Agent tool with model ${CFG.fableModel}; ${modelLabel('opus')} = Agent tool with model ${CFG.opusModel}; ${modelLabel('astra')} = codex exec -m ${CFG.codexModel}; ${modelLabel('composer')} = cursor-agent -p --model ${CFG.cursorModel}; ${modelLabel('gemini')} = gemini -y.`,
  ].join('\n')
}

export const register: Register = (on, options: PluginOptions) => {
  for (const key of Object.keys(CFG) as (keyof typeof CFG)[]) {
    const value = options[key]
    if (typeof value === typeof CFG[key]) (CFG as Record<string, unknown>)[key] = value
  }
  CLAUDE_IDS.fable = CFG.fableModel
  CLAUDE_IDS.opus = CFG.opusModel

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    const [savedPresets, savedJobs, savedGuard, savedAuto] = await Promise.all(
      [KEYS.presets, jobsKey(), KEYS.guard, KEYS.autoAdvance].map(key => $.store.get(key).catch(() => undefined)),
    )
    if (Array.isArray(savedPresets) && savedPresets.length) await update($, presets, () => savedPresets as Preset[])
    if (Array.isArray(savedJobs)) {
      // Anything still running belonged to a process that is gone now.
      const restored = (savedJobs as Job[]).map(j => (j.status === 'running' ? { ...j, status: 'lost' as const, endedAt: j.endedAt ?? Date.now() } : j))
      await update($, jobs, () => restored)
    }
    await update($, guard, () => (typeof savedGuard === 'boolean' ? savedGuard : CFG.guard))
    if (typeof savedAuto === 'boolean') await update($, autoAdvance, () => savedAuto)
    const plan = (await read($, presets)).find(p => p.id === 'plan')
    if (plan) await update($, draft, d => ({ ...d, model: modelOf(plan), access: plan.access }))

    await $.command.register({
      name: 'orchestrate',
      description: 'Your tasks, the model each one runs on, and your sign-ins. "/orchestrate <stage>: <task>" sends one straight away',
    })

    void refreshAccounts($)
    const started = await next(e)
    readerAgent = await $.agent
      .register({
        name: 'reader',
        description: 'Read-only worker the Orchestra pane uses for read-only tasks',
        prompt: 'You are a read-only worker. Investigate, review or plan, and report what you find. Never create, edit or delete files, and never run commands that change the repository or the system.',
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
        permissionMode: 'default',
      })
      .then(r => r.agent)
      .catch(err => {
        $.ui.log(`orchestra: read-only agent unavailable: ${String(err)}`, { to: 'debug' })
        return undefined
      })
    await noteRouting($, await read($, presets))

    // Keep elapsed times and the status line current while something runs.
    $.clock.every(1000, () => {
      void read($, jobs).then(list => {
        const running = list.filter(j => j.status === 'running').length
        const paused = list.filter(isPaused).length
        const parts = [running && `${running} running`, paused && `${paused} paused`].filter(Boolean)
        $.ui.status(parts.length ? `orchestra: ${parts.join(' · ')}` : undefined)
        if (running) $.ui.invalidate('ui.render')
      })
    })

    return started
  })

  on('command.run', { command: 'orchestrate' }, async ($, e) => {
    const match = e.args.trim().match(/^(\w+):\s*([\s\S]+)$/)
    const stage = STAGES.find(s => s.value === match?.[1]?.toLowerCase())?.value
    const task = match?.[2]
    if (stage && task) {
      const { model, access } = routeFor(await read($, presets), stage)
      const id = await dispatch($, { title: short(`${stageLabel(stage)}: ${task}`, 80), stage, model, access, task, prompt: task })
      await update($, ui, x => ({ ...x, view: 'job' as const, jobId: id, next: 'again' }))
      await openPane($)

      return { text: `Sent ${stageLabel(stage)} to ${modelLabel(model)}.` }
    }
    await update($, ui, x => ({ ...x, view: 'home' as const }))
    void refreshAccounts($)
    await openPane($)

    return { text: 'Orchestra opened.' }
  })

  // The read-only agent is the pane's own; Claude's Agent tool does not offer it.
  on('agent.offer', async ($, e, next) => (readerAgent && e.agent === readerAgent ? { isOffered: false } : next(e)))

  // Enforce the routing table on subagents spawned outside the pane.
  on('agent.spawn', async ($, e, next) => {
    if (e.model && BANNED.test(e.model) && (await read($, guard))) {
      $.ui.toast(`${e.model} is off the routing table, running as Opus 5.5`)

      return next({ ...e, model: CFG.opusModel })
    }

    return next(e)
  })

  // Live activity for Claude jobs: each tool their subagent calls.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const job = (await read($, jobs)).find(j => j.agentId === e.agentId && j.status === 'running')
      if (job) await patchJob($, job.id, j => ({ ...j, activity: [...j.activity, e.tool].slice(-30) }))
    }

    return next(e)
  })

  // A Claude job's answer is its subagent's turn.complete.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      const job = (await read($, jobs)).find(j => j.agentId === e.agentId && j.status === 'running')
      if (job) {
        await patchJob($, job.id, j => ({
          ...j,
          status: e.isAborted || e.reason === 'error' ? 'failed' : 'done',
          endedAt: Date.now(),
          output: result.text || e.answer,
        }))
        await finish($, job.id)
      }
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Orchestra needs the terminal or desktop app.</Text>
    }
    const { Box, Text, Button, Input, Select, Markdown } = $.ui.resolve(e)
    const [d, list, ps, u, g, auto, acc, nt] = await Promise.all([
      read($, draft),
      read($, jobs),
      read($, presets),
      read($, ui),
      read($, guard),
      read($, autoAdvance),
      read($, accounts),
      read($, newTask),
    ])
    const routes = routesOf(ps)
    const width = e.props.bodyColumns
    const running = list.filter(j => j.status === 'running').length
    const paused = list.filter(isPaused).length
    const heading = (text: string) => <Text bold color="magenta">{text}</Text>

    // ---------- Job ----------
    if (u.view === 'job') {
      const back = <Button key="back" hotkey="b" plain label="back" onPress={() => void update($, ui, x => ({ ...x, view: 'home' as const }))} />
      const job = list.find(j => j.id === u.jobId)
      if (!job) {
        return (
          <Box flexDirection="column" gap={1}>
            {back}
            <Text dimColor>That job was dismissed.</Text>
          </Box>
        )
      }
      const shown = shownStatus(job)
      const isRunning = job.status === 'running'
      const nextStage = nextStageOf(job)
      const parent = job.parentId ? list.find(j => j.id === job.parentId) : undefined
      const kids = list.filter(j => j.parentId === job.id)
      const output = job.output.trim()
      const next = u.next ?? 'again'
      const target = next.startsWith('model:') ? (next.slice(6) as ModelId) : undefined
      const handTo = next.startsWith('stage:') ? (next.slice(6) as Stage) : undefined
      const replyHint = handTo
        ? `Enter hands the result to ${modelLabel(routes[handTo])}, or add instructions`
        : target
          ? `Enter reruns on ${modelLabel(target)}, or type a follow-up`
          : job.status === 'failed'
            ? 'Enter retries, or type what to change'
            : 'Enter reruns the same prompt, or type a follow-up'
      const meta = [
        modelLabel(job.model),
        job.access === 'write' ? 'edits files' : 'read-only',
        elapsed(job),
        job.pipeline ? `step ${(job.step ?? 0) + 1} of ${job.pipeline.stages.length}` : '',
      ]
        .filter(Boolean)
        .join(' · ')

      return (
        <Box flexDirection="column" gap={1}>
          {back}
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={COLOR[shown]} bold>{`${MARK[shown]} ${shown}   `}</Text>
              <Text dimColor>{meta}</Text>
            </Text>
            <Text bold wrap="wrap">{job.title}</Text>
            {job.status === 'lost' && <Text dimColor>The session restarted while this ran.</Text>}
            {isRunning && job.activity.length > 0 && <Text dimColor wrap="truncate-start">{job.activity.slice(-10).join(' → ')}</Text>}
            {parent && (
              <Button
                key="parent"
                plain
                dimColor
                label={`↑ ${short(parent.title, 50)} · ${modelLabel(parent.model)} · ${shownStatus(parent)}`}
                onPress={() => void openJob($, parent.id)}
              />
            )}
            {kids.map(k => (
              <Button
                key={`child:${k.id}`}
                plain
                dimColor
                label={`↓ ${MARK[shownStatus(k)]} ${short(k.title, 50)} · ${modelLabel(k.model)}`}
                onPress={() => void openJob($, k.id)}
              />
            ))}
          </Box>

          <Box gap={3} flexWrap="wrap">
            {isRunning && children.has(job.id) && (
              <Button
                key="stop"
                hotkey="x"
                plain
                label="stop"
                onPress={() => {
                  void patchJob($, job.id, j => ({ ...j, status: 'stopped', endedAt: Date.now() }))
                  children.get(job.id)?.()
                  $.ui.toast('Stopped')
                }}
              />
            )}
            {isPaused(job) && nextStage && (
              <Button
                key="continue"
                hotkey="c"
                variant="primary"
                label={`Continue → ${stageLabel(nextStage)} (${modelLabel(routes[nextStage])})`}
                onPress={() => void advance($, job).then(id => (id ? openJob($, id) : undefined))}
              />
            )}
            {!isRunning && !job.isSent && <Button key="send" hotkey="s" plain label="send to chat" onPress={() => void sendToClaude($, job)} />}
            {!isRunning && job.isSent && <Text dimColor>sent to chat</Text>}
            {output && (
              <Button
                key="copy"
                plain
                label="copy"
                onPress={press => void $.ui.copy({ text: output, surface: press.surface }).then(() => $.ui.toast('Copied'))}
              />
            )}
            {!isRunning && (
              <Button
                key="dismiss"
                plain
                dimColor
                label="dismiss"
                onPress={() => {
                  void update($, jobs, l => l.filter(j => j.id !== job.id)).then(() => saveJobs($))
                  void update($, ui, x => ({ ...x, view: 'home' as const }))
                }}
              />
            )}
          </Box>

          {isRunning ? (
            job.agentId ? (
              <Input
                key="steer"
                placeholder="Message the running agent"
                submitLabel="send"
                onSubmit={value => {
                  if (!value.trim() || !job.agentId) return
                  void $.session
                    .append({ agentId: job.agentId, message: { type: 'user', content: [{ type: 'text', text: value.trim() }] } })
                    .then(() => $.ui.toast('Sent to the agent'))
                    .catch(err => $.ui.toast(`Could not send: ${String(err)}`))
                }}
              />
            ) : null
          ) : (
            <Box flexDirection="column">
              <Select
                key="next"
                label="Next  "
                value={next}
                options={[
                  { value: 'again', label: `Ask ${modelLabel(job.model)} again` },
                  ...MODELS.filter(m => m.value !== job.model).map(m => ({ value: `model:${m.value}`, label: `Ask ${m.label} instead` })),
                  ...STAGES.map(s => ({ value: `stage:${s.value}`, label: `Hand to ${s.label} (${modelLabel(routes[s.value])})` })),
                ]}
                onSelect={value => void update($, ui, x => ({ ...x, next: value }))}
              />
              <Input
                key="reply"
                placeholder={replyHint}
                submitLabel={handTo ? 'hand off' : 'send'}
                onSubmit={value => void reply($, job, next, value).then(id => openJob($, id))}
              />
            </Box>
          )}

          <Box flexDirection="column">
            <Text dimColor>{`── output ${'─'.repeat(Math.max(0, width - 10))}`}</Text>
            {!output && <Text dimColor>{isRunning ? 'Waiting for the first output…' : 'No output.'}</Text>}
            {output && (!isRunning && isClaude(job.model) ? <Markdown text={output} /> : <Text wrap="wrap">{output}</Text>)}
          </Box>
          <Button
            key="show-prompt"
            plain
            dimColor
            label={u.showPrompt ? 'hide prompt' : 'show prompt'}
            onPress={() => void update($, ui, x => ({ ...x, showPrompt: !x.showPrompt }))}
          />
          {u.showPrompt && <Text dimColor wrap="wrap">{job.prompt}</Text>}
        </Box>
      )
    }

    // ---------- Home ----------
    const selected = ps.find(p => p.id === d.presetId)
    // Models whose CLI is not installed drop out of the pickers (the current pick stays visible).
    const whoOptions = (current: string) =>
      WHO.filter(w => acc[PROVIDER_OF[w.model]].status !== 'missing' || w.value === current).map(w => ({ value: w.value, label: whoLabel(w.model, w.access) }))
    const nameWidth = Math.min(40, Math.max(24, Math.floor(width * 0.42)))
    const sorted = [...list].sort((a, b) => RANK[shownStatus(a)] - RANK[shownStatus(b)] || b.startedAt - a.startedAt)
    const selectedModel = selected?.then
      ? [selected.stage, ...selected.then].map(s => modelLabel(routes[s]).split(' ')[0]).join(' → ')
      : selected
        ? whoLabel(modelOf(selected), selected.access)
        : ''
    const jobsHeader = [running && `${running} running`, paused && `${paused} paused`].filter(Boolean).join(' · ')

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text bold>Orchestra</Text>
          <Text dimColor>{e.props.isFocused ? 'Tab moves · Enter picks' : 'ctrl+x tab to focus'}</Text>
        </Box>

        {/* Accounts */}
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            {heading('Accounts')}
            <Button key="refresh-accounts" plain dimColor label="refresh" onPress={() => void refreshAccounts($)} />
          </Box>
          {PROVIDERS.map(p => {
            const a = acc[p.id]
            const mark = a.status === 'in' ? '●' : a.status === 'out' ? '○' : a.status === 'missing' ? '–' : '◌'
            const color = a.status === 'in' ? 'green' : a.status === 'out' ? 'red' : a.status === 'missing' ? 'gray' : 'yellow'
            return (
              <Box key={`acct:${p.id}`} gap={2}>
                <Box width={nameWidth}>
                  <Text wrap="truncate-end">
                    <Text color={color}>{`${mark} `}</Text>
                    <Text bold>{p.name.padEnd(9)}</Text>
                    <Text dimColor>{p.models}</Text>
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text dimColor={a.status !== 'in'} wrap="truncate-end">{a.status === 'checking' ? 'checking…' : a.detail}</Text>
                </Box>
                {a.status === 'out' && <Button key={`signin:${p.id}`} plain label="sign in" onPress={() => void signIn($, p.id)} />}
                {a.status === 'in' && p.id !== 'claude' && (
                  <Button
                    key={`switch:${p.id}`}
                    plain
                    dimColor
                    label={p.id === 'gemini' ? 'switch' : 'sign out'}
                    onPress={() => void (p.id === 'gemini' ? signIn($, p.id) : signOut($, p.id))}
                  />
                )}
              </Box>
            )
          })}
        </Box>

        {/* Tasks: the routing table */}
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            {heading('Tasks')}
            <Text dimColor>model it runs on</Text>
          </Box>
          {ps.map(p => {
            const isSel = p.id === d.presetId
            return (
              <Box key={`row:${p.id}`} gap={2}>
                <Box width={nameWidth}>
                  <Button
                    key={`task:${p.id}`}
                    plain
                    variant={isSel ? 'primary' : undefined}
                    label={`${isSel ? '▸' : ' '} ${short(p.title, nameWidth - 3)}`}
                    onPress={() => void pickTask($, p.id)}
                  />
                </Box>
                <Box flexGrow={1}>
                  {p.then ? (
                    <Text dimColor wrap="truncate-end">
                      {[p.stage, ...p.then].map(s => modelLabel(routes[s]).split(' ')[0]).join(' → ')}
                    </Text>
                  ) : (
                    <Select
                      key={`who:${p.id}`}
                      value={whoValue(modelOf(p), p.access)}
                      options={whoOptions(whoValue(modelOf(p), p.access))}
                      onSelect={value => {
                        const w = WHO.find(x => x.value === value)
                        if (!w) return
                        void savePresets($, l => l.map(x => (x.id === p.id ? { ...x, model: w.model, access: w.access } : x)))
                        if (isSel) void update($, draft, x => ({ ...x, model: w.model, access: w.access }))
                      }}
                    />
                  )}
                </Box>
                {!p.isBuiltin && (
                  <Button
                    key={`del:${p.id}`}
                    plain
                    dimColor
                    label="×"
                    onPress={() => {
                      void savePresets($, l => l.filter(x => x.id !== p.id))
                      if (isSel) void update($, draft, x => ({ ...x, presetId: 'plan' }))
                    }}
                  />
                )}
              </Box>
            )
          })}
          <Box gap={2}>
            <Box width={nameWidth}>
              <Input
                key="new-task"
                label="+ "
                placeholder="Add a task (e.g. Write tests)"
                value={nt.title}
                submitLabel="add"
                onInput={value => void update($, newTask, x => ({ ...x, title: value }))}
                onSubmit={value => void update($, newTask, x => ({ ...x, title: value })).then(() => addTask($))}
              />
            </Box>
            <Box flexGrow={1}>
              <Select
                key="new-task-model"
                value={nt.who}
                options={whoOptions(nt.who)}
                onSelect={value => void update($, newTask, x => ({ ...x, who: value }))}
              />
            </Box>
          </Box>
        </Box>

        {/* Composer */}
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text wrap="truncate-end">
            <Text bold>{selected ? selected.title : 'Pick a task above'}</Text>
            {selected ? <Text dimColor>{`  →  ${selectedModel}`}</Text> : null}
          </Text>
          {selected && <Text dimColor wrap="wrap">{HINTS[selected.id] ?? oneLine(selected.template.replaceAll('{input}', '…'))}</Text>}
          <Input
            key="input"
            label="› "
            placeholder={(selected && PLACEHOLDERS[selected.id]) ?? 'What do you want done? Enter sends it'}
            submitLabel="send"
            value={d.input}
            autoFocus
            onInput={value => void update($, draft, x => ({ ...x, input: value }))}
            onSubmit={value => void launch($, value)}
          />
        </Box>

        {/* Jobs */}
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            {heading('Jobs')}
            <Text dimColor>{jobsHeader}</Text>
          </Box>
          {sorted.length === 0 && <Text dimColor>Nothing yet. Pick a task, type what you want, press Enter.</Text>}
          {sorted.map((job, i) => {
            const s = shownStatus(job)
            const step = job.pipeline ? `${(job.step ?? 0) + 1}/${job.pipeline.stages.length} ` : ''
            const label = `${MARK[s]} ${s.padEnd(8)} ${modelLabel(job.model).padEnd(13)} ${elapsed(job).padStart(6)}  ${step}${job.title}`
            return (
              <Button
                key={`job:${job.id}`}
                plain
                hotkey={i < 9 ? String(i + 1) : undefined}
                label={short(label, Math.max(30, width - 4))}
                onPress={() => void openJob($, job.id)}
              />
            )
          })}
        </Box>

        <Box gap={3}>
          {list.some(j => j.status !== 'running' && !isPaused(j)) && (
            <Button
              key="clear-finished"
              plain
              dimColor
              label="clear finished"
              onPress={() => void update($, jobs, l => l.filter(j => j.status === 'running' || isPaused(j))).then(() => saveJobs($))}
            />
          )}
          <Button
            key="settings"
            plain
            dimColor
            label={u.showSettings ? 'hide settings' : 'settings'}
            onPress={() => void update($, ui, x => ({ ...x, showSettings: !x.showSettings }))}
          />
        </Box>

        {u.showSettings && (
          <Box flexDirection="column">
            <Select
              key="pipelines"
              label="Pipelines  "
              value={auto ? 'auto' : 'manual'}
              options={[
                { value: 'manual', label: 'Pause after each step for my approval' },
                { value: 'auto', label: 'Run straight through' },
              ]}
              onSelect={value => {
                void update($, autoAdvance, () => value === 'auto')
                void persist($, KEYS.autoAdvance, value === 'auto')
              }}
            />
            <Select
              key="guard"
              label="Guard      "
              value={g ? 'on' : 'off'}
              options={[
                { value: 'on', label: 'On: Haiku, Sonnet and old Opus subagents run as Opus 5.5' },
                { value: 'off', label: 'Off' },
              ]}
              onSelect={value => {
                void update($, guard, () => value === 'on')
                void persist($, KEYS.guard, value === 'on')
              }}
            />
            {selected && !selected.then ? (
              <Input
                key="template"
                label="Template   "
                value={selected.template}
                submitLabel="save"
                onSubmit={value => {
                  void savePresets($, l => l.map(x => (x.id === selected.id ? { ...x, template: value } : x)))
                  $.ui.toast('Template saved')
                }}
              />
            ) : (
              <Text dimColor>Template   The pipeline builds each step's prompt itself.</Text>
            )}
            <Box gap={3} marginTop={1}>
              <Button
                key="restore-presets"
                plain
                dimColor
                label="restore built-in tasks and models"
                onPress={() => {
                  void savePresets($, l => [...BUILTIN_PRESETS, ...l.filter(x => !x.isBuiltin)])
                  $.ui.toast('Built-in tasks restored')
                }}
              />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
