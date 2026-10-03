/**
 * `stat` tool: shows facts about a file or folder (type, size, dates, permissions)
 * without reading its contents.
 */
import { lstat, readFile, readlink } from "node:fs/promises";
import type { Tool } from "../types.ts";
import { displayPath, isBinaryFile, requireString, resolvePath } from "./fsutil.ts";

/** Turns a byte count into something readable, e.g. 1536 -> "1.5 KB". */
function humanSize(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return u === 0 ? `${n} bytes` : `${n.toFixed(1)} ${units[u]}`;
}

export const statTool: Tool = {
  name: "stat",
  description:
    "Get information about a file or folder without reading it: type, size, line count for text files, " +
    "last modified time and permissions. Also handy to check whether a path exists.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or folder to inspect" },
    },
    required: ["path"],
  },

  async execute(args) {
    const target = resolvePath(requireString(args, "path"));
    // lstat (not stat) so a symlink is reported as a symlink rather than followed
    const info = await lstat(target);

    const type = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
    const out = [`path: ${displayPath(target)}`, `type: ${type}`];

    if (info.isSymbolicLink()) out.push(`points to: ${await readlink(target)}`);
    if (info.isFile()) {
      out.push(`size: ${humanSize(info.size)}`);
      // line counts only make sense for text, and big files aren't worth loading just to count
      if (info.size <= 10 * 1024 * 1024) {
        if (await isBinaryFile(target)) out.push("content: binary");
        else {
          const text = await readFile(target, "utf8");
          const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
          out.push(`lines: ${lines}`);
        }
      }
    }
    out.push(`modified: ${info.mtime.toISOString()}`);
    // last 3 octal digits are the familiar unix permissions, e.g. 644 or 755
    out.push(`permissions: ${(info.mode & 0o777).toString(8)}`);
    return out.join("\n");
  },
};
