import path from 'node:path';

export const VISION_FAILURE_SENTINEL = 'VISION_INPUT_NOT_PROCESSED';

export class VisionFailureError extends Error {
  readonly reason: 'explicit' | 'hallucinated';
  constructor(reason: 'explicit' | 'hallucinated', model: string, loadedSummary: string) {
    const message = reason === 'explicit'
      ? `Model "${model}" did not analyze the image content. ${loadedSummary} was sent successfully, but the model responded as if it could not see the image. Switch to a vision-capable model or endpoint.`
      : `Model "${model}" likely ignored the image and hallucinated from filename or metadata instead of visual pixels. ${loadedSummary} was sent successfully. Switch to a vision-capable model or endpoint.`;
    super(message);
    this.reason = reason;
  }
}

export interface VisionResponseContext {
  loadedSummary: string;
  model: string;
  sourceHints?: string[];
}

export function buildVisionGuardPrompt(userPrompt: string): string {
  const trimmedPrompt = userPrompt.trim();

  return [
    `Inspect the actual image pixels before answering.`,
    `If you cannot directly analyze the image content, respond with exactly "${VISION_FAILURE_SENTINEL}".`,
    'Do not infer anything from filenames, paths, timestamps, metadata, or surrounding conversation.',
    trimmedPrompt,
  ].join(' ');
}

export function assertVisionResponse(responseText: string, context: VisionResponseContext): string {
  const failureReason = detectVisionFailure(responseText, context.sourceHints);

  if (!failureReason) {
    return responseText.trim();
  }

  throw new VisionFailureError(failureReason, context.model || 'configured model', context.loadedSummary);
}

type VisionFailureReason = 'explicit' | 'hallucinated';

function getNormalizedBaseName(sourceHint: string): string {
  const baseName = path.basename(sourceHint);

  try {
    return decodeURIComponent(baseName).toLowerCase();
  } catch {
    return baseName.toLowerCase();
  }
}

function detectVisionFailure(
  responseText: string,
  sourceHints: string[] = []
): VisionFailureReason | null {
  const normalized = responseText.trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return 'explicit';
  }

  // These must be phrases only a model would produce when refusing, not phrases
  // that might legitimately appear as UI text / OCR output in a real image.
  // "no image" and "please provide the image" alone triggered false positives
  // on screenshots that literally contain those strings, so we require
  // refusal-style framing.
  const explicitFailureIndicators = [
    VISION_FAILURE_SENTINEL.toLowerCase(),
    'please provide the image so',
    'please provide the image you',
    'please share the image',
    'please attach the image',
    'no image was provided',
    'no image has been provided',
    'no image was uploaded',
    'no image has been uploaded',
    'no image attached',
    'there is no image',
    "i can't see",
    'i cannot see',
    "i don't see any image",
    "i do not see any image",
    "you haven't uploaded",
    'image is not visible',
    'unable to view',
    'cannot view the image',
  ];

  if (explicitFailureIndicators.some((indicator) => lower.includes(indicator))) {
    return 'explicit';
  }

  const mentionsScreenshot = [
    'screenshot',
    'screen shot',
    'screen capture',
  ].some((indicator) => lower.includes(indicator));

  const usesHedgingLanguage = [
    'appears to be',
    'seems to be',
    'appears to show',
    'seems to show',
    'possibly',
    'likely',
  ].some((indicator) => lower.includes(indicator));

  const genericUiDescription = [
    'application interface',
    'dark theme',
    'chinese-language content',
    'conversational text',
    'messaging or chat application',
  ].some((indicator) => lower.includes(indicator));

  const mentionsCaptureMetadata = /\bcaptured\b/i.test(normalized) &&
    (/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(normalized) ||
      /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)\b/i.test(normalized));

  const sourceLooksLikeScreenshot = sourceHints.some((hint) => {
    const baseName = getNormalizedBaseName(hint);
    return (
      ['screenshot', 'screen shot', 'screen_capture', '螢幕截圖', '截图', '截圖'].some((token) => baseName.includes(token)) ||
      (/\b\d{4}[-_.]\d{2}[-_.]\d{2}\b/.test(baseName) && /\b\d{1,2}[.:_]\d{2}[.:_]\d{2}\b/.test(baseName))
    );
  });

  const suspiciousFromScreenshotMetadata =
    mentionsScreenshot &&
    mentionsCaptureMetadata &&
    (usesHedgingLanguage || genericUiDescription);

  const suspiciousFromSourceHint =
    sourceLooksLikeScreenshot &&
    mentionsScreenshot &&
    mentionsCaptureMetadata &&
    (usesHedgingLanguage || genericUiDescription);

  // Require capture metadata (month/time extracted from response) as evidence the model
  // is parroting filename info rather than reading pixels. Hedging + screenshot alone
  // is too weak — many vision-capable models naturally hedge ("appears to be a screenshot of...").
  if (suspiciousFromScreenshotMetadata || suspiciousFromSourceHint) {
    return 'hallucinated';
  }

  return null;
}
