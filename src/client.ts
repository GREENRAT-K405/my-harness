import OpenAI from "openai";

export const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
    maxRetries:3
});

export const MODEL = "openai/gpt-oss-120b";

//exports client and model