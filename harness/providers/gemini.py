import base64
import os
import uuid
from collections.abc import AsyncIterator

from google import genai
from google.genai import Client, types as gtypes

from harness.types import (
    ContentBlock,
    Message,
    Provider,
    StopReason,
    StreamEvent,
    StreamOptions,
    ToolCallBlock,
    Usage,
)

def _to_gemini(messages: list[Message]) -> list[gtypes.Content]:
    """Converts our conversation into Gemini's format.

    Differences from our format:
    - Gemini calls the assistant `"model"`.
    - Every message is a list of `parts` (text, function_call or function_response).
    - Tool results are `function_response` parts inside a `"user"` message, and all
      results for one model turn must sit together in that one message.
    """

    contents: list[gtypes.Content] = []
    for m in messages:
        if m["role"] == "user":
            contents.append(gtypes.Content(role="user", parts=[gtypes.Part(text=m["content"])]))
        elif m["role"]  == "assistant":
            # either text or tool call
            contents.append(gtypes.Content(role="model", parts=[_to_part(b) for b in m["content"]]))
        else:
            # tool_result -> Gemini wants all responses to one model turn inside a single USER message
            part= gtypes.Part(
                function_response=gtypes.FunctionResponse(
                    id=m["tool_call_id"],
                    name=m["tool_name"]
                    # response must be a dict; "error" vs "output" tells the model whether the tool failed

                )
            )
            # previous message is already a batch of tool results -> add to it instead of starting a new one
            last = contents[-1] if contents else None
            if last and last.role == "user" and last.parts and last.parts[0].function_response:
                last.parts.append(part)
            else:
                contents.append(gtypes.Content(role="user", parts=[part]))
    return contents

def _to_part(b: ContentBlock) -> gtypes.Part:
    """One of our assistant content blocks -> one Gemini Part."""
    if b["type"] == "text":
        return gtypes.Part(text=b["text"])
    return gtypes.Part(
        function_call=gtypes.FunctionCall(id=b["id"], name=b["name"], args=b["arguments"]),
        # thought_signature must be echoed back exactly, or Gemini 3 rejects the request.
        # We store it as a base64 str; the Python SDK wants the raw bytes back.
        thought_signature=base64.b64decode(b["signature"]) if "signature" in b else None,
    )


class _GeminiProvider:
    name = "gemini"
    default_model = "gemini-3.8-flash"

    def __init__(self, client: genai.Client) -> None:
        self.client = client

    async def stream(self, opts: StreamOptions) -> AsyncIterator[StreamEvent]:
        tools = opts.get("tools", [])

        # the async version must be awaited first; that returns the async iterator
        stream = await self.client.aio.models.generate_content_stream(
            model=opts["model"],
            contents=_to_gemini(opts["messages"]),
            config=gtypes.GenerateContentConfig(
                max_output_tokens=4096,
                system_instruction=opts.get("system"),
                # all our tools go in one "function_declarations" group; parameters are plain JSON Schema
                tools=[
                    gtypes.Tool(
                        function_declarations=[
                            gtypes.FunctionDeclaration(
                                name=t["name"],
                                description=t["description"],
                                parameters_json_schema=t["parameters"],
                            )
                            for t in tools
                        ]
                    )
                ]
                if tools
                else None,
            ),
        )

        content: list[ContentBlock] = []  # the assistant message we build up as chunks arrive
        usage: Usage = {"input": 0, "output": 0}
        finish_reason: gtypes.FinishReason | None = None  # only set on the last chunk

        async for chunk in stream:
            # Gemini can return several alternative answers ("candidates"); we only ask for one
            candidate = chunk.candidates[0] if chunk.candidates else None
            if candidate and candidate.finish_reason:
                finish_reason = candidate.finish_reason

            # usage is cumulative, so the last chunk's numbers are the totals
            if chunk.usage_metadata:
                u = chunk.usage_metadata
                usage = {
                    "input": u.prompt_token_count or 0,
                    # thinking tokens are billed as output, so count them too
                    "output": (u.candidates_token_count or 0) + (u.thoughts_token_count or 0),
                }

            parts = candidate.content.parts if candidate and candidate.content else None
            for part in parts or []:
                if part.function_call:
                    # unlike OpenAI/Anthropic, a Gemini tool call arrives whole, not in pieces
                    # Gemini doesn't always send ids, so make one up to pair the call with its result
                    call = part.function_call
                    block: ToolCallBlock = {
                        "type": "tool_call",
                        "id": call.id or f"call_{uuid.uuid4()}",
                        "name": call.name or "",
                        "arguments": call.args or {},
                    }
                    if part.thought_signature:
                        # bytes -> base64 str, so messages stay JSON-serializable
                        block["signature"] = base64.b64encode(part.thought_signature).decode("ascii")
                    content.append(block)
                elif part.text and not part.thought:
                    # skip "thought" parts: that's the model's private reasoning, not the answer
                    # glue new text onto the current text block, or start one after a tool call
                    last = content[-1] if content else None
                    if last is not None and last["type"] == "text":
                        last["text"] += part.text
                    else:
                        content.append({"type": "text", "text": part.text})
                    yield {"type": "text_delta", "delta": part.text}

        # Gemini reports STOP even when it called a tool, so check the content instead
        stop_reason: StopReason = (
            "tool_use"
            if any(b["type"] == "tool_call" for b in content)
            else "length"
            if finish_reason == gtypes.FinishReason.MAX_TOKENS
            else "stop"
        )
        yield {
            "type": "done",
            "message": {"role": "assistant", "content": content, "usage": usage, "stop_reason": stop_reason},
        }


def create_gemini() -> Provider:
    """Creates the Gemini provider. Reads the API key from `GEMINI_API_KEY`.

    `stream()` yields a `text_delta` event for each piece of visible text as it
    arrives, then one `done` event with the complete assistant message.
    """
    return _GeminiProvider(genai.Client(api_key=os.environ["GEMINI_API_KEY"]))