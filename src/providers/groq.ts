/**
 * Provider for Groq, using the official `groq-sdk`.
 *
 * Groq's API is shaped like OpenAI's Chat Completions, so the translation is the
 * same as in `openai-compat.ts`. Using Groq's own SDK gets us the Groq-only bits:
 * token usage arrives under `x_groq`, and reasoning can be kept out of the answer.
 */
import Groq from "groq-sdk";
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import type { ContentBlock, Message, Provider, StopReason, Usage } from "../types.ts";

/**
 * Converts our conversation into Groq's (OpenAI-style) format.
 *
 * Differences from our format:
 * - An assistant message has one `content` string plus a separate `tool_calls` list,
 *   instead of a list of blocks.
 * - Tool arguments are a JSON *string*, not an object.
 * - A tool result is its own message with role `"tool"`. There's no error flag,
 *   so failed results get an "Error:" prefix instead.
 */
function toGroq(messages: Message[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "assistant") {
      // split our blocks into "all the text" and "all the tool calls"
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = m.content.filter((b) => b.type === "toolCall");
      return {
        role: "assistant",
        content: text || null,
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
 * Creates the Groq provider. The SDK reads the API key from `GROQ_API_KEY`.
 *
 * `stream()` yields a `text_delta` event for each piece of text as it arrives,
 * then one `done` event with the complete assistant message.
 */
export function createGroq(): Provider {
  const client = new Groq({ maxRetries: 3 });
  return {
    name: "groq",
    defaultModel: "openai/gpt-oss-120b",
    async *stream({ messages, model, system, tools = [] }) {
      const chat = toGroq(messages);
      const stream = await client.chat.completions.create({
        model,
        stream: true,
        max_completion_tokens: 4096,
        // keep the model's private reasoning out of the reply (otherwise some models put <think> tags in the text)
        include_reasoning: false,
        // no separate system field: the system prompt is the first message
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
        const choice = chunk.choices[0];
        if (choice?.delta?.content) {
          text += choice.delta.content;
          yield { type: "text_delta", delta: choice.delta.content };
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          // the first piece of a call brings id + name, later pieces only bring more arguments
          calls[tc.index] ??= { id: tc.id ?? `call_${tc.index}`, name: tc.function?.name ?? "", args: "" };
          calls[tc.index].args += tc.function?.arguments ?? "";
        }
        // map Groq's finish_reason onto our three: toolUse / length / stop
        if (choice?.finish_reason === "tool_calls") stopReason = "toolUse";
        else if (choice?.finish_reason === "length") stopReason = "length";
        // Groq sends usage on the last chunk, under its own "x_groq" field
        const u = chunk.x_groq?.usage;
        if (u) usage = { input: u.prompt_tokens, output: u.completion_tokens };
      }

      // build the final message: text first, then each tool call with its JSON parsed into an object
      const content: ContentBlock[] = text ? [{ type: "text", text }] : [];
      for (const c of calls) {
        if (c) content.push({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ? JSON.parse(c.args) : {} });
      }
      // trust the content over finish_reason: if there's a tool call, the model wants it run
      if (content.some((b) => b.type === "toolCall")) stopReason = "toolUse";
      yield { type: "done", message: { role: "assistant", content, usage, stopReason } };
    },
  };
}
