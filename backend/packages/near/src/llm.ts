// Optional LLM access. Works with any OpenAI-compatible endpoint: OpenAI, or NEAR AI Cloud
// (LLM_BASE_URL=https://cloud-api.near.ai/v1). With no key, callers fall back to deterministic rules.
import OpenAI from 'openai';

const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
export const llm = apiKey ? new OpenAI({ apiKey, baseURL: process.env.LLM_BASE_URL }) : null;
export const LLM_MODEL = process.env.LLM_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
