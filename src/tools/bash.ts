/**
 * `bash` tool: runs a shell command in the working directory and returns its output.
 */
import { spawn } from "node:child_process";
import type { Tool } from "../types.ts";
import { optionalInt, requireString, truncateMiddle } from "./fsutil.ts";

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command with bash in the working directory and return its combined stdout and stderr. " +
    "The command can't be interactive (there's no keyboard input). " +
    `Times out after ${DEFAULT_TIMEOUT_S}s unless you set timeout (max ${MAX_TIMEOUT_S}s). ` +
    "Prefer the read, ls, find and grep tools for looking at files.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      timeout: { type: "integer", description: `Seconds before the command is killed (default ${DEFAULT_TIMEOUT_S})` },
    },
    required: ["command"],
  },

  execute(args) {
    const command = requireString(args, "command");
    const timeoutS = Math.min(optionalInt(args, "timeout", 1) ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);

    return new Promise((resolve, reject) => {
      // "exec 2>&1" sends stderr into stdout inside bash, so errors and output stay in the real order
      const child = spawn("bash", ["-c", `exec 2>&1\n${command}`], {
        cwd: process.cwd(),
        // stdin is closed, so a command waiting for input gets EOF instead of hanging
        stdio: ["ignore", "pipe", "pipe"],
        // own process group, so on timeout we can kill the command *and* anything it started
        detached: true,
      });

      // stderr was merged into stdout above; still collect stderr in case bash itself complains
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL"); // negative pid = the whole process group
        } catch {}
      }, timeoutS * 1000);

      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const body = truncateMiddle(output.trimEnd()) || "(no output)";
        if (timedOut) reject(new Error(`${body}\n\ncommand timed out after ${timeoutS}s and was killed`));
        else if (code !== 0) reject(new Error(`${body}\n\nexit code ${code ?? signal}`));
        else resolve(body);
      });
    });
  },
};
