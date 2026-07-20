export interface NoteMetadata {
  id: string;
  url: string;
  title?: string;
  author?: string;
  authorUrl?: string;
  publishedAt?: string;
  ipLocation?: string;
  body?: string;
  tags: string[];
  likes?: string;
  collects?: string;
  comments?: string;
}

export interface NoteImage {
  id: string;
  index: number;
  url: string;
}

export interface Note {
  metadata: NoteMetadata;
  images: NoteImage[];
}

export interface OcrImageResult {
  imageId: string;
  text: string;
  error?: string;
}

export interface OcrBatchResult {
  results: OcrImageResult[];
}

export interface OcrOptions {
  model?: string;
  prompt?: string;
  onProgress?: (completed: number, total: number, phase?: "download" | "ocr", active?: number) => void;
}

export interface OcrProvider {
  recognize(images: NoteImage[], options?: OcrOptions): Promise<OcrBatchResult>;
}

export interface AppSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
}
