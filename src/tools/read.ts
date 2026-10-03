/**
 * `read` tool: shows a text file with line numbers, a chunk at a time.
 */
import { readFile, stat } from "node:fs/promises";
import type { Tool } from "../types.ts";
import { displayPath, isBinaryFile, optionalInt, requireString, resolvePath, truncateLine } from "./fsutil.ts";

/** Lines returned when the model doesn't ask for a specific amount. */
const DEFAULT_LIMIT = 2000;

export const readTool: Tool = {
  name: "read",
  description:
    "Read a text file. Returns lines prefixed with their line number. " +
    `Reads up to ${DEFAULT_LIMIT} lines by default; use offset and limit to read other parts of long files.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to read, absolute or relative to the working directory" },
      offset: { type: "integer", description: "Line number to start from (1 = first line)" },
      limit: { type: "integer", description: "How many lines to read" },
    },
    required: ["path"],
  },

  async execute(args) {
    const file = resolvePath(requireString(args, "path"));
    const offset = optionalInt(args, "offset", 1) ?? 1;
    const limit = optionalInt(args, "limit", 1) ?? DEFAULT_LIMIT;

    const info = await stat(file);
    if (info.isDirectory()) throw new Error(`${displayPath(file)} is a directory; use the ls tool instead`);
    if (await isBinaryFile(file)) throw new Error(`${displayPath(file)} looks like a binary file; can't show it as text`);

    const text = await readFile(file, "utf8");
    if (text === "") return `(${displayPath(file)} is empty)`;

    // a trailing newline would otherwise show up as an extra empty last line
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    if (offset > lines.length) {
      throw new Error(`offset ${offset} is past the end of the file (${lines.length} lines)`);
    }

    const end = Math.min(offset - 1 + limit, lines.length);
    // pad numbers to the same width so the code lines up: "  9│", " 10│"
    const width = String(end).length;
    const out = lines
      .slice(offset - 1, end)
      .map((line, i) => `${String(offset + i).padStart(width)}│${truncateLine(line, 2000)}`);

    // tell the model there's more, and exactly how to get it
    if (end < lines.length) {
      out.push(`\n[showing lines ${offset}-${end} of ${lines.length}; use offset=${end + 1} to continue]`);
    }
    return out.join("\n");
  },
};
