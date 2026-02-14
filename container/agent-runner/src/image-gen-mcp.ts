/**
 * Image Generation MCP Server for Astrobot v2
 *
 * Provides a generate_image tool that uses OpenRouter to create images.
 * Default model: google/gemini-3-pro-image-preview
 *
 * The generated image is saved to /workspace/ipc/media/ so the agent
 * can then use send_image (from the IPC MCP) to deliver it to the user.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_MEDIA_DIR = '/workspace/ipc/media';
const DEFAULT_MODEL = process.env.IMAGE_GEN_MODEL || 'google/gemini-3-pro-image-preview';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function log(message: string): void {
  console.error(`[image-gen-mcp] ${message}`);
}

interface ImageResult {
  base64: string;
  mimeType: string;
  source: string; // description of where we found it
}

/**
 * Recursively search a JSON value for base64 image data.
 * Checks common field patterns used by different providers.
 */
function deepSearchForImage(obj: unknown, depth = 0, path = ''): ImageResult | null {
  if (depth > 10 || obj === null || obj === undefined) return null;

  if (typeof obj === 'string') {
    // Check for data URI
    const dataUriMatch = obj.match(/^data:image\/([^;]+);base64,(.+)$/s);
    if (dataUriMatch) {
      return {
        base64: dataUriMatch[2],
        mimeType: `image/${dataUriMatch[1]}`,
        source: `data URI at ${path}`,
      };
    }
    // Check for what looks like raw base64 image data (PNG or JPEG magic bytes in base64)
    // PNG starts with iVBOR, JPEG starts with /9j/
    if (obj.length > 1000 && (obj.startsWith('iVBOR') || obj.startsWith('/9j/'))) {
      const mimeType = obj.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
      return { base64: obj, mimeType, source: `raw base64 at ${path}` };
    }
    return null;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const result = deepSearchForImage(obj[i], depth + 1, `${path}[${i}]`);
      if (result) return result;
    }
    return null;
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;

    // Check known image fields first (most specific → least specific)

    // OpenAI image_url format: { type: "image_url", image_url: { url: "data:..." } }
    if (record.type === 'image_url' && record.image_url) {
      const imageUrl = record.image_url as Record<string, unknown>;
      if (typeof imageUrl.url === 'string') {
        const result = deepSearchForImage(imageUrl.url, depth + 1, `${path}.image_url.url`);
        if (result) return result;
      }
    }

    // Gemini inline_data format: { inlineData: { mimeType: "...", data: "..." } }
    // or snake_case: { inline_data: { mime_type: "...", data: "..." } }
    for (const key of ['inlineData', 'inline_data']) {
      if (record[key] && typeof record[key] === 'object') {
        const inlineData = record[key] as Record<string, unknown>;
        if (typeof inlineData.data === 'string' && inlineData.data.length > 100) {
          const mimeType = (inlineData.mimeType || inlineData.mime_type || 'image/png') as string;
          return { base64: inlineData.data, mimeType, source: `${key} at ${path}` };
        }
      }
    }

    // DALL-E format: { b64_json: "..." }
    if (typeof record.b64_json === 'string' && record.b64_json.length > 100) {
      return { base64: record.b64_json, mimeType: 'image/png', source: `b64_json at ${path}` };
    }

    // Generic data field with base64
    if (typeof record.data === 'string' && record.data.length > 1000) {
      const result = deepSearchForImage(record.data, depth + 1, `${path}.data`);
      if (result) return result;
    }

    // Anthropic source format: { source: { type: "base64", media_type: "...", data: "..." } }
    if (record.source && typeof record.source === 'object') {
      const source = record.source as Record<string, unknown>;
      if (source.type === 'base64' && typeof source.data === 'string') {
        const mimeType = (source.media_type || 'image/png') as string;
        return { base64: source.data, mimeType, source: `anthropic source at ${path}` };
      }
    }

    // Recurse into all fields
    for (const [key, value] of Object.entries(record)) {
      const result = deepSearchForImage(value, depth + 1, `${path}.${key}`);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Search for an image URL (non-data-URI) in the response that we could download.
 */
function findImageUrl(obj: unknown, depth = 0): string | null {
  if (depth > 10 || obj === null || obj === undefined) return null;

  if (typeof obj === 'string') {
    // Check for HTTP(S) URL pointing to an image
    if (obj.match(/^https?:\/\/.+\.(png|jpg|jpeg|webp|gif)/i)) {
      return obj;
    }
    // OpenAI-style temporary URL
    if (obj.match(/^https?:\/\/.*\/(images|generations|files)\//i)) {
      return obj;
    }
    return null;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = findImageUrl(item, depth + 1);
      if (result) return result;
    }
    return null;
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    // Check url fields first
    for (const key of ['url', 'image_url', 'image', 'revised_prompt']) {
      if (typeof record[key] === 'string') {
        const result = findImageUrl(record[key], depth + 1);
        if (result) return result;
      }
    }
    for (const value of Object.values(record)) {
      const result = findImageUrl(value, depth + 1);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Download an image from a URL and return as base64.
 */
async function downloadImage(url: string): Promise<ImageResult | null> {
  try {
    log(`Downloading image from URL: ${url.slice(0, 200)}`);
    const response = await fetch(url);
    if (!response.ok) {
      log(`Failed to download image: HTTP ${response.status}`);
      return null;
    }
    const contentType = response.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 100) {
      log(`Downloaded image too small: ${buffer.length} bytes`);
      return null;
    }
    return {
      base64: buffer.toString('base64'),
      mimeType: contentType.split(';')[0],
      source: `downloaded from ${url.slice(0, 100)}`,
    };
  } catch (err) {
    log(`Image download error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Extract image from an API response, trying all known formats.
 */
async function extractImageFromResponse(responseData: unknown): Promise<ImageResult | null> {
  // Log the response structure (truncated for readability)
  const responseStr = JSON.stringify(responseData);
  log(`Response length: ${responseStr.length} chars`);
  log(`Response preview: ${responseStr.slice(0, 500)}`);

  // If the response is very long, it likely contains base64 image data
  if (responseStr.length > 10000) {
    log('Response is large — likely contains image data');
  }

  // Strategy 1: Deep search for base64 image data in the response
  const imageResult = deepSearchForImage(responseData);
  if (imageResult) {
    log(`Found image via deep search: ${imageResult.source} (${imageResult.base64.length} chars base64, ${imageResult.mimeType})`);
    return imageResult;
  }

  // Strategy 2: Check if content is a JSON string that needs parsing
  const data = responseData as Record<string, unknown>;
  const content = (data?.choices as Array<Record<string, unknown>>)?.[0]
    ?.message as Record<string, unknown> | undefined;
  if (content?.content && typeof content.content === 'string') {
    try {
      const parsed = JSON.parse(content.content as string);
      const result = deepSearchForImage(parsed);
      if (result) {
        log(`Found image in parsed content string: ${result.source}`);
        return result;
      }
    } catch {
      // Not JSON, that's fine
    }
  }

  // Strategy 3: Check top-level 'data' array (DALL-E / image generation format)
  if (Array.isArray(data?.data)) {
    const result = deepSearchForImage(data.data);
    if (result) {
      log(`Found image in top-level data array: ${result.source}`);
      return result;
    }
  }

  // Strategy 4: Look for an image URL we can download
  const imageUrl = findImageUrl(responseData);
  if (imageUrl) {
    log(`Found image URL, attempting download: ${imageUrl.slice(0, 200)}`);
    const downloaded = await downloadImage(imageUrl);
    if (downloaded) return downloaded;
  }

  log('No image found in response via any extraction strategy');
  return null;
}

const server = new McpServer({
  name: 'astrobot-image-gen',
  version: '2.0.0',
});

// ── generate_image ──────────────────────────────────────────────────

server.tool(
  'generate_image',
  `Generate an image from a text description using an AI model.
Returns the file path of the generated image. Use send_image (from the IPC tools) to send it to the user.

Tips for good prompts:
- Be specific about subjects, composition, style, and colors
- Mention art style if desired (photorealistic, watercolor, illustration, etc.)
- Include details about lighting, mood, and perspective`,
  {
    prompt: z.string().describe('Detailed description of the image to generate'),
    model: z.string().optional().describe(
      `OpenRouter model ID for image generation. Defaults to ${DEFAULT_MODEL}`,
    ),
  },
  async (args) => {
    if (!OPENROUTER_API_KEY) {
      return {
        content: [{ type: 'text' as const, text: 'OPENROUTER_API_KEY not available for image generation.' }],
        isError: true,
      };
    }

    const model = args.model || DEFAULT_MODEL;
    log(`Generating image with model ${model}: "${args.prompt.slice(0, 100)}..."`);

    try {
      // Call OpenRouter chat completions API
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/astrobot',
          'X-Title': 'Astrobot Image Generation',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: args.prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log(`OpenRouter API error: ${response.status} ${errorText.slice(0, 500)}`);
        return {
          content: [{ type: 'text' as const, text: `Image generation failed (HTTP ${response.status}): ${errorText.slice(0, 300)}` }],
          isError: true,
        };
      }

      const responseData = await response.json();

      // Try to extract image from the response
      const imageResult = await extractImageFromResponse(responseData);

      if (imageResult) {
        // Save the image to the IPC media directory
        fs.mkdirSync(IPC_MEDIA_DIR, { recursive: true });
        const ext = imageResult.mimeType.includes('png') ? '.png'
          : imageResult.mimeType.includes('webp') ? '.webp'
          : '.jpg';
        const filename = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        const filePath = path.join(IPC_MEDIA_DIR, filename);

        const buffer = Buffer.from(imageResult.base64, 'base64');
        fs.writeFileSync(filePath, buffer);

        log(`Image saved: ${filePath} (${buffer.length} bytes, ${imageResult.mimeType}, found via: ${imageResult.source})`);

        return {
          content: [{
            type: 'text' as const,
            text: `Image generated successfully.\nFile path: ${filePath}\nSize: ${buffer.length} bytes\nFormat: ${imageResult.mimeType}\n\nUse the send_image tool to send this to the user.`,
          }],
        };
      }

      // No image extracted — return what we got
      const textContent = (responseData as { choices?: Array<{ message?: { content?: unknown } }> })
        ?.choices?.[0]?.message?.content;

      log(`No image found. Content type: ${typeof textContent}, Content preview: ${JSON.stringify(textContent).slice(0, 300)}`);

      if (typeof textContent === 'string' && textContent.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `The model responded with text instead of an image:\n\n${textContent.slice(0, 500)}\n\nTry rephrasing the prompt or using a different image generation model.`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Image generation returned an unexpected response format. Could not extract image data.\n\nResponse preview: ${JSON.stringify(responseData).slice(0, 500)}`,
        }],
        isError: true,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Image generation error: ${errorMsg}`);
      return {
        content: [{ type: 'text' as const, text: `Image generation failed: ${errorMsg}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
