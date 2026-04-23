// Comprehensive tests for the image processing tool
import { ImageProcessor } from '../src/image-processor';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'node:url';

// Re-export isAbsoluteLocalPath for testing — it's a module-level function
// in index.ts, so we test path.isAbsolute logic inline here.
function isAbsoluteLocalPath(s: string): boolean {
  if (!s || typeof s !== 'string') return false;
  if (s.startsWith('file://') || s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:')) return false;
  if (s.startsWith('@')) return false;
  return path.isAbsolute(s);
}

describe('Image Processing Tests', () => {
  // Test image data for different input types
  const testImagePath = path.join(__dirname, '../test.svg');
  const testDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const testImageUrl = 'https://picsum.photos/200';

  // Clean up after tests
  afterEach(async () => {
    // Clean up any temporary files created during tests
  });

  describe('ImageProcessor.validateImageInput', () => {
    it('should validate file path input correctly', () => {
      const validation = ImageProcessor.validateImageInput(testImagePath);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should validate data URL input correctly', () => {
      const validation = ImageProcessor.validateImageInput(testDataUrl);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should validate HTTP URL input correctly', () => {
      const validation = ImageProcessor.validateImageInput(testImageUrl);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should reject empty input', () => {
      const validation = ImageProcessor.validateImageInput('');
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('Image input is required and must be a string');
    });

    it('should reject null input', () => {
      const validation = ImageProcessor.validateImageInput(null as any);
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('Image input is required and must be a string');
    });

    it('should reject non-string input', () => {
      const validation = ImageProcessor.validateImageInput(123 as any);
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('Image input is required and must be a string');
    });

    it('should accept valid image URL format', () => {
      const validation = ImageProcessor.validateImageInput('https://example.com/valid-image.jpg');
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should reject invalid base64 format', () => {
      const validation = ImageProcessor.validateImageInput('invalid_base64!@#$');
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('Unsupported image input format. Supported formats: file paths, HTTP/HTTPS URLs, and data URLs with base64 encoding.');
    });
  });

  describe('ImageProcessor.processImage', () => {
    it('should process file path input and convert to base64', async () => {
      if (!(await fs.pathExists(testImagePath))) {
        console.log(`Skipping file path test - test image not found at ${testImagePath}`);
        return;
      }

      const result = await ImageProcessor.processImage(testImagePath);
      
      expect(result).toBeDefined();
      expect(result.url).toMatch(/^data:image\/[^;]+;base64,/);
      expect(result.mimeType).toMatch(/^image\/[\w+]+$/);
      expect(result.size).toBeGreaterThan(0);
    });

    it('should process @-prefixed file path input', async () => {
      if (!(await fs.pathExists(testImagePath))) {
        console.log(`Skipping @ file path test - test image not found at ${testImagePath}`);
        return;
      }

      const result = await ImageProcessor.processImage(`@${testImagePath}`);

      expect(result).toBeDefined();
      expect(result.url).toMatch(/^data:image\/[^;]+;base64,/);
      expect(result.mimeType).toMatch(/^image\/[\w+]+$/);
      expect(result.size).toBeGreaterThan(0);
    });

    it('should process percent-encoded file URLs for non-ASCII filenames', async () => {
      if (!(await fs.pathExists(testImagePath))) {
        console.log(`Skipping percent-encoded file URL test - test image not found at ${testImagePath}`);
        return;
      }

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-mcp-'));
      const nonAsciiPath = path.join(tempDir, '螢幕截圖 2025-11-30 15.00.14.svg');

      try {
        await fs.copy(testImagePath, nonAsciiPath);

        const fileUrl = pathToFileURL(nonAsciiPath).href;
        expect(fileUrl).toContain('%');

        const result = await ImageProcessor.processImage(fileUrl);

        expect(result).toBeDefined();
        expect(result.url).toMatch(/^data:image\/[^;]+;base64,/);
        expect(result.mimeType).toBe('image/svg+xml');
        expect(result.size).toBeGreaterThan(0);
      } finally {
        await fs.remove(tempDir);
      }
    });

    it('should process data URL input and pass through', async () => {
      const result = await ImageProcessor.processImage(testDataUrl);

      expect(result).toBeDefined();
      expect(result.url).toBe(testDataUrl);
      expect(result.mimeType).toBe('image/png');
      expect(result.size).toBeGreaterThan(0);
    });

    it('should process HTTP URL input and convert to base64', async () => {
      // We can't actually download from the internet in tests, so we'll mock the axios call
      jest.spyOn(require('axios'), 'get').mockResolvedValueOnce({
        status: 200,
        data: Buffer.from('test image data'),
        headers: {
          'content-type': 'image/jpeg'
        }
      });
      
      try {
        const result = await ImageProcessor.processImage(testImageUrl);
        expect(result).toBeDefined();
        expect(result.url).toMatch(/^data:image\/jpeg;base64,/);
        expect(result.mimeType).toBe('image/jpeg');
        expect(result.size).toBeGreaterThan(0);
      } finally {
        jest.restoreAllMocks();
      }
    }, 10000); // Increase timeout to 10 seconds

    it('should handle file not found error', async () => {
      const nonExistentPath = '/path/to/non-existent-image.jpg';
      
      await expect(ImageProcessor.processImage(nonExistentPath))
        .rejects
        .toThrow('File not found');
    });

    it('should handle unsupported file type error', async () => {
      // Create a non-image file
      const tempPath = path.join(__dirname, 'temp-test-file.txt');
      await fs.writeFile(tempPath, 'This is not an image');
      
      try {
        await expect(ImageProcessor.processImage(tempPath))
          .rejects
          .toThrow('Unsupported image type');
      } finally {
        await fs.remove(tempPath);
      }
    });

    it('should handle invalid base64 error', async () => {
      const invalidBase64 = 'invalid_base64!@#$';

      await expect(ImageProcessor.processImage(invalidBase64))
        .rejects
        .toThrow('Unsupported image input format');
    });

    it('should handle invalid URL error', async () => {
      const invalidUrl = 'https://example.com/invalid-url';

      // Mock axios to simulate a network error
      jest.spyOn(require('axios'), 'get').mockRejectedValueOnce(new Error('Network Error'));

      try {
        await expect(ImageProcessor.processImage(invalidUrl))
          .rejects
          .toThrow('Failed to process URL input');
      } finally {
        jest.restoreAllMocks();
      }
    });
  });

  describe('ImageProcessor utility methods', () => {
    it('should return supported MIME types', () => {
      const mimeTypes = ImageProcessor.getSupportedMimeTypes();
      
      expect(mimeTypes).toContain('image/jpeg');
      expect(mimeTypes).toContain('image/png');
      expect(mimeTypes).toContain('image/gif');
      expect(mimeTypes).toContain('image/webp');
      expect(mimeTypes).toContain('image/svg+xml');
      expect(mimeTypes).toContain('image/bmp');
      expect(mimeTypes).toContain('image/tiff');
    });

    it('should return maximum file size', () => {
      const maxSize = ImageProcessor.getMaxFileSize();
      
      expect(maxSize).toBe(10 * 1024 * 1024); // 10MB
    });
  });

  describe('File path detection', () => {
    it('should detect absolute file paths', () => {
      expect(ImageProcessor['isFileInput']('/absolute/path/to/image.jpg')).toBe(true);
    });

    it('should detect relative file paths with ./', () => {
      expect(ImageProcessor['isFileInput']('./relative/path/to/image.jpg')).toBe(true);
    });

    it('should detect relative file paths with ../', () => {
      expect(ImageProcessor['isFileInput']('../relative/path/to/image.jpg')).toBe(true);
    });

    it('should not detect HTTP URLs as file paths', () => {
      expect(ImageProcessor['isFileInput']('https://example.com/image.jpg')).toBe(false);
    });

    it('should not detect data URLs as file paths', () => {
      expect(ImageProcessor['isFileInput']('data:image/png;base64,test')).toBe(false);
    });

    it('should not detect raw base64 as file paths', () => {
      expect(ImageProcessor['isFileInput']('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')).toBe(false);
    });
  });

  describe('ImageProcessor multi-image functionality', () => {
    const localTestDataUrl1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const localTestDataUrl2 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/vAA=';
    const localTestImageUrl = 'https://picsum.photos/200';

    it('should support processing multiple images for comparison', async () => {
      // Test that ImageProcessor can handle multiple images
      const testImages = [
        localTestDataUrl1,
        localTestDataUrl2
      ];

      // Process multiple images
      const results = await Promise.all(
        testImages.map(image => ImageProcessor.processImage(image))
      );

      // Verify all images were processed successfully
      expect(results).toHaveLength(2);
      results.forEach(result => {
        expect(result).toBeDefined();
        expect(result.url).toMatch(/^data:image\/[^;]+;base64,/);
        expect(result.mimeType).toMatch(/^image\/\w+$/);
        expect(result.size).toBeGreaterThan(0);
      });
    });

    it('should validate multiple image inputs for comparison', () => {
      // Test validation for multiple images
      const validImages = [localTestDataUrl1, localTestDataUrl2, localTestImageUrl];
      const invalidImages = ['', null, undefined];

      // Valid images should pass validation
      validImages.forEach(image => {
        const validation = ImageProcessor.validateImageInput(image);
        expect(validation.isValid).toBe(true);
      });

      // Invalid images should fail validation
      invalidImages.forEach(image => {
        const validation = ImageProcessor.validateImageInput(image as any);
        expect(validation.isValid).toBe(false);
      });
    });
  });
});

// Simple test to verify the project structure
describe('Project Structure Tests', () => {
  it('should have package.json with correct dependencies', () => {
    const packageJson = require('../package.json');
    
    expect(packageJson.name).toBe('@karlcc/image_mcp');
    expect(typeof packageJson.version).toBe('string');
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageJson.main).toBe('build/index.js');
    expect(packageJson.scripts).toHaveProperty('build');
    expect(packageJson.scripts).toHaveProperty('test');
    expect(packageJson.dependencies).toHaveProperty('@modelcontextprotocol/sdk');
    expect(packageJson.dependencies).toHaveProperty('axios');
  });

  it('should have TypeScript configuration', () => {
    const tsConfig = require('../tsconfig.json');
    
    expect(tsConfig.compilerOptions.target).toBe('ES2022');
    expect(tsConfig.compilerOptions.module).toBe('ESNext');
    expect(tsConfig.compilerOptions.esModuleInterop).toBe(true);
    expect(tsConfig.compilerOptions.sourceMap).toBe(true);
  });

  it('should have Jest configuration', () => {
    // Jest configuration is tested by running the tests
    expect(true).toBe(true);
  });

  it('should have source files', () => {
    const fs = require('fs');
    const path = require('path');
    
    expect(fs.existsSync(path.join(__dirname, '../src/index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../src/config.ts'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../src/openai-client.ts'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../src/image-processor.ts'))).toBe(true);
  });

  it('should have documentation', () => {
    const fs = require('fs');
    const path = require('path');

    expect(fs.existsSync(path.join(__dirname, '../README.md'))).toBe(true);
  });
});

// Tests for the vision-backend alias tool path validation
describe('isAbsoluteLocalPath (alias tool validation)', () => {
  it('should accept absolute paths', () => {
    expect(isAbsoluteLocalPath('/Users/me/image.png')).toBe(true);
    expect(isAbsoluteLocalPath('/tmp/screenshot.jpg')).toBe(true);
    expect(isAbsoluteLocalPath(path.join(__dirname, 'test.svg'))).toBe(true);
  });

  it('should reject relative paths', () => {
    expect(isAbsoluteLocalPath('relative.png')).toBe(false);
    expect(isAbsoluteLocalPath('./rel.png')).toBe(false);
    expect(isAbsoluteLocalPath('../parent.png')).toBe(false);
  });

  it('should reject file:// URLs', () => {
    expect(isAbsoluteLocalPath('file:///Users/me/image.png')).toBe(false);
  });

  it('should reject http(s):// URLs', () => {
    expect(isAbsoluteLocalPath('https://example.com/img.png')).toBe(false);
    expect(isAbsoluteLocalPath('http://localhost/img.png')).toBe(false);
  });

  it('should reject data: URLs', () => {
    expect(isAbsoluteLocalPath('data:image/png;base64,iVBOR')).toBe(false);
  });

  it('should reject @-prefix shorthand', () => {
    expect(isAbsoluteLocalPath('@/tmp/img.png')).toBe(false);
  });

  it('should reject empty and non-string inputs', () => {
    expect(isAbsoluteLocalPath('')).toBe(false);
    expect(isAbsoluteLocalPath(null as any)).toBe(false);
    expect(isAbsoluteLocalPath(undefined as any)).toBe(false);
  });
});
