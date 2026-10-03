/**
 * Smoke test: checks that tools, providers and the agent loop are wired together.
 *
 *   npm run smoke        offline checks only (no network, no API cost)
 *   npm run smoke:live   also does one real tool-call round trip per provider that has an API key
 *
 * Exits with code 1 if anything fails, so it can gate a commit or CI.
 */
import { config } from "dotenv";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, type AgentEvent } from "../src/agent/loop.ts";
import { getProvider } from "../src/providers/index.ts";
import { parseToolArgs } from "../src/providers/parse-args.ts";
import { tools } from "../src/tools/index.ts";
import type { AssistantMessage, Message, Provider, StreamEvent, Tool } from "../src/types.ts";

config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });
const LIVE = process.argv.includes("--live");

// ---------- tiny test runner ----------

let passed = 0, failed = 0, skipped = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${(e as Error).message.split("\n").join("\n      ")}`);
  }
}

function skip(name: string, why: string) {
  skipped++;
  console.log(`  \x1b[33m-\x1b[0m ${name} \x1b[2m(skipped: ${why})\x1b[0m`);
}

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const tool = (name: string) => {
  const t = tools.find((t) => t.name === name);
  expect(t, `tool "${name}" is not in tools/index.ts`);
  return t;
};

/** Runs a tool and returns [output, threw?] so both success and error paths can be checked. */
async function exec(name: string, args: Record<string, unknown>): Promise<[string, boolean]> {
  try {
    return [await tool(name).execute(args), false];
  } catch (e) {
    return [(e as Error).message, true];
  }
}

// ---------- 1. tools, against a throwaway folder ----------

console.log("\nTools");
const sandbox = await mkdtemp(path.join(tmpdir(), "harness-smoke-"));
const startDir = process.cwd();
await mkdir(path.join(sandbox, "src/deep"), { recursive: true });
await mkdir(path.join(sandbox, "node_modules/junk"), { recursive: true });
await writeFile(path.join(sandbox, "src/a.ts"), "export const answer = 42;\nconsole.log(answer);\n");
await writeFile(path.join(sandbox, "src/deep/b.ts"), "// TODO: fix me\n");
await writeFile(path.join(sandbox, "node_modules/junk/c.ts"), "TODO in node_modules\n");
await writeFile(path.join(sandbox, "notes.md"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
await writeFile(path.join(sandbox, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
process.chdir(sandbox); // tools work relative to the current folder

try {
  await check("index exports read, ls, find, grep, stat, bash", () => {
    const names = tools.map((t) => t.name).sort().join(",");
    expect(names === "bash,find,grep,ls,read,stat", `got: ${names}`);
  });
  await check("every tool has a description and an object schema", () => {
    for (const t of tools) expect(t.description && t.parameters.type === "object", `${t.name} is missing description/schema`);
  });

  await check("read: numbered lines + offset/limit + 'continue' hint", async () => {
    const [out] = await exec("read", { path: "notes.md", offset: 10, limit: 2 });
    expect(out.includes("10│line 10") && out.includes("11│line 11") && out.includes("offset=12"), out);
  });
  await check("read: refuses binary files and folders", async () => {
    expect((await exec("read", { path: "image.bin" }))[1], "binary file was read");
    expect((await exec("read", { path: "src" }))[1], "folder was read");
  });
  await check("ls: folders first with '/'", async () => {
    const [out] = await exec("ls", {});
    expect(out.split("\n")[0].endsWith("/") && out.includes("notes.md"), out);
  });
  await check("find: '*.ts' matches at any depth, skips node_modules", async () => {
    const [out] = await exec("find", { pattern: "*.ts" });
    expect(out.includes("src/a.ts") && out.includes("src/deep/b.ts") && !out.includes("node_modules"), out);
  });
  await check("grep: finds matches with line numbers, skips node_modules", async () => {
    const [out] = await exec("grep", { pattern: "TODO" });
    expect(out.includes("src/deep/b.ts:1:") && !out.includes("node_modules"), out);
  });
  await check("grep: bad regex is an error, not a crash", async () => {
    expect((await exec("grep", { pattern: "([" }))[1], "no error for bad regex");
  });
  await check("stat: reports type, size and lines", async () => {
    const [out] = await exec("stat", { path: "notes.md" });
    expect(out.includes("type: file") && out.includes("lines: 50"), out);
  });
  await check("bash: returns output, runs in the working folder", async () => {
    const [out, err] = await exec("bash", { command: "echo hi; pwd" });
    expect(!err && out.includes("hi") && out.includes(path.basename(sandbox)), out);
  });
  await check("bash: non-zero exit is an error with the exit code", async () => {
    const [out, err] = await exec("bash", { command: "exit 3" });
    expect(err && out.includes("exit code 3"), out);
  });
  await check("bash: timeout kills the command", async () => {
    const t0 = Date.now();
    const [out, err] = await exec("bash", { command: "sleep 20", timeout: 1 });
    expect(err && out.includes("timed out") && Date.now() - t0 < 5000, out);
  });
  await check("missing required argument is an error", async () => {
    expect((await exec("read", {}))[1], "read with no path didn't fail");
  });
} finally {
  process.chdir(startDir);
  await rm(sandbox, { recursive: true, force: true });
}

// ---------- 2. agent loop, with a fake provider (no network) ----------

console.log("\nAgent loop (fake provider)");

/** A provider that replays a fixed script of replies, and records what it was sent. */
function fakeProvider(replies: AssistantMessage[]): Provider & { seen: Message[][] } {
  const seen: Message[][] = [];
  return {
    name: "fake",
    defaultModel: "fake-model",
    seen,
    async *stream({ messages }): AsyncIterable<StreamEvent> {
      seen.push(structuredClone(messages));
      const reply = replies.shift();
      if (!reply) throw new Error("fake provider ran out of replies");
      for (const b of reply.content) if (b.type === "text") yield { type: "text_delta", delta: b.text };
      yield { type: "done", message: reply };
    },
  };
}

const usage = { input: 1, output: 1 };
const echoTool: Tool = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: {} },
  async execute(args) { return `echoed ${JSON.stringify(args)}`; },
};

await check("tool call -> tool runs -> result sent back -> final answer", async () => {
  const provider = fakeProvider([
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { x: 1 } }], usage, stopReason: "toolUse" },
    { role: "assistant", content: [{ type: "text", text: "done!" }], usage, stopReason: "stop" },
  ]);
  const messages: Message[] = [{ role: "user", content: "go" }];
  const events: AgentEvent["type"][] = [];
  await runAgent({ provider, model: "m", tools: [echoTool], messages, onEvent: (e) => events.push(e.type) });

  expect(provider.seen.length === 2, `expected 2 model calls, got ${provider.seen.length}`);
  const result = provider.seen[1].at(-1);
  expect(result?.role === "toolResult" && result.toolCallId === "c1" && result.content === 'echoed {"x":1}' && !result.isError,
    `2nd call didn't end with the tool result: ${JSON.stringify(result)}`);
  expect(messages.length === 4, `expected user, assistant, toolResult, assistant; got ${messages.map((m) => m.role)}`);
  for (const t of ["tool_start", "tool_end", "text", "turn_end"] as const) expect(events.includes(t), `no "${t}" event`);
});

await check("unknown tool -> error result goes back to the model, loop continues", async () => {
  const provider = fakeProvider([
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "nope", arguments: {} }], usage, stopReason: "toolUse" },
    { role: "assistant", content: [{ type: "text", text: "ok" }], usage, stopReason: "stop" },
  ]);
  await runAgent({ provider, model: "m", tools: [echoTool], messages: [{ role: "user", content: "go" }], onEvent() {} });
  const result = provider.seen[1].at(-1);
  expect(result?.role === "toolResult" && result.isError, `expected an error result, got ${JSON.stringify(result)}`);
  expect(result.content.includes("nope"), `error should name the unknown tool, got: "${result.content}"`);
});

await check("stops after maxTurns instead of looping forever", async () => {
  const call: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", id: "c", name: "echo", arguments: {} }], usage, stopReason: "toolUse" };
  const provider = fakeProvider([call, call, call]);
  let threw = false;
  try {
    await runAgent({ provider, model: "m", tools: [echoTool], messages: [{ role: "user", content: "go" }], maxTurns: 2, onEvent() {} });
  } catch {
    threw = true;
  }
  expect(threw && provider.seen.length === 2, `threw=${threw}, model calls=${provider.seen.length}`);
});

await check("malformed tool JSON becomes {} instead of crashing", () => {
  expect(JSON.stringify(parseToolArgs('{"path": "a.ts"}')) === '{"path":"a.ts"}', "valid JSON wasn't parsed");
  for (const bad of ['{"path": "a.t', "", "null", "[1,2]", "42"]) {
    expect(JSON.stringify(parseToolArgs(bad)) === "{}", `parseToolArgs(${JSON.stringify(bad)}) should be {}`);
  }
});

// ---------- 3. provider registry ----------

console.log("\nProviders");
const PROVIDERS: { name: string; key: string }[] = [
  { name: "anthropic", key: "ANTHROPIC_API_KEY" },
  { name: "anthropic-openai", key: "ANTHROPIC_API_KEY" },
  { name: "gemini", key: "GEMINI_API_KEY" },
  { name: "groq", key: "GROQ_API_KEY" },
  { name: "groq-openai", key: "GROQ_API_KEY" },
];

// the "unknown provider" error lists every registered name, so use it to see what's registered
let registryError = "";
try { getProvider("nope"); } catch (e) { registryError = (e as Error).message; }

await check("unknown provider name throws a helpful error", () => {
  expect(registryError.includes("Available:"), `error should list the available providers, got: "${registryError}"`);
});
for (const { name, key } of PROVIDERS) {
  // some SDKs refuse to even start without a key, so only build providers we have keys for
  if (!process.env[key]) {
    await check(`${name}: registered`, () => expect(registryError.includes(name), `"${name}" isn't in providers/index.ts`));
    continue;
  }
  await check(`${name}: registered and builds`, () => {
    const p = getProvider(name);
    expect(p.name === name && p.defaultModel, `${name}: bad name/defaultModel`);
  });
}

// ---------- 4. live round trip per provider (opt-in) ----------

console.log(`\nLive round trip${LIVE ? "" : " (run with --live to enable)"}`);

// a harmless tool with a value the model can't guess, so we know it really called it
const SECRET = `pineapple-${Math.floor(Math.random() * 9000 + 1000)}`;
const secretTool: Tool = {
  name: "get_secret_word",
  description: "Returns today's secret word.",
  parameters: { type: "object", properties: {} },
  async execute() { return SECRET; },
};

for (const { name, key } of PROVIDERS) {
  const label = `${name}: calls a tool and uses its result`;
  if (!LIVE) { skip(label, "offline"); continue; }
  if (!process.env[key]) { skip(label, `no ${key} in .env`); continue; }
  await check(label, async () => {
    const provider = getProvider(name);
    const messages: Message[] = [{ role: "user", content: "Call get_secret_word, then reply with only the word it returns." }];
    let usageSeen = false;
    await runAgent({
      provider, model: provider.defaultModel, tools: [secretTool], messages, maxTurns: 4,
      onEvent(e) { if (e.type === "turn_end" && e.message.usage.input > 0) usageSeen = true; },
    });
    const called = messages.some((m) => m.role === "toolResult" && m.content === SECRET);
    const last = messages.at(-1);
    const answer = last?.role === "assistant" ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
    expect(called, "the model never called the tool");
    expect(answer.includes(SECRET), `final answer doesn't contain the secret: "${answer}"`);
    expect(usageSeen, "token usage was 0 (usage isn't being read)");
  });
}

// ---------- summary ----------

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed ? 1 : 0);
