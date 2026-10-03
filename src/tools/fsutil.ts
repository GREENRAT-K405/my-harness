/**
 * Shared helpers for the tools: reading arguments, resolving paths,
 * walking directories, spotting binary files and trimming long output.
 */
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Folders that are never worth searching: huge, generated, or git internals. */
export const IGNORED_DIRS = new Set([".git", "node_modules"]);

/** Hard cap on what one tool call sends back to the model (characters). */
export const MAX_OUTPUT_CHARS = 30_000;

/** Reads a required string argument, or throws a message the model can act on. */
export function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v === "") throw new Error(`"${name}" is required and must be a non-empty string`);
  return v;
}

/** Reads an optional string argument. */
export function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`"${name}" must be a string`);
  return v;
}

/** Reads an optional whole-number argument and checks it's at least `min`. */
export function optionalInt(args: Record<string, unknown>, name: string, min = 0): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new Error(`"${name}" must be a whole number >= ${min}`);
  }
  return v;
}

/** Reads an optional true/false argument. */
export function optionalBool(args: Record<string, unknown>, name: string): boolean | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new Error(`"${name}" must be true or false`);
  return v;
}

/** Turns a path from the model into an absolute one: relative to the current folder, and `~` means home. */
export function resolvePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return path.resolve(process.cwd(), p);
}

/** Shows a path relative to the current folder when it's inside it, so output stays short. */
export function displayPath(abs: string): string {
  const rel = path.relative(process.cwd(), abs);
  if (rel === "") return ".";
  return !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
}

/**
 * Guesses whether a file is binary by looking for a zero byte in its first 8 KB.
 * Text files basically never contain one; images, archives and executables do.
 */
export async function isBinaryFile(file: string): Promise<boolean> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

/**
 * Walks a folder tree and yields every file and folder under it (not the root itself),
 * skipping IGNORED_DIRS. Folders it can't read are skipped quietly.
 */
export async function* walk(root: string): AsyncGenerator<{ path: string; isDir: boolean }> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  // sort so results come out in the same order every time
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      yield { path: full, isDir: true };
      yield* walk(full);
    } else {
      yield { path: full, isDir: false };
    }
  }
}

/**
 * Keeps output under `max` characters by cutting the middle.
 * The start and the end are usually the useful parts (e.g. a command's errors are at the end).
 */
export function truncateMiddle(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n[... ${s.length - max} characters cut ...]\n\n${s.slice(-half)}`;
}

/** Shortens a single line that's too long to be useful (e.g. minified code). */
export function truncateLine(line: string, max = 500): string {
  return line.length <= max ? line : `${line.slice(0, max)}... [${line.length - max} more chars]`;
}
