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

/**
 * Extract base64 image data from various response formats.
 * Handles:
 * - Inline data parts (Gemini native format via OpenRouter)
 * - Data URI in text content
 * - Multi-part content arrays with image_url parts
 */
function extractImageFromResponse(responseData: unknown): { base64: string; mimeType: string } | null {
  const data = responseData as {
    choices?: Array<{
      message?: {
        content?: string | Array<{
          type: string;
          text?: string;
          image_url?: { url: string };
          inline_data?: { mime_type: string; data: string };
        }>;
      };
    }>;
  };

  const choices = data?.choices;
  if (!choices || choices.length === 0) return null;

  const content = choices[0]?.message?.content;
  if (!content) return null;

  // Case 1: Content is an array of parts (multimodal response)
  if (Array.isArray(content)) {
    for (const part of content) {
      // Check for inline_data (Gemini format)
      if (part.inline_data?.data) {
        return {
          base64: part.inline_data.data,
          mimeType: part.inline_data.mime_type || 'image/png',
        };
      }

      // Check for image_url with data URI
      if (part.type === 'image_url' && part.image_url?.url) {
        const dataUriMatch = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
        if (dataUriMatch) {
          return { base64: dataUriMatch[2], mimeType: dataUriMatch[1] };
        }
      }
    }
  }

  // Case 2: Content is a string containing a data URI
  if (typeof content === 'string') {
    const dataUriMatch = content.match(/data:([^;]+);base64,([A-Za-z0-9+/=]+)/);
    if (dataUriMatch) {
      return { base64: dataUriMatch[2], mimeType: dataUriMatch[1] };
    }

    // Case 3: Content is a markdown image with data URI
    const mdMatch = content.match(/!\[.*?\]\(data:([^;]+);base64,([A-Za-z0-9+/=]+)\)/);
    if (mdMatch) {
      return { base64: mdMatch[2], mimeType: mdMatch[1] };
    }
  }

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
          // Some providers need specific parameters for image generation
          ...(model.includes('gemini') ? {} : {}),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log(`OpenRouter API error: ${response.status} ${errorText}`);
        return {
          content: [{ type: 'text' as const, text: `Image generation failed (HTTP ${response.status}): ${errorText.slice(0, 200)}` }],
          isError: true,
        };
      }

      const responseData = await response.json();

      // Try to extract image from the response
      const imageResult = extractImageFromResponse(responseData);

      if (imageResult) {
        // Save the image to the IPC media directory
        fs.mkdirSync(IPC_MEDIA_DIR, { recursive: true });
        const ext = imageResult.mimeType.includes('png') ? '.png' : '.jpg';
        const filename = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        const filePath = path.join(IPC_MEDIA_DIR, filename);

        const buffer = Buffer.from(imageResult.base64, 'base64');
        fs.writeFileSync(filePath, buffer);

        log(`Image saved: ${filePath} (${buffer.length} bytes, ${imageResult.mimeType})`);

        return {
          content: [{
            type: 'text' as const,
            text: `Image generated successfully.\nFile path: ${filePath}\nSize: ${buffer.length} bytes\nFormat: ${imageResult.mimeType}\n\nUse the send_image tool to send this to the user.`,
          }],
        };
      }

      // No image extracted — the model might have returned text instead
      const textContent = (responseData as { choices?: Array<{ message?: { content?: string } }> })
        ?.choices?.[0]?.message?.content;

      if (typeof textContent === 'string' && textContent.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `The model responded with text instead of an image:\n\n${textContent.slice(0, 500)}\n\nTry rephrasing the prompt or using a different model.`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Image generation returned an unexpected response format. Raw response: ${JSON.stringify(responseData).slice(0, 500)}`,
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
