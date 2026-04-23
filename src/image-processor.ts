import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'node:url';
import mimeTypes from 'mime-types';
import axios from 'axios';

export interface ImageInfo {
  type: 'file' | 'base64' | 'url';
  data: string;
  mimeType: string;
  size: number;
}

export interface ProcessedImage {
  url: string;
  mimeType: string;
  size: number;
}

export class ImageProcessor {
  private static readonly SUPPORTED_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/bmp',
    'image/tiff',
  ]);

  private static readonly SUPPORTED_FILE_EXTENSIONS = new Set([
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'bmp',
    'tiff',
    'tif',
    'svg',
  ]);

  private static readonly HTTP_URL_PATTERN = /^https?:\/\/.+/i;
  private static readonly HTTP_URL_WITH_PATH_PATTERN = /^https?:\/\/.+\/.+$/i;

  private static readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  private static readonly UNSUPPORTED_INPUT_MESSAGE =
    'Unsupported image input format. Supported formats: file paths, HTTP/HTTPS URLs, and data URLs with base64 encoding.';

  /** Supports "@path" local file shorthand used by some MCP clients. */
  private static normalizeImageInput(imageInput: string): string {
    const trimmedInput = imageInput.trim();
    return trimmedInput.startsWith('@') ? trimmedInput.substring(1) : trimmedInput;
  }

  private static expandTilde(p: string): string {
    return p.startsWith('~') ? path.join(process.env.HOME || '', p.substring(1)) : p;
  }

  static async processImage(imageInput: string): Promise<ProcessedImage> {
    let processedInput = this.normalizeImageInput(imageInput);

    // Handle file:// URLs using Node's built-in decoder (handles percent-encoded non-ASCII correctly)
    if (processedInput.startsWith('file://')) {
      try {
        processedInput = fileURLToPath(processedInput);
      } catch {
        // Fallback: strip prefix naively if URL parsing fails
        processedInput = processedInput.substring(7);
      }
    }

    // Basic validation after processing the input
    const validation = this.validateImageInput(processedInput);
    if (!validation.isValid) {
      throw new Error(`Invalid image input: ${validation.errors.join(', ')}`);
    }

    let imageInfo: ImageInfo;

    if (processedInput.startsWith('data:image/') && processedInput.includes('base64')) {
      imageInfo = await this.processBase64Input(processedInput);
    } else if (this.HTTP_URL_PATTERN.test(processedInput)) {
      imageInfo = await this.processUrlInput(processedInput);
    } else if (this.isFileInput(processedInput)) {
      imageInfo = await this.processFileInput(processedInput);
    } else {
      // Last-resort fallback: probe filesystem for non-ASCII or unusual paths
      // that don't match heuristics (e.g. 桌面/截图 with no prefix or extension)
      const expandedPath = this.expandTilde(processedInput);
      const absolutePath = path.resolve(expandedPath);
      try {
        const stats = await fs.stat(absolutePath);
        if (stats.isFile()) {
          imageInfo = await this.processFileInput(processedInput);
        } else {
          throw new Error(this.UNSUPPORTED_INPUT_MESSAGE);
        }
      } catch (e: any) {
        if (e.message?.startsWith('Unsupported')) throw e;
        throw new Error(this.UNSUPPORTED_INPUT_MESSAGE);
      }
    }

    // Convert to URL format
    const url = this.formatImageUrl(imageInfo);

    return {
      url,
      mimeType: imageInfo.mimeType,
      size: imageInfo.size,
    };
  }

  private static isFileInput(input: string): boolean {
    const isWindowsDrivePath = /^[A-Za-z]:[\\/]/.test(input);
    const isUncPath = input.startsWith('\\\\');

    if (this.HTTP_URL_PATTERN.test(input)) {
      return false;
    }

    if (input.startsWith('file://')) {
      return true;
    }

    if (input.startsWith('data:image/') && input.includes('base64')) {
      return false;
    }

    return (
      input.startsWith('/') ||
      input.startsWith('~') ||
      input.startsWith('../') ||
      isWindowsDrivePath ||
      isUncPath ||
      !!input.match(/^\.[/\\]/) ||
      this.SUPPORTED_FILE_EXTENSIONS.has(path.extname(input).toLowerCase().replace(/^\./, ''))
    );
  }

  private static async processFileInput(filePath: string): Promise<ImageInfo> {
    try {
      const absolutePath = path.resolve(this.expandTilde(filePath));

      let stats;
      try {
        stats = await fs.stat(absolutePath);
      } catch (e: any) {
        if (e.code === 'ENOENT') {
          throw new Error(`File not found: ${filePath}`);
        }
        throw e;
      }

      if (stats.size > this.MAX_FILE_SIZE) {
        throw new Error(`File size exceeds maximum limit of ${this.MAX_FILE_SIZE} bytes`);
      }

      const mimeType = mimeTypes.lookup(absolutePath) || 'application/octet-stream';

      if (!this.SUPPORTED_MIME_TYPES.has(mimeType)) {
        throw new Error(`Unsupported image type: ${mimeType}`);
      }

      const base64Data = await fs.readFile(absolutePath, 'base64');

      return {
        type: 'file',
        data: base64Data,
        mimeType,
        size: stats.size,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to process file input: ${error.message}`);
      }
      throw error;
    }
  }

  private static async processUrlInput(url: string): Promise<ImageInfo> {
    try {
      if (!this.HTTP_URL_WITH_PATH_PATTERN.test(url)) {
        throw new Error(`Invalid image URL format: ${url}`);
      }

      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000, // 30 seconds timeout
        maxRedirects: 5,
      });

      if (response.status !== 200) {
        throw new Error(`Failed to download image. HTTP status: ${response.status}`);
      }

      const imageData = Buffer.from(response.data);
      const size = imageData.length;

      if (size > this.MAX_FILE_SIZE) {
        throw new Error(`Image size exceeds maximum limit of ${this.MAX_FILE_SIZE} bytes`);
      }

      let mimeType = response.headers['content-type'];
      if (!mimeType) {
        const ext = path.extname(new URL(url).pathname).toLowerCase();
        mimeType = mimeTypes.lookup(ext) || 'image/jpeg';
      }

      if (!this.SUPPORTED_MIME_TYPES.has(mimeType)) {
        throw new Error(`Unsupported image type: ${mimeType}`);
      }

      const base64Data = imageData.toString('base64');

      return {
        type: 'url',
        data: base64Data,
        mimeType,
        size,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to process URL input: ${error.message}`);
      }
      throw error;
    }
  }

  private static async processBase64Input(base64Input: string): Promise<ImageInfo> {
    try {
      const base64Match = base64Input.match(/^data:([^;]+);base64,/);
      let mimeType = 'image/jpeg';
      
      if (base64Match) {
        mimeType = base64Match[1] || 'image/jpeg';
        base64Input = base64Input.replace(/^data:[^;]+;base64,/, '');
      }

      if (!this.SUPPORTED_MIME_TYPES.has(mimeType)) {
        throw new Error(`Unsupported image type: ${mimeType}`);
      }

      const base64Length = base64Input.length;
      const size = Math.floor(base64Length * 3 / 4); // Approximate size in bytes
      
      if (size > this.MAX_FILE_SIZE) {
        throw new Error(`Base64 image exceeds maximum limit of ${this.MAX_FILE_SIZE} bytes`);
      }

      if (!this.isValidBase64(base64Input)) {
        throw new Error('Invalid base64 format');
      }

      return {
        type: 'base64',
        data: base64Input,
        mimeType,
        size,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to process base64 input: ${error.message}`);
      }
      throw error;
    }
  }

  private static formatImageUrl(imageInfo: ImageInfo): string {
    return `data:${imageInfo.mimeType};base64,${imageInfo.data}`;
  }

  private static isValidBase64(str: string): boolean {
    try {
      // Remove whitespace
      const cleanStr = str.replace(/\s/g, '');
      
      // Check if it's valid base64
      return /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/.test(cleanStr);
    } catch {
      return false;
    }
  }

  static getSupportedMimeTypes(): string[] {
    return [...this.SUPPORTED_MIME_TYPES];
  }

  static getMaxFileSize(): number {
    return this.MAX_FILE_SIZE;
  }

  static validateImageInput(imageInput: string): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!imageInput || typeof imageInput !== 'string') {
      errors.push('Image input is required and must be a string');
      return { isValid: false, errors };
    }

    const normalizedInput = this.normalizeImageInput(imageInput);

    if (normalizedInput.length === 0) {
      errors.push('Image input cannot be empty');
    }

    if (normalizedInput.length > 200 * 1024) { // 200KB limit for string input
      errors.push('Image input is too large (max 200KB)');
    }

    // Check if it looks like a file path
    if (this.isFileInput(normalizedInput)) {
      if (!normalizedInput.match(/^[\/.]/) && !normalizedInput.includes('.')) {
        errors.push('File path must be absolute, relative, or include a file extension');
      }
    } else if (this.HTTP_URL_PATTERN.test(normalizedInput)) {
      // URL validation
      if (!this.HTTP_URL_WITH_PATH_PATTERN.test(normalizedInput)) {
        errors.push('Invalid image URL format. Supported formats: jpg, jpeg, png, gif, webp, bmp, tiff');
      }
    } else if (normalizedInput.startsWith('data:image/') && normalizedInput.includes('base64')) {
      // Data URL validation - this is valid
    } else {
      // Unsupported input format
      errors.push(this.UNSUPPORTED_INPUT_MESSAGE);
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

}
