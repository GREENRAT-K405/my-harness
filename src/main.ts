import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getProvider } from "./providers/index.ts";
import type { Message } from "./types.ts";
import { runAgent } from "./agent/loop.ts";
import { tools } from "./tools/index.ts";
// load the .env next to the code, so mypi works from any folder
config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

const { values } = parseArgs({
  options: {
    prompt: { type: "string", short: "p" },
    provider: { type: "string", default: "groq" },
    model: { type: "string" },
  },
});

if (!values.prompt) {
  console.error(
    `no prompt sirr, mypi -p "prompt" --provider groq OR gemini OR anthropic `,
  );
  process.exit(1);
}

// tells the model what it is and where it's working
const system = `You are a coding agent working in ${process.cwd()}.
Use read, ls, find, grep and stat to look at files, and bash to run commands.
Keep answers short.`;

const provider = getProvider(values.provider);
const model = values.model ?? provider.defaultModel;
const messages: Message[] = [{ role: "user", content: values.prompt }];

await runAgent({
  provider,
  model,
  system,
  tools,
  messages,
  onEvent(event) {
    if (event.type === "text") process.stdout.write(event.delta);
    else if (event.type == "tool_start") console.log(`\n ${event.call.name}`);
    else if (event.type == "tool_end") {
      const lines = event.result.split("\n").length;
      console.log(`\n ${event.isError ? event.result : lines}`);
    } else if (event.type === "turn_end") {
      const { usage, stopReason } = event.message;
      console.log(
        `\n\n  ${provider.name} ... ${model} ... ${usage.input} ... ${usage.output} ... ${stopReason}`,
      );
    }
  },
});
