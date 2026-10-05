import argparse
import asyncio
import json
from collections.abc import Callable
from pathlib import Path

from dotenv import load_dotenv

from harness.providers.gemini import create_gemini
from harness.providers.groq import create_groq
from harness.providers.openai_compat import create_openai_compat
from harness.types import Message, Provider, StreamOptions, ToolSpec

ROOT = Path(__file__).resolve().parent.parent

# name -> function that builds the provider. Functions, not instances, so a provider is only
# created (and its API key only required) when you actually pick it.
PROVIDERS: dict[str, Callable[[], Provider]] = {
    "gemini": create_gemini,
    "openai": create_openai_compat,
    "groq": create_groq,
    # the same Groq models through the OpenAI-compatible provider, for comparison
    "groq-compat": lambda: create_openai_compat(
        name="groq-compat",
        base_url="https://api.groq.com/openai/v1",
        api_key_env="GROQ_API_KEY",
        default_model="openai/gpt-oss-120b",
    ),
}

# A fake tool, only so we can check that tool calls come back correctly.
WEATHER_TOOL: ToolSpec = {
    "name": "get_weather",
    "description": "Get the current weather for a city.",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}


async def run(provider: Provider, prompt: str, model: str, system: str | None, test_tool: bool) -> None:
    messages: list[Message] = [{"role": "user", "content": prompt}]
    opts: StreamOptions = {"messages": messages, "model": model}
    if system:
        opts["system"] = system
    if test_tool:
        opts["tools"] = [WEATHER_TOOL]

    async for event in provider.stream(opts):
        if event["type"] == "text_delta":
            print(event["delta"], end="", flush=True)
        else:
            print()
            print(json.dumps(event["message"], indent=2))


def main() -> None:
    load_dotenv(ROOT / ".env")  # explicit path, so it works no matter which directory you run from

    parser = argparse.ArgumentParser(prog="mypi")
    parser.add_argument("prompt")
    parser.add_argument("-p", "--provider", choices=list(PROVIDERS), default="gemini")
    parser.add_argument("-m", "--model", help="defaults to the provider's default_model")
    parser.add_argument("-s", "--system", help="system prompt")
    parser.add_argument("--test-tool", action="store_true", help="offer the fake get_weather tool")
    args = parser.parse_args()

    provider = PROVIDERS[args.provider]()
    model = args.model or provider.default_model
    print(f"[{provider.name} / {model}]")

    asyncio.run(run(provider, args.prompt, model, args.system, args.test_tool))
