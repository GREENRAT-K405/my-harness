/**
 * The list of available providers, and a helper to pick one by name.
 *
 * Every provider turns our shared message format into one company's API format
 * and back, so the rest of the app can switch providers just by changing the name.
 */
import { Provider } from "../types.ts";
import { createAnthropic } from "./anthropic.ts";
import { createGemini } from "./gemini.ts";
import { createGroq } from "./groq.ts";
import { createOpenAICompat } from "./openai-compat.ts";

/**
 * Maps a provider name to a function that builds it.
 * Providers are built only when asked for, so a missing API key for one
 * provider doesn't matter until you try to use it.
 */
const providers:Record<string, ()=>Provider>={
    anthropic:createAnthropic,
    // Claude again, but through Anthropic's OpenAI-compatible endpoint
    "anthropic-openai":()=>createOpenAICompat("anthropic-openai", "https://api.anthropic.com/v1/",process.env.ANTHROPIC_API_KEY!,"claude-sonnet-5"),
    gemini:createGemini,
    groq:createGroq,
    // Groq again, but through the generic OpenAI-compatible adapter
    "groq-openai":()=>createOpenAICompat("groq-openai", "https://api.groq.com/openai/v1",process.env.GROQ_API_KEY!,"qwen/qwen3.8-27b")
}

/**
 * Builds the provider with the given name.
 * @throws if no provider has that name.
 */
export function getProvider(name:string):Provider {
    const create = providers[name];
    if(!create){
        throw new Error(`Unknown provider "${name}". Available: ${Object.keys(providers).join(", ")}`)
    }
    return create();
}
