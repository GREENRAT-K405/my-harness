/**
 * `grep` tool: searches file contents for a regular expression and returns matching lines.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../types.ts";
import {
  IGNORED_DIRS,
  displayPath,
  isBinaryFile,
  optionalBool,
  optionalInt,
  optionalString,
  requireString,
  resolvePath,
  truncateLine,
  walk,
} from "./fsutil.ts";

const DEFAULT_LIMIT = 100;

/** Skip files bigger than this; they're almost always generated or data, not code. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents for a regular expression (JavaScript syntax). " +
    "Returns matches as 'file:line: text'. Searches all subfolders of path, or just one file if path is a file. " +
    `Skips binary files, files over 2 MB, and ${[...IGNORED_DIRS].join(" and ")}.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for" },
      path: { type: "string", description: "File or folder to search (default: the working directory)" },
      glob: { type: "string", description: "Only search files whose name matches this glob, e.g. '*.ts'" },
      ignoreCase: { type: "boolean", description: "Match upper and lower case the same" },
      limit: { type: "integer", description: `Maximum matches to return (default ${DEFAULT_LIMIT})` },
    },
    required: ["pattern"],
  },

  async execute(args) {
    const pattern = requireString(args, "pattern");
    const root = resolvePath(optionalString(args, "path") ?? ".");
    const glob = optionalString(args, "glob");
    const limit = optionalInt(args, "limit", 1) ?? DEFAULT_LIMIT;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, optionalBool(args, "ignoreCase") ? "i" : "");
    } catch (e) {
      throw new Error(`invalid regular expression: ${(e as Error).message}`);
    }

    // which files to search: just the one, or every file under the folder
    const files: string[] = [];
    if ((await stat(root)).isFile()) {
      files.push(root);
    } else {
      for await (const entry of walk(root)) {
        if (entry.isDir) continue;
        if (glob && !path.matchesGlob(path.basename(entry.path), glob)) continue;
        files.push(entry.path);
      }
    }

    const matches: string[] = [];
    let total = 0;
    for (const file of files) {
      try {
        if ((await stat(file)).size > MAX_FILE_BYTES || (await isBinaryFile(file))) continue;
      } catch {
        continue; // vanished or unreadable since we listed it
      }
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (!regex.test(line)) return;
        total++;
        if (matches.length < limit) matches.push(`${displayPath(file)}:${i + 1}: ${truncateLine(line.trim())}`);
      });
    }

    if (total === 0) return `no matches for /${pattern}/ in ${displayPath(root)}`;
    if (total > limit) matches.push(`\n[showing ${limit} of ${total} matches; narrow the pattern, path or glob, or raise limit]`);
    return matches.join("\n");
  },
};
