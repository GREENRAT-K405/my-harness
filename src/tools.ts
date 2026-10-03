import { exec } from "node:child_process"
import { promisify } from "node:util"
import { createInterface } from "node:readline/promises"
import type { ChatCompletionTool } from "openai/resources/chat/completions"

const execAsync = promisify(exec)
const MAX_CHARS = 4000

// list of tools model can call
export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a non-interactive shell command in the working directory. 60s timeout.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

// truncates output to avoid sending too much data back to the model
function truncate(s: string): string {
  if (s.length <= MAX_CHARS) return s;
  const half = MAX_CHARS / 2;
  return `${s.slice(0, half)}\n[... ${s.length - MAX_CHARS} chars cut ...]\n${s.slice(-half)}`;
}

async function approve(command: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nRun: ${command}\nAllow? [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

export async function runTool(name: string, args: { command?: string }, cwd: string): Promise<string> {
  if (name !== "bash" || !args.command) return "Error: unknown tool or missing arguments.";
  if (!(await approve(args.command))) return "The user denied this command.";
  try {
    const { stdout, stderr } = await execAsync(args.command, { cwd, timeout: 60_000 });
    return truncate(`exit code: 0\n${stdout}${stderr}`);
  } catch (e: any) {
    return truncate(`exit code: ${e.code ?? "?"}\n${e.stdout ?? ""}${e.stderr ?? e.message}`);
  }
}



// exposes tools and runTool