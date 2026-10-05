from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Any, Literal, NotRequired, Protocol, TypedDict


class Usage(TypedDict):
    input: int
    output: int

type StopReason = Literal["stop", "length", "tool_use"]

# ---- content blocks ---------------------------------------------------------

class TextBlock(TypedDict):
    type: Literal["text"]
    text: str


class ToolCallBlock(TypedDict):
    type: Literal["tool_call"]
    id: str
    name: str
    arguments: dict[str, Any]
    # opaque provider data that must be sent back with the call (Gemini thought signatures)
    signature: NotRequired[str]


type ContentBlock = TextBlock | ToolCallBlock

# ---- messages ---------------------------------------------------------------

class UserMessage(TypedDict):
    role: Literal["user"]
    content: str


class AssistantMessage(TypedDict):
    role: Literal["assistant"]
    content: list[ContentBlock]
    usage: Usage
    stop_reason: StopReason


class ToolResultMessage(TypedDict):
    role: Literal["tool_result"]
    tool_call_id: str
    tool_name: str
    content: str
    is_error: bool


type Message = UserMessage | AssistantMessage | ToolResultMessage

# ---- tools ------------------------------------------------------------------

class ToolSpec(TypedDict):
    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema


class Tool(ToolSpec):  # TypedDict inheritance == TS intersection (ToolSpec & {...})
    execute: Callable[[dict[str, Any]], Awaitable[str]]

# ---- streaming --------------------------------------------------------------

class TextDeltaEvent(TypedDict):
    type: Literal["text_delta"]
    delta: str


class DoneEvent(TypedDict):
    type: Literal["done"]
    message: AssistantMessage


type StreamEvent = TextDeltaEvent | DoneEvent


class StreamOptions(TypedDict):
    messages: list[Message]
    model: str
    system: NotRequired[str]
    tools: NotRequired[Sequence[ToolSpec]]

# ---- provider interface -----------------------------------------------------

class Provider(Protocol):
    name: str
    default_model: str

    def stream(self, opts: StreamOptions) -> AsyncIterator[StreamEvent]: ...