import { extractMessageText } from '../src/handlers';
import { stripGrokAssetUrls, assertVisionResponse, buildVisionGuardPrompt } from '../src/vision-response';

describe('extractMessageText', () => {
  it('returns content when present', () => {
    expect(extractMessageText({ content: 'hello' })).toBe('hello');
  });

  it('returns reasoning_content when content is empty', () => {
    expect(extractMessageText({ content: '', reasoning_content: 'thinking' })).toBe('thinking');
  });

  it('returns reasoning when content and reasoning_content are empty', () => {
    expect(extractMessageText({ content: '', reasoning_content: '', reasoning: 'chain' })).toBe('chain');
  });

  it('prefers content over reasoning fields', () => {
    expect(extractMessageText({ content: 'answer', reasoning_content: 'thinking', reasoning: 'chain' })).toBe('answer');
  });

  it('prefers reasoning_content over reasoning', () => {
    expect(extractMessageText({ content: '', reasoning_content: 'thinking', reasoning: 'chain' })).toBe('thinking');
  });

  it('returns empty string for null/undefined message', () => {
    expect(extractMessageText(null)).toBe('');
    expect(extractMessageText(undefined)).toBe('');
    expect(extractMessageText({})).toBe('');
  });
});

describe('stripGrokAssetUrls', () => {
  it('removes grok asset URLs from response text', () => {
    const input = 'The image shows a chart.\nhttps://assets.grok.com/users/abc/generated/123/image.jpg';
    expect(stripGrokAssetUrls(input)).toBe('The image shows a chart.');
  });

  it('removes multiple grok asset URLs', () => {
    const input = 'Text before.\nhttps://assets.grok.com/users/abc/gen1/img1.jpg\nhttps://assets.grok.com/users/def/gen2/img2.png\nText after.';
    expect(stripGrokAssetUrls(input)).toBe('Text before.Text after.');
  });

  it('does not remove non-grok URLs', () => {
    const input = 'See https://example.com/image.jpg for details.';
    expect(stripGrokAssetUrls(input)).toBe(input);
  });

  it('handles text without any URLs', () => {
    const input = 'Just plain text about an image.';
    expect(stripGrokAssetUrls(input)).toBe(input);
  });

  it('removes webp and gif asset URLs', () => {
    const input = 'Description\nhttps://assets.grok.com/users/x/generated/y/image.webp';
    expect(stripGrokAssetUrls(input)).toBe('Description');
  });
});

describe('buildVisionGuardPrompt', () => {
  it('prepends pixel inspection instruction', () => {
    const result = buildVisionGuardPrompt('Describe the image.');
    expect(result).toContain('Inspect the actual image pixels before answering.');
    expect(result).toContain('Describe the image.');
  });

  it('includes no-generate instruction', () => {
    const result = buildVisionGuardPrompt('test');
    expect(result).toContain('Do not generate, produce, or return any images, image URLs, or links.');
  });

  it('no longer includes sentinel instruction', () => {
    const result = buildVisionGuardPrompt('test');
    expect(result).not.toContain('VISION_INPUT_NOT_PROCESSED');
  });
});

describe('assertVisionResponse', () => {
  it('returns cleaned text for valid responses', () => {
    const result = assertVisionResponse('A chart showing revenue data.', {
      loadedSummary: 'Image input (image/png, 5000 bytes)',
      model: 'test-model',
    });
    expect(result).toBe('A chart showing revenue data.');
  });

  it('strips grok asset URLs from valid responses', () => {
    const result = assertVisionResponse('A chart.\nhttps://assets.grok.com/users/abc/gen/img.jpg', {
      loadedSummary: 'Image input (image/png, 5000 bytes)',
      model: 'test-model',
    });
    expect(result).toBe('A chart.');
  });

  it('throws on explicit vision failure', () => {
    expect(() => assertVisionResponse('I cannot see the image', {
      loadedSummary: 'Image input (image/png, 5000 bytes)',
      model: 'text-model',
    })).toThrow('vision-capable model or endpoint');
  });
});
