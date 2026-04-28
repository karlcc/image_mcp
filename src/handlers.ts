import { ChatMessage, ChatRequest, OpenAIClient } from './openai-client.js';
import { ImageProcessor } from './image-processor.js';
import { assertVisionResponse, buildVisionGuardPrompt, EmptyModelResponseError, VisionFailureError } from './vision-response.js';

// --- Handler context (dependency injection) ---

export interface HandlerContext {
  client: OpenAIClient;
  model: string;
  reasoningEffort?: string;
  streaming: boolean;
  maxRetries: number;
}

// --- Constants ---

export const DEFAULT_SUMMARIZE_PROMPT = 'Describe this image thoroughly: if it contains text, read and transcribe all visible text; if it shows a UI, describe the layout and interactive elements; if it is a chart or diagram, extract the data and explain the visualization; if it is a photo, describe the scene, objects, and notable details.';

export const DEFAULT_COMPARE_PROMPT = 'Compare these images thoroughly: describe the similarities and differences in content, text, layout, colors, and style. If the images contain text, note any textual differences.';

const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;

// --- Core functions ---

// Extract text from OpenAI chat response, handling thinking models that put
// the answer in reasoning_content or reasoning instead of content.
export function extractMessageText(message: any): string {
  return message?.content || message?.reasoning_content || message?.reasoning || '';
}

// Build a chat request with optional reasoning_effort injection.
export function buildChatRequest(model: string, messages: ChatMessage[], stream: boolean, reasoningEffort?: string): ChatRequest {
  const req: ChatRequest = { model, messages, stream };
  if (reasoningEffort) {
    req.reasoning_effort = reasoningEffort as any;
  }
  return req;
}

export async function executeChatRequest(client: OpenAIClient, chatRequest: ChatRequest): Promise<string> {
  if (chatRequest.stream) {
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    const result = await client.chatCompletion(chatRequest, (chunk) => {
      const delta = chunk.choices?.[0]?.delta as any;
      if (delta?.content) {
        accumulatedContent += delta.content;
      }
      if (delta?.reasoning_content) {
        accumulatedReasoning += delta.reasoning_content;
      }
      if (delta?.reasoning) {
        accumulatedReasoning += delta.reasoning;
      }
    });
    const message = result.choices?.[0]?.message as any;
    // Priority: streamed content > final message object > accumulated reasoning deltas.
    const text = accumulatedContent || extractMessageText(message) || accumulatedReasoning;
    if (!text) {
      throw new EmptyModelResponseError();
    }
    return text;
  }

  const result = await client.chatCompletion(chatRequest);
  const message = result.choices?.[0]?.message as any;
  const text = extractMessageText(message);
  if (!text) {
    throw new EmptyModelResponseError();
  }
  return text;
}

export async function withRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRetryable =
        error instanceof EmptyModelResponseError ||
        (error instanceof VisionFailureError && error.reason === 'explicit');
      if (!isRetryable || attempt >= maxRetries) {
        throw error;
      }
      const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS);
      const reason = error instanceof VisionFailureError ? 'explicit vision failure' : 'empty model response';
      console.error(`[withRetry] Retrying ${reason} (attempt ${attempt + 1}/${maxRetries}) after ${delay}ms delay`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// --- Handler functions (return plain text strings) ---

export async function readImage(ctx: HandlerContext, imagePath: string, task?: string): Promise<string> {
  if (!imagePath || typeof imagePath !== 'string') {
    throw new Error('image_path must be provided as a string');
  }

  const processStart = Date.now();
  const processedImage = await ImageProcessor.processImage(imagePath);
  const processTimeMs = Date.now() - processStart;

  console.error(`[readImage] Processed input in ${processTimeMs}ms — type: ${processedImage.mimeType}, size: ${processedImage.size} bytes`);

  const prompt = buildVisionGuardPrompt(task || DEFAULT_SUMMARIZE_PROMPT);

  const chatRequest = buildChatRequest(
    ctx.model,
    [{ role: 'user' as const, content: [
        { type: 'text' as const, text: prompt },
        { type: 'image_url' as const, image_url: { url: processedImage.url } }
      ]
    }],
    ctx.streaming,
    ctx.reasoningEffort,
  );

  return withRetry(async () => {
    const text = await executeChatRequest(ctx.client, chatRequest);
    return assertVisionResponse(text, {
      loadedSummary: `Image input (${processedImage.mimeType}, ${processedImage.size} bytes)`,
      model: ctx.model,
      sourceHints: [imagePath],
    });
  }, ctx.maxRetries);
}

export async function compareImages(ctx: HandlerContext, imagePaths: string[], task?: string): Promise<string> {
  if (!imagePaths || !Array.isArray(imagePaths) || imagePaths.length < 2) {
    throw new Error('At least 2 image paths are required for comparison');
  }

  const processStart = Date.now();
  const processedImages = await Promise.all(
    imagePaths.map(async (imagePath, index) => {
      if (typeof imagePath !== 'string') {
        throw new Error(`image_paths[${index}] must be a string`);
      }
      return await ImageProcessor.processImage(imagePath);
    })
  );
  const processTimeMs = Date.now() - processStart;

  console.error(`[compareImages] Processed ${processedImages.length} images in ${processTimeMs}ms`);

  const prompt = buildVisionGuardPrompt(task || DEFAULT_COMPARE_PROMPT);

  const content: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [
    { type: 'text' as const, text: prompt }
  ];

  processedImages.forEach(processedImage => {
    content.push({
      type: 'image_url' as const,
      image_url: { url: processedImage.url }
    });
  });

  const chatRequest = buildChatRequest(
    ctx.model,
    [{ role: 'user' as const, content }],
    ctx.streaming,
    ctx.reasoningEffort,
  );

  return withRetry(async () => {
    const text = await executeChatRequest(ctx.client, chatRequest);
    return assertVisionResponse(text, {
      loadedSummary: `${processedImages.length} image inputs (first image ${processedImages[0].mimeType}, ${processedImages[0].size} bytes)`,
      model: ctx.model,
      sourceHints: imagePaths,
    });
  }, ctx.maxRetries);
}
