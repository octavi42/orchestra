export type Stage = 'plan' | 'critique' | 'implement' | 'mechanical' | 'review' | 'verify' | 'research'
export type ModelId = 'fable' | 'opus' | 'astra' | 'composer' | 'gemini'
export type Access = 'read' | 'write'
export type JobStatus = 'running' | 'done' | 'failed' | 'stopped' | 'lost'
export type View = 'home' | 'job'
export type Provider = 'claude' | 'codex' | 'cursor' | 'gemini'
export type Account = { status: 'checking' | 'in' | 'out' | 'busy' | 'missing'; detail: string }

export type Preset = {
  id: string
  title: string
  stage: Stage
  // Pinned model; absent follows the stage's routing default.
  model?: ModelId
  access: Access
  // `{input}` is replaced by what the person types.
  template: string
  // Present on a pipeline preset: the stages after the first, run in order.
  then?: Stage[]
  isBuiltin?: boolean
}

export type Pipeline = { id: string; stages: Stage[]; goal: string }

export type Job = {
  id: string
  title: string
  stage: Stage
  model: ModelId
  access: Access
  task: string
  prompt: string
  status: JobStatus
  startedAt: number
  endedAt?: number
  agentId?: string
  output: string
  activity: string[]
  isSent?: boolean
  parentId?: string
  pipeline?: Pipeline
  step?: number
  isAdvanced?: boolean
}

export type Draft = {
  // A preset id, or `free:<stage>` for a template-less task.
  presetId: string
  stage: Stage
  model: ModelId
  access: Access
  input: string
}

export type Ui = { view: View; jobId?: string; showSettings: boolean; showPrompt: boolean; next?: string }

declare module 'claude-code' {
  interface PluginState {
    orchestra: {
      accounts: Record<Provider, Account>
      newTask: { title: string; who: string }
      draft: Draft
      jobs: Job[]
      presets: Preset[]
      ui: Ui
      guard: boolean
      autoAdvance: boolean
    }
  }
}
