/**
 * `ls` tool: lists what's inside one folder (not recursive).
 */
import { readdir } from "node:fs/promises";
import type { Tool } from "../types.ts";
import { displayPath, optionalBool, optionalString, resolvePath } from "./fsutil.ts";

/** Stop listing after this many entries, so a huge folder can't flood the model. */
const MAX_ENTRIES = 500;

export const lsTool: Tool = {
  name: "ls",
  description:
    "List the files and folders directly inside a folder. Folders end with '/'. " +
    "Hidden entries (starting with '.') are left out unless all is true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Folder to list (default: the working directory)" },
      all: { type: "boolean", description: "Include hidden entries" },
    },
  },

  async execute(args) {
    const dir = resolvePath(optionalString(args, "path") ?? ".");
    const all = optionalBool(args, "all") ?? false;

    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => all || !e.name.startsWith("."))
      // folders first, then files, each alphabetically
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    if (entries.length === 0) return `(${displayPath(dir)} is empty)`;

    const out = entries
      .slice(0, MAX_ENTRIES)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name}@` : e.name));
    if (entries.length > MAX_ENTRIES) out.push(`\n[showing ${MAX_ENTRIES} of ${entries.length} entries]`);
    return out.join("\n");
  },
};
