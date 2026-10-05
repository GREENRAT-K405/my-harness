"""Provider for OpenAI and any server that speaks the OpenAI Chat Completions API
(OpenRouter, Ollama, llama.cpp, vLLM, LM Studio, ...), using the official `openai` SDK.

Translates our shared message format (see `../types.py`) into OpenAI's
chat-completions format, streams the reply, and translates it back.
"""

import json
import os
from collections.abc import AsyncIterator, Sequence
from typing import Any, TypedDict

import openai
from openai.types.chat import ChatCompletionFunctionToolParam, ChatCompletionMessageParam

from harness.types import (
    ContentBlock,
    Message,
    Provider,
    StopReason,
    StreamEvent,
    StreamOptions,
    ToolCallBlock,
    ToolSpec,
    Usage,
)

MAX_TOKENS = 4096


def _to_openai(messages: list[Message], system: str | None) -> list[ChatCompletionMessageParam]:
    """Converts our conversation into OpenAI's format.

    Differences from our format:
    - The system prompt is just the first message, with role `"system"`.
    - An assistant message has a plain `content` string plus a separate `tool_calls`
      list, instead of a list of blocks.
    - Tool call arguments are a JSON *string*, not a dict.
    - Each tool result is its own message with role `"tool"`.
    """
    out: list[ChatCompletionMessageParam] = []
    if system:
        out.append({"role": "system", "content": system})

    for m in messages:
        if m["role"] == "user":
            out.append({"role": "user", "content": m["content"]})
        elif m["role"] == "assistant":
            # OpenAI has no blocks: all text goes in `content`, all tool calls in `tool_calls`
            text = "".join(b["text"] for b in m["content"] if b["type"] == "text")
            tool_calls = [
                {
                    "id": b["id"],
                    "type": "function",
                    "function": {"name": b["name"], "arguments": json.dumps(b["arguments"])},
                }
                for b in m["content"]
                if b["type"] == "tool_call"
            ]
            msg: dict[str, Any] = {"role": "assistant", "content": text or None}
            if tool_calls:  # some servers reject an empty tool_calls list
                msg["tool_calls"] = tool_calls
            out.append(msg)  # type: ignore[arg-type]
        else:
            # tool_result -> its own "tool" message. There's no error flag, so say it in the text.
            content = f"Error: {m['content']}" if m["is_error"] else m["content"]
            out.append({"role": "tool", "tool_call_id": m["tool_call_id"], "content": content})
    return out


def _to_openai_tools(tools: Sequence[ToolSpec]) -> list[ChatCompletionFunctionToolParam]:
    # parameters are plain JSON Schema, same as ours
    return [
        {
            "type": "function",
            "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]},
        }
        for t in tools
    ]


class _PartialToolCall(TypedDict):
    """A tool call while it's still streaming in. `arguments` is JSON text, not yet parsed."""

    id: str
    name: str
    arguments: str


class _OpenAICompatProvider:
    def __init__(self, client: openai.AsyncOpenAI, name: str, default_model: str) -> None:
        self.client = client
        self.name = name
        self.default_model = default_model

    async def stream(self, opts: StreamOptions) -> AsyncIterator[StreamEvent]:
        tools = opts.get("tools", [])

        stream = await self.client.chat.completions.create(
            model=opts["model"],
            messages=_to_openai(opts["messages"], opts.get("system")),
            tools=_to_openai_tools(tools) if tools else openai.omit,
            max_completion_tokens=MAX_TOKENS,
            stream=True,
            # without this, a streamed response has no token counts at all
            stream_options={"include_usage": True},
        )

        content: list[ContentBlock] = []  # text blocks, built up as chunks arrive
        partial_calls: dict[int, _PartialToolCall] = {}  # tool calls being assembled, by index
        usage: Usage = {"input": 0, "output": 0}
        finish_reason: str | None = None

        async for chunk in stream:
            # usage arrives in one extra chunk at the very end, which has no choices
            if chunk.usage:
                usage = {"input": chunk.usage.prompt_tokens, "output": chunk.usage.completion_tokens}
            if not chunk.choices:
                continue

            choice = chunk.choices[0]
            finish_reason = choice.finish_reason or finish_reason
            delta = choice.delta

            if delta.content:
                # glue new text onto the current text block, or start one
                last = content[-1] if content else None
                if last is not None and last["type"] == "text":
                    last["text"] += delta.content
                else:
                    content.append({"type": "text", "text": delta.content})
                yield {"type": "text_delta", "delta": delta.content}

            # Unlike Gemini, a tool call arrives in pieces: the first piece has the id and name,
            # later pieces add fragments of the arguments JSON. `index` says which call a piece is for.
            for tc in delta.tool_calls or []:
                call = partial_calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                if tc.id:
                    call["id"] = tc.id
                if tc.function and tc.function.name:
                    call["name"] = tc.function.name
                if tc.function and tc.function.arguments:
                    call["arguments"] += tc.function.arguments

        # the stream is over, so every tool call's arguments JSON is now complete
        for index in sorted(partial_calls):
            content.append(_finish_tool_call(partial_calls[index]))

        stop_reason: StopReason = (
            "tool_use"
            if partial_calls
            else "length"
            if finish_reason == "length"
            else "stop"
        )
        yield {
            "type": "done",
            "message": {"role": "assistant", "content": content, "usage": usage, "stop_reason": stop_reason},
        }


def _finish_tool_call(call: _PartialToolCall) -> ToolCallBlock:
    try:
        arguments = json.loads(call["arguments"]) if call["arguments"] else {}
    except json.JSONDecodeError:
        # the model produced broken JSON; pass empty args so the tool reports what's missing
        arguments = {}
    return {"type": "tool_call", "id": call["id"], "name": call["name"], "arguments": arguments}


def create_openai_compat(
    *,
    name: str = "openai",
    base_url: str | None = None,
    api_key_env: str = "OPENAI_API_KEY",
    default_model: str = "FILL_ME_IN",
) -> Provider:
    """Creates a provider for any OpenAI-compatible API.

    With no arguments it talks to OpenAI itself. Point `base_url` somewhere else to use
    another server, e.g. a local Ollama:

        create_openai_compat(name="ollama", base_url="http://localhost:11434/v1",
                             api_key_env="OLLAMA_API_KEY", default_model="qwen3")

    `stream()` yields a `text_delta` event for each piece of visible text as it
    arrives, then one `done` event with the complete assistant message.
    """
    client = openai.AsyncOpenAI(api_key=os.environ[api_key_env], base_url=base_url)
    return _OpenAICompatProvider(client, name, default_model)
