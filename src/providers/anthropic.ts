/**
 * Provider for Anthropic's Claude models, using the official `@anthropic-ai/sdk`.
 *
 * Translates our shared message format (see `../types.ts`) into Anthropic's
 * Messages API format, streams the reply, and translates it back.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Provider, StreamOptions, StopReason, Message, ContentBlock } from "../types.ts";


/**
 * Converts our conversation into Anthropic's format.
 *
 * Differences from our format:
 * - Our `toolCall` block is Anthropic's `tool_use` block (arguments are called `input`).
 * - Anthropic only has "user" and "assistant" roles, so a tool result is sent as
 *   a `tool_result` block inside a user message.
 */
function toAnthropic(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content.map((b): Anthropic.ContentBlockParam =>
          b.type === "text"
            ? { type: "text", text: b.text }
            : { type: "tool_use", id: b.id, name: b.name, input: b.arguments },
        ),
      };
    }
    // toolResult -> Anthropic wants it inside a USER message
    return {
      role: "user",
      // tool_use_id links this result to the tool_use block that asked for it
      content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content, is_error: m.isError }],
    };
  });
}

/**
 * Creates the Anthropic provider. The SDK reads the API key from `ANTHROPIC_API_KEY`.
 *
 * `stream()` yields a `text_delta` event for each piece of text as it arrives,
 * then one `done` event with the complete assistant message.
 */
export function createAnthropic(): Provider {
  const client = new Anthropic();
  return {
    name: "anthropic",
    defaultModel: "claude-sonnet-5",
    async *stream({ messages, model, system,tools=[] }) {
      const stream = client.messages.stream({
        model,
        max_tokens: 4096,
        system,
        messages: toAnthropic(messages),
        // Anthropic calls the JSON Schema for a tool's arguments "input_schema"
        tools:tools.map((t)=>({
          name:t.name,
          description:t.description,
          input_schema:t.parameters as Anthropic.Tool.InputSchema
        }))
      });
      let text = "";
      const content:ContentBlock[]=[]; // the assistant message we build up as events arrive
      let json=""; // arguments of the current tool call, collected as raw JSON text

      // The reply is a sequence of blocks (text or tool_use). Each block streams as:
      //   content_block_start -> content_block_delta (many) -> content_block_stop
      // Blocks arrive one after another, so the block being filled is always content.at(-1).
      for await (const event of stream) {
        if(event.type==="content_block_start"){
          // a new block begins: add an empty one that the deltas will fill in
          const b=event.content_block;
          if(b.type==="text") content.push({type:"text",text:""})
          else if(b.type==="tool_use"){
            content.push({type:"toolCall",id:b.id,name:b.name,arguments:{}})
            json=""
          }
        } else if(event.type==="content_block_delta"){
          const block=content.at(-1);
          if(event.delta.type==="text_delta" && block?.type==="text"){
            block.text+=event.delta.text
            yield{type:"text_delta",delta:event.delta.text}
          } else if(event.delta.type==="input_json_delta"){
            // tool arguments arrive as broken JSON pieces, e.g. '{"comm' + 'and":"ls"}'
            json+=event.delta.partial_json
          }
        } else if(event.type==="content_block_stop"){
          // the block is finished, so a tool call's JSON is now complete and safe to parse
          const block=content.at(-1);
          if(block?.type==="toolCall") block.arguments=json?JSON.parse(json) :{};
        }
        // if (
        //   event.type === "content_block_delta" &&
        //   event.delta.type === "text_delta"
        // ) {
        //     text+=event.delta.text;
        //     yield{type:"text_delta", delta:event.delta.text};
        // }
      }
      // the SDK assembles the full message for us; we only need its stop reason and usage
      const final= await stream.finalMessage();
      // map Anthropic's stop reasons onto our three: toolUse / length / stop
      const stopReason:StopReason =
        final.stop_reason ==="tool_use"? "toolUse": final.stop_reason==="max_tokens"?"length":"stop";
      yield {
        type:"done",
        message:{
            role:"assistant",
            content,
            usage:{input:final.usage.input_tokens,output: final.usage.output_tokens},
            stopReason
        }
      }
    },
  };
}
