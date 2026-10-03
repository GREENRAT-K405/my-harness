/**
 * Provider for any API that speaks OpenAI's Chat Completions format, using the `openai` SDK.
 *
 * OpenAI, Groq, and Anthropic's compatibility endpoint all accept this format,
 * so one adapter covers them all; only the base URL, API key and model differ.
 */
import OpenAI from "openai";
import type { ContentBlock, Message, Provider, StopReason, Usage } from "../types.ts";
import { parseToolArgs } from "./parse-args.ts";

/**
 * Converts our conversation into OpenAI's format.
 *
 * Differences from our format:
 * - An assistant message has one `content` string plus a separate `tool_calls` list,
 *   instead of a list of blocks.
 * - Tool arguments are a JSON *string*, not an object.
 * - A tool result is its own message with role `"tool"`. There's no error flag,
 *   so failed results get an "Error:" prefix instead.
 */
function toOpenAI(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.ChatCompletionMessageParam => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "assistant") {
      // split our blocks into "all the text" and "all the tool calls"
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = m.content.filter((b) => b.type === "toolCall");
      return {
        role: "assistant",
        content: text || null,
        // OpenAI wants the arguments as a JSON *string*
        tool_calls: calls.length
          ? calls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            }))
          : undefined,
      };
    }
    // toolResult -> its own message with role "tool"
    return { role: "tool", tool_call_id: m.toolCallId, content: m.isError ? `Error: ${m.content}` : m.content };
  });
}

/**
 * Creates a provider for an OpenAI-compatible API.
 *
 * @param name         Name this provider reports (e.g. "groq").
 * @param baseURL      The API's address, e.g. "https://api.groq.com/openai/v1".
 * @param apiKey       Key for that API.
 * @param defaultModel Model to use when the caller doesn't pick one.
 *
 * `stream()` yields a `text_delta` event for each piece of text as it arrives,
 * then one `done` event with the complete assistant message.
 */
// one adapter for every OpenAI-compatible API: only baseURL, key and model change
export function createOpenAICompat(name: string, baseURL: string, apiKey: string | undefined, defaultModel: string): Provider {
  const client = new OpenAI({ baseURL, apiKey });
  return {
    name,
    defaultModel,
    async *stream({ messages, model, system, tools = [] }) {
      const chat = toOpenAI(messages);
      const stream = await client.chat.completions.create({
        model,
        stream: true,
        max_completion_tokens: 4096,
        stream_options: { include_usage: true }, // usage comes in the last chunk
        // OpenAI has no separate system field: the system prompt is the first message
        messages: system ? [{ role: "system", content: system }, ...chat] : chat,
        tools: tools.length
          ? tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            }))
          : undefined,
      });
      let text = "";
      const calls: { id: string; name: string; args: string }[] = []; // slot = tool_calls[].index
      let usage: Usage = { input: 0, output: 0 };
      let stopReason: StopReason = "stop";

      // Each chunk carries a small "delta": a bit of text and/or pieces of tool calls.
      for await (const chunk of stream) {
        const choice = chunk.choices[0]; // empty on the final usage-only chunk
        if (choice?.delta?.content) {
          text += choice.delta.content;
          yield { type: "text_delta", delta: choice.delta.content };
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          // the first piece of a call brings id + name, later pieces only bring more arguments
          calls[tc.index] ??= { id: tc.id ?? `call_${tc.index}`, name: tc.function?.name ?? "", args: "" };
          calls[tc.index].args += tc.function?.arguments ?? "";
        }
        // map OpenAI's finish_reason onto our three: toolUse / length / stop
        if (choice?.finish_reason === "tool_calls") stopReason = "toolUse";
        else if (choice?.finish_reason === "length") stopReason = "length";
        // standard place is chunk.usage; Groq may put it under its own "x_groq" field instead
        const u = chunk.usage ?? (chunk as any).x_groq?.usage;
        if (u) usage = { input: u.prompt_tokens, output: u.completion_tokens };
      }

      // build the final message: text first, then each tool call with its JSON parsed into an object
      const content: ContentBlock[] = text ? [{ type: "text", text }] : [];
      for (const c of calls) {
        if (c) content.push({ type: "toolCall", id: c.id, name: c.name, arguments: parseToolArgs(c.args) });
      }
      // some servers say "stop" even when they called a tool, so trust the content
      if (content.some((b) => b.type === "toolCall")) stopReason = "toolUse";
      yield { type: "done", message: { role: "assistant", content, usage, stopReason } };
    },
  };
}
