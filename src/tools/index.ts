/**
 * Every tool the agent can use. Pass `tools` to the agent loop; it sends their
 * name, description and parameters to the model, and calls `execute` when the model asks.
 */
import type { Tool } from "../types.ts";
import { bashTool } from "./bash.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import { statTool } from "./stat.ts";

export { bashTool, findTool, grepTool, lsTool, readTool, statTool };

export const tools: Tool[] = [readTool, lsTool, findTool, grepTool, statTool, bashTool];
