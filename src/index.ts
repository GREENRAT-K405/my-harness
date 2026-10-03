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

// The whole conversation. The model only knows what's in here.
const messages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }];

type ToolCall={id: string; name: string; args: string};

// cap on output tokens per model call
const MAX_TOKENS = 1024;

// Calls the model, prints text as it streams in, and returns the full text + tool calls.
async function callModel(){
    const stream=await client.chat.completions.create({
        model:MODEL,
        messages: messages,
        tools: TOOLS,
        stream: true,
        max_completion_tokens: MAX_TOKENS,
        stream_options: { include_usage: true }, // final chunk carries token usage
    });

    let text ="";
    const calls: ToolCall[]=[];
    let stopReason: string | null = null;
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

    // printing text/message
    for await (const chunk of stream){
        // usage comes on the last chunk (Groq also puts it under x_groq)
        usage = chunk.usage ?? (chunk as any).x_groq?.usage ?? usage;
        stopReason = chunk.choices[0]?.finish_reason ?? stopReason;

        const delta = chunk.choices[0]?.delta;
        if(!delta) continue;

        if(delta.content){
            process.stdout.write(delta.content);
            text+=delta.content;
        }
    


    // tool calls arrive in pieces. 'index' says which call a piece belongs to.
    for(const piece of delta.tool_calls ?? []){
        calls[piece.index] ??= {id: "", name: "", args: ""};
        const call = calls[piece.index];
        if(piece.id)    call.id=piece.id;
        if(piece.function?.name) call.name=piece.function.name;
        if(piece.function?.arguments)    call.args += piece.function.arguments;
        }
    }
    if(text)    process.stdout.write("\n");

    console.log(
        `[stop: ${stopReason ?? "?"} | in: ${usage?.prompt_tokens ?? "?"} | out: ${usage?.completion_tokens ?? "?"}/${MAX_TOKENS} | total: ${usage?.total_tokens ?? "?"}]`
    );
    return { text, calls };
}


async function agentTurn(){
  while (true) {

    const { text, calls } = await callModel();

    messages.push({
        role: "assistant",
        content: text || null,
        tool_calls : calls.length ? calls.map((c) => ({ id: c.id, type: "function", function:{
            name: c.name, arguments:c.args
        }})) : undefined,
    });

    if(calls.length === 0) return;

    for(const call of calls){
        let args = {}
        try{
            args=JSON.parse(call.args);
        }catch{
            // Bad JSON: leave args empty and runTool will tell the model.
        }

        const output = await runTool(call.name, args, process.cwd());
        messages.push({role: "tool", tool_call_id: call.id, content: output});
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