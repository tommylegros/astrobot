/**
 * Embedding helper using OpenRouter
 *
 * Uses the OpenAI-compatible API to generate embeddings
 * for vector search in pgvector.
 */
import OpenAI from 'openai';

import { EMBEDDING_MODEL, OPENROUTER_BASE_URL } from './config.js';
import { resolveSecret } from './credentials.js';
import { logger } from './logger.js';

let client: OpenAI | null = null;

async function getClient(): Promise<OpenAI> {
  if (client) return client;

  const apiKey = await resolveSecret('OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY_REF);

  client = new OpenAI({
    baseURL: OPENROUTER_BASE_URL,
    apiKey,
  });

  return client;
}

/**
 * Generate an embedding vector for the given text.
 * Returns a 1536-dimensional float array (for text-embedding-3-small).
 */
export async function embed(text: string): Promise<number[]> {
  const openai = await getClient();

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  return response.data[0].embedding;
}

/**
 * Generate embeddings for multiple texts in a single batch.
 * More efficient than calling embed() in a loop.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const openai = await getClient();

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });

  // Sort by index to maintain order
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/**
 * Generate an embedding, with error handling that returns null on failure.
 * Useful for non-critical paths where embedding failure shouldn't block the operation.
 */
export async function embedSafe(text: string): Promise<number[] | null> {
  try {
    return await embed(text);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to generate embedding',
    );
    return null;
  }
}
