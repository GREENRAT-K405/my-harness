/**
 * `find` tool: finds files whose path matches a glob pattern, searching all subfolders.
 */
import path from "node:path";
import type { Tool } from "../types.ts";
import { IGNORED_DIRS, displayPath, optionalString, requireString, resolvePath, walk } from "./fsutil.ts";

/** Stop after this many matches, so a broad pattern can't flood the model. */
const MAX_RESULTS = 1000;

export const findTool: Tool = {
  name: "find",
  description:
    "Find files by name or path using a glob pattern, searching all subfolders. " +
    "Examples: '*.ts' (any .ts file at any depth), 'src/**/*.test.ts', '**/package.json'. " +
    `Skips ${[...IGNORED_DIRS].join(" and ")}.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match against file paths" },
      path: { type: "string", description: "Folder to search in (default: the working directory)" },
    },
    required: ["pattern"],
  },

  async execute(args) {
    const pattern = requireString(args, "pattern");
    const root = resolvePath(optionalString(args, "path") ?? ".");

    // a pattern without "/" like "*.ts" is matched against the file name, so it works at any depth
    const byName = !pattern.includes("/");

    const results: string[] = [];
    let total = 0;
    for await (const entry of walk(root)) {
      if (entry.isDir) continue;
      // glob patterns always use "/", even on Windows
      const rel = path.relative(root, entry.path).split(path.sep).join("/");
      const target = byName ? path.basename(rel) : rel;
      if (!path.matchesGlob(target, pattern)) continue;
      total++;
      if (results.length < MAX_RESULTS) results.push(displayPath(entry.path));
    }

    if (total === 0) return `no files matching "${pattern}" in ${displayPath(root)}`;
    if (total > MAX_RESULTS) results.push(`\n[showing ${MAX_RESULTS} of ${total} matches; use a narrower pattern or path]`);
    return results.join("\n");
  },
};
