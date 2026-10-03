# my-harness

A coding agent built from scratch in TypeScript, in the spirit of tools like Claude Code: you give it a task in plain English, and an AI model works on it by calling tools that read, search and run commands in your project.

The point of the project is to see how such a harness works on the inside, with no agent framework. It's a small amount of code you can read end to end:

- **One agent loop** that sends the conversation to a model, runs the tools the model asks for, sends the results back, and repeats until the model is done.
- **Swappable model providers**: Anthropic (Claude), Google Gemini and Groq, all behind one shared interface. Switching models is one command-line flag.
- **A small set of tools**: `read`, `ls`, `find`, `grep`, `stat` and `bash`.

## How it works

```
 you: "find where getProvider is defined"
        │
        ▼
 ┌─────────────┐  conversation + tool list  ┌──────────────┐
 │ agent loop  │ ─────────────────────────▶ │   provider   │ ──▶ Claude / Gemini / Groq API
 │ (loop.ts)   │ ◀───────────────────────── │ (translator) │
 └─────────────┘  text + tool calls         └──────────────┘
        │  model asked for a tool?
        ▼
 ┌─────────────┐
 │    tools    │  read · ls · find · grep · stat · bash
 └─────────────┘
        │  result goes back into the conversation → loop again
        ▼
 final answer printed when the model stops asking for tools
```

Every provider speaks one shared message format (`src/types.ts`) and translates it to and from its company's API. So the agent loop and the tools never need to know which model they're talking to.

## Project layout

```
src/
  main.ts                 command-line entry point: reads flags, starts the agent, prints progress
  types.ts                shared types: messages, tool calls, providers, tools
  agent/
    loop.ts               the agent loop
  providers/
    index.ts              list of providers; getProvider(name)
    anthropic.ts          Claude, via @anthropic-ai/sdk
    gemini.ts             Gemini, via @google/genai
    groq.ts               Groq, via groq-sdk
    openai-compat.ts      any OpenAI-compatible API (used for groq-openai, anthropic-openai)
  tools/
    index.ts              the list of tools given to the agent
    read.ts ls.ts find.ts grep.ts stat.ts bash.ts
    fsutil.ts             shared helpers (paths, folder walking, output trimming)
scripts/
  smoke.ts                checks that everything is wired together
```

## Setup

You need **Node.js 24 or newer** (`node -v` to check) and an API key for at least one provider.

```bash
git clone https://github.com/GREENRAT-K405/my-harness.git
cd my-harness
npm install
```

Create a `.env` file in the project root with the keys you have. You only need one:

```bash
GROQ_API_KEY=...        # https://console.groq.com/keys  (has a free tier)
GEMINI_API_KEY=...      # https://aistudio.google.com/apikey
ANTHROPIC_API_KEY=...   # https://console.anthropic.com/settings/keys
```

`.env` is in `.gitignore`, so your keys won't be committed.

Check that everything works:

```bash
npm run check         # type-check + offline tests (free, no network)
npm run smoke:live    # also one real tool-call round trip per provider you have a key for
```

## Usage

```bash
npm run dev -- -p "<your task>" --provider <name> [--model <model-id>]
```

The `--` passes the flags through npm to the program.

| Flag | Meaning |
|---|---|
| `-p`, `--prompt` | The task for the agent (required) |
| `--provider` | Which provider to use (default: `anthropic`) |
| `--model` | Use a specific model instead of the provider's default |

### Providers

| `--provider` | Default model | Key needed |
|---|---|---|
| `anthropic` | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| `anthropic-openai` | `claude-sonnet-5` (through Anthropic's OpenAI-compatible endpoint) | `ANTHROPIC_API_KEY` |
| `gemini` | `gemini-3.8-flash` | `GEMINI_API_KEY` |
| `groq` | `openai/gpt-oss-120b` | `GROQ_API_KEY` |
| `groq-openai` | `qwen/qwen3.8-27b` (through the generic OpenAI-compatible adapter) | `GROQ_API_KEY` |

### Examples

```bash
npm run dev -- -p "list the files in src/tools" --provider groq
npm run dev -- -p "which files mention getProvider?" --provider gemini
npm run dev -- -p "read src/agent/loop.ts and explain it in 3 bullets" --provider groq
npm run dev -- -p "summarize src/types.ts in one line" --provider groq --model qwen/qwen3.8-27b
```

### Reading the output

The model's text streams in as it's written. Between turns you'll see:

```
 grep                                                    ← a tool started
 3                                                       ← it finished: lines returned (or the error text)
  groq ... openai/gpt-oss-120b ... 723 ... 63 ... toolUse
  provider   model                 in    out   why it stopped
```

`in` and `out` are token counts. The stop reason is `toolUse` (it wants a tool, so the loop continues), `stop` (finished) or `length` (hit the reply length cap). The agent gives up after 20 model calls in one run.

## Tools

| Tool | What it does |
|---|---|
| `read` | Shows a text file with line numbers, 2000 lines at a time (`offset`/`limit` for other parts) |
| `ls` | Lists one folder; folders first; hidden entries only with `all` |
| `find` | Finds files by glob pattern in all subfolders, e.g. `*.ts`, `src/**/*.test.ts` |
| `grep` | Searches file contents with a regex; returns `file:line: text` |
| `stat` | Type, size, line count, modified time and permissions, without reading the file |
| `bash` | Runs a shell command in the working folder (60s timeout by default, max 600s) |

`find` and `grep` skip `.git` and `node_modules`. A single tool result is capped at 30,000 characters.

> **⚠️ `bash` runs whatever the model asks for, without asking you first.** Only run tasks you'd be comfortable seeing executed, and run the agent in a folder you don't mind it touching.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev -- -p "..."` | Run the agent |
| `npm run typecheck` | Type-check `src/` |
| `npm run smoke` | Offline checks: tools, agent loop (with a fake model), provider registry |
| `npm run smoke:live` | The same, plus a real round trip per provider with a key |
| `npm run check` | `typecheck` + `smoke` |
