/**
 * Provider for Google Gemini, using the official `@google/genai` SDK.
 *
 * Translates our shared message format (see `../types.ts`) into Gemini's
 * `Content`/`Part` format, streams the reply, and translates it back.
 */
import { GoogleGenAI, FinishReason, type Content, type Part } from "@google/genai";
import type { Provider, StopReason, Message, ContentBlock } from "../types.ts";


/**
 * Converts our conversation into Gemini's format.
 *
 * Differences from our format:
 * - Gemini calls the assistant `"model"`.
 * - Every message is a list of `parts` (text, functionCall or functionResponse).
 * - Tool results are `functionResponse` parts inside a `"user"` message, and all
 *   results for one model turn must sit together in that one message.
 */
function toGemini(messages: Message[]): Content[] {
  const contents: Content[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      contents.push({
        role: "model",
        // either text or toolcall
        parts: m.content.map((b): Part =>
          b.type === "text"
            ? { text: b.text }
            // thoughtSignature must be echoed back exactly, or Gemini 3 rejects the request
            : { functionCall: { id: b.id, name: b.name, args: b.arguments }, thoughtSignature: b.signature },
        ),
      });
    } else {
      // toolResult -> Gemini wants all responses to one model turn inside a single USER message
      const part: Part = {
        functionResponse: {
          id: m.toolCallId,
          name: m.toolName,
          // response must be an object; "error" vs "output" tells the model whether the tool failed
          response: m.isError ? { error: m.content } : { output: m.content },
        },
      };
      // previous message is already a batch of tool results -> add to it instead of starting a new one
      const last = contents.at(-1);
      if (last?.role === "user" && last.parts?.[0]?.functionResponse) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }
  return contents;
}

/**
 * Creates the Gemini provider. Reads the API key from `GEMINI_API_KEY`.
 *
 * `stream()` yields a `text_delta` event for each piece of visible text as it
 * arrives, then one `done` event with the complete assistant message.
 */
export function createGemini(): Provider {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return {
    name: "gemini",
    defaultModel: "gemini-3.8-flash",
    async *stream({ messages, model, system, tools = [] }) {
      const stream = await client.models.generateContentStream({
        model,
        contents: toGemini(messages),
        config: {
          maxOutputTokens: 4096,
          systemInstruction: system,
          // all our tools go in one "functionDeclarations" group; parameters are plain JSON Schema
          tools: tools.length
            ? [{
                functionDeclarations: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.parameters,
                })),
              }]
            : undefined,
        },
      });

      const content: ContentBlock[] = []; // the assistant message we build up as chunks arrive
      let usage = { input: 0, output: 0 };
      let finishReason: FinishReason | undefined; // only set on the last chunk

      for await (const chunk of stream) {
        // Gemini can return several alternative answers ("candidates"); we only ask for one
        const candidate = chunk.candidates?.[0];
        finishReason = candidate?.finishReason ?? finishReason;
        // usage is cumulative, so the last chunk's numbers are the totals
        if (chunk.usageMetadata) {
          const u = chunk.usageMetadata;
          usage = {
            input: u.promptTokenCount ?? 0,
            // thinking tokens are billed as output, so count them too
            output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
          };
        }
        for (const part of candidate?.content?.parts ?? []) {
          if (part.functionCall) {
            // unlike OpenAI/Anthropic, a Gemini tool call arrives whole, not in pieces
            // Gemini doesn't always send ids, so make one up to pair the call with its result
            content.push({
              type: "toolCall",
              id: part.functionCall.id ?? `call_${crypto.randomUUID()}`,
              name: part.functionCall.name ?? "",
              arguments: part.functionCall.args ?? {},
              signature: part.thoughtSignature,
            });
          } else if (part.text && !part.thought) {
            // skip "thought" parts: that's the model's private reasoning, not the answer
            // glue new text onto the current text block, or start one after a tool call
            const block = content.at(-1);
            if (block?.type === "text") block.text += part.text;
            else content.push({ type: "text", text: part.text });
            yield { type: "text_delta", delta: part.text };
          }
        }
      }
      // Gemini reports STOP even when it called a tool, so check the content instead
      const stopReason: StopReason = content.some((b) => b.type === "toolCall")
        ? "toolUse"
        : finishReason === FinishReason.MAX_TOKENS ? "length" : "stop";
      yield {
        type: "done",
        message: { role: "assistant", content, usage, stopReason },
      };
    },
  };
}
