/**
 * Parses a tool call's arguments from the JSON text a model streamed.
 *
 * Models sometimes send broken JSON. Instead of crashing the whole run, bad JSON
 * (or JSON that isn't an object) becomes `{}`: the tool then throws a clear
 * "is required" error, the loop sends it back, and the model can retry.
 */
export function parseToolArgs(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
