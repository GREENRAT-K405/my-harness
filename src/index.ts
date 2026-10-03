// import OpenAI from "openai";

// const client = new OpenAI({
//   apiKey: process.env.GROQ_API_KEY,
//   baseURL: "https://api.groq.com/openai/v1",
// });

// //basic testing
// const res = await client.chat.completions.create({
//   model: "openai/gpt-oss-120b",
//   messages: [{ role: "user", content: "what is 5+5" }],
// });

// console.log(res.choices[0].message);


import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { client, MODEL } from "./client.js";
import { TOOLS, runTool } from "./tools.js";
import { createInterface } from "node:readline/promises";


// a system prompt
const SYSTEM_PROMPT = `You are a coding agent working in ${process.cwd()}.
Use the bash tool to explore and edit files. Keep answers short.`;

// chatcompletionmessageparam is just a typescript type for messages
const messages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }];



async function agentTurn(): Promise<void> {
  while (true) {
    const res = await client.chat.completions.create({ model: MODEL, messages, tools: TOOLS });
    const msg = res.choices[0].message;

    messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
    if (msg.content) console.log(`\n${msg.content}`);

    if (!msg.tool_calls?.length) return;

    for (const call of msg.tool_calls) {
      // every tool_call_id needs a matching tool message, or the next request is rejected
      if (call.type !== "function") {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Error: unsupported tool call type." });
        continue;
      }
      let args = {};
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Error: tool arguments were not valid JSON." });
        continue;
      }
      const output = await runTool(call.function.name, args, process.cwd());
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
}

// prompt with a short-lived interface so it doesn't fight approve()'s interface for stdin
async function prompt(query: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(query);
  } finally {
    rl.close();
  }
}

while (true) {
  const input = (await prompt("\n> ")).trim();
  if (input === "exit") break;
  if (!input) continue;
  messages.push({ role: "user", content: input });
  try {
    await agentTurn();
  } catch (e: any) {
    console.error(`\nError: ${e.message ?? e}`);
  }
}