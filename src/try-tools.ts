import { runTool } from "./tools.js";

console.log(await runTool("bash", { command: "echo hello" }, process.cwd()));
console.log(await runTool("bash", { command: "ls does-not-exist" }, process.cwd()));