# Orchestra

Pick which model runs each kind of task, from inside Claude Code.

Orchestra is a Claude Code mod (a plugin with a live pane). It gives you one table: your tasks on the left, the model each one runs on to the right. Send a task from the pane and it goes to that model. Claude also reads the table, so when it delegates on its own it follows your picks.

```
Orchestra
Accounts                                                    refresh
● Claude    Fable, Opus        you@example.com
● ChatGPT   Astra              using ChatGPT                sign out
○ Cursor    Composer           not signed in                sign in
● Gemini    Gemini             you@gmail.com                switch

Tasks                                            model it runs on
▸ Plan a change (with reproduction test)         Fable 5.1
  Red-team a plan or design                      GPT-6 Astra · read-only
  Implement with a done-criterion                Opus 5.5
  Review a PR                                    GPT-6 Astra · read-only
  Write tests                                    Composer 2.5 · edits files   ×
+ Add a task                                     Opus 5.5

╭ Plan a change  →  Fable 5.1 ──────────────────────╮
│ › What do you want done? Enter sends it           │
╰───────────────────────────────────────────────────╯
Jobs
1: ● running  Fable 5.1      0m42s  Plan a change: add rate limiting
```

## Install

```
/plugin marketplace add octavi42/orchestra
/plugin install orchestra@orchestra
```

Then run `/orchestrate`.

## What you get

- **Tasks and models.** Every task has a model picker. Add your own tasks with the `+` row and the model beside it. Your table is saved across sessions.
- **Run from the pane.** Pick a task, type what you want, press Enter. Jobs stream their output; open one to rerun it, ask a follow-up, hand the result to another task, or send it into your Claude conversation.
- **A pipeline.** "Full pipeline" runs plan, red-team, implement and review in order, each step reading the last one's output, and pauses for your approval between steps.
- **Sign-ins.** See which of your subscriptions are signed in and sign in from the pane: Claude, ChatGPT (Codex CLI), Cursor and Gemini.
- **Claude follows it.** Your table is added to the conversation so Claude routes its own delegation the same way. Turn this off in the plugin settings.

## Requirements

- A Claude Code version with mods (plugin hooks modules); tested on 2.1.286.
- Any of these CLIs for the non-Claude models, signed in: [Codex](https://github.com/openai/codex) (`codex`), [Cursor CLI](https://cursor.com/cli) (`cursor-agent`), [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`). Models whose CLI is not installed are hidden from the pickers.

## Settings

Change these in the `/config` menu under Orchestra:

| Setting | Default | What it does |
| --- | --- | --- |
| Planning model (Claude) | `claude-fable-5-1` | Model id behind the "Fable" choice |
| Implementation model (Claude) | `claude-opus-5-5` | Model id behind the "Opus" choice |
| Codex model | `gpt-6-astra` | Passed to `codex exec -m` |
| Cursor model | `composer-2.5` | Passed to `cursor-agent --model` |
| Model guard | off | Runs Haiku, Sonnet and older Opus subagents on the implementation model instead |
| Share routing with Claude | on | Adds your table to the conversation |

## Safety notes

Every task row is either **read-only** or **edits files**, and that setting is enforced per tool:

| Model | Read-only | Edits files |
| --- | --- | --- |
| Claude (Fable, Opus) | a read-only agent with Edit/Write removed and its own permission mode | a general-purpose agent |
| Codex | `codex exec -s read-only` | `codex exec -s workspace-write` |
| Cursor | `cursor-agent --mode ask` | `cursor-agent --force` |
| Gemini | `gemini --approval-mode plan` | `gemini --approval-mode yolo` |

- "Edits files" runs in your current directory without asking. Use it for tasks you would hand off unattended.
- Task text never passes through a shell and can never be read as a flag: Codex gets it on stdin, Cursor after `--`, Gemini as one `--prompt=` value.
- Jobs are kept per repository, so a paused pipeline never continues in a different project.
- Nothing is posted anywhere: the review templates tell the model not to comment on PRs.

## Develop

```
claude --plugin-dir ./
claude plugin validate .
claude plugin test .
```

## License

MIT
