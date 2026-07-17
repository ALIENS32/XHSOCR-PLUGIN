import type { NoteImage, OcrBatchResult, OcrImageResult, OcrOptions, OcrProvider } from "./types";

interface PreparedImage extends NoteImage {
  dataUrl: string;
  bytes: number;
}

interface ResponsesPayload {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string; type?: string; code?: string } | string;
}

const MAX_IMAGES_PER_BATCH = 1;
const MAX_BATCH_BYTES = 18 * 1024 * 1024;
const OCR_TIMEOUT_MS = 240_000;

export async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, runWorker));
  return results;
}

export function responsesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const url = new URL(trimmed || "https://api.openai.com/v1");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Base URL 仅支持 HTTP 或 HTTPS");
  return url.pathname.endsWith("/responses") ? url.toString().replace(/\/$/, "") : `${url.toString().replace(/\/$/, "")}/responses`;
}

function request(details: Tampermonkey.Request): Promise<Tampermonkey.Response<unknown>> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      ...details,
      onload: resolve,
      onerror: (response) => reject(new Error(requestFailureMessage("请求失败", response))),
      onabort: () => reject(new Error(`请求已中止 | url=${String(details.url)}`)),
      ontimeout: () => reject(new Error(`请求超时 | timeout=${details.timeout ?? 90_000}ms | url=${String(details.url)}`)),
      timeout: details.timeout ?? 90_000
    });
  });
}

export function parseResponsesStream(raw: string): ResponsesPayload {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("API 返回了空的 SSE 响应");
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    try {
      return JSON.parse(trimmed) as ResponsesPayload;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`API 流式响应不是有效的 SSE 或 JSON | ${reason} | response=${raw}`);
    }
  }

  let output = "";
  let completed: ResponsesPayload | undefined;
  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`无法解析 SSE 事件 | ${reason} | data=${data}`);
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") output += event.delta;
    if (event.type === "response.completed" && event.response && typeof event.response === "object") {
      completed = event.response as ResponsesPayload;
    }
    if (event.type === "error" || event.type === "response.failed") {
      throw new Error(`API 流式请求失败 | event=${data}`);
    }
  }
  if (output) return { output_text: output };
  if (completed) return completed;
  throw new Error(`SSE 响应中没有 output_text 或 response.completed | response=${raw}`);
}

export function streamRequest(details: Tampermonkey.Request): Promise<{ response: Tampermonkey.Response<unknown>; payload: ResponsesPayload }> {
  return new Promise((resolve, reject) => {
    let streamStarted = false;
    let settled = false;
    let streamPayload: ResponsesPayload | undefined;
    let finalResponse: Tampermonkey.Response<unknown> | undefined;
    let streamFinished = false;
    let loadFinished = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const finish = () => {
      if (settled || !loadFinished || !finalResponse) return;
      if (streamStarted && (!streamFinished || !streamPayload)) return;
      try {
        const payload = streamStarted ? streamPayload as ResponsesPayload : parseResponsesPayload(finalResponse);
        settled = true;
        resolve({ response: finalResponse, payload });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    GM_xmlhttpRequest({
      ...details,
      responseType: "stream",
      timeout: details.timeout ?? OCR_TIMEOUT_MS,
      onloadstart: (response) => {
        const stream = response.response as ReadableStream<Uint8Array> | undefined;
        if (!stream?.getReader) return;
        streamStarted = true;
        void (async () => {
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          let raw = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              raw += decoder.decode(value, { stream: true });
            }
            raw += decoder.decode();
            streamPayload = parseResponsesStream(raw);
            streamFinished = true;
            finish();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      },
      onload: (response) => {
        finalResponse = response;
        loadFinished = true;
        finish();
      },
      onerror: (response) => fail(new Error(requestFailureMessage("流式请求失败", response))),
      onabort: () => fail(new Error(`流式请求已中止 | url=${String(details.url)}`)),
      ontimeout: () => fail(new Error(`流式请求超时 | timeout=${details.timeout ?? OCR_TIMEOUT_MS}ms | url=${String(details.url)}`))
    });
  });
}

export function requestFailureMessage(
  label: string,
  response: Partial<Tampermonkey.ErrorResponse & Tampermonkey.Response<unknown>>
): string {
  const parts = [label];
  if (response.status !== undefined) parts.push(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
  if (response.error) parts.push(`error=${response.error}`);
  if (response.finalUrl) parts.push(`url=${response.finalUrl}`);
  const body = typeof response.responseText === "string" ? response.responseText.trim() : "";
  if (body) parts.push(`response=${body}`);
  return parts.join(" | ");
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

async function compressImage(blob: Blob): Promise<Blob> {
  if (blob.size <= 2_500_000) return blob;
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((output) => resolve(output ?? blob), "image/jpeg", 0.9));
}

async function prepareImage(image: NoteImage): Promise<PreparedImage> {
  const response = await request({ method: "GET", url: image.url, responseType: "blob" });
  if (response.status < 200 || response.status >= 300 || !(response.response instanceof Blob)) {
    throw new Error(`图片 ${image.index} 下载失败（HTTP ${response.status}）`);
  }
  const blob = await compressImage(response.response);
  return { ...image, dataUrl: await blobToDataUrl(blob), bytes: blob.size };
}

export function createBatches<T extends { bytes: number }>(images: T[], maxImages = MAX_IMAGES_PER_BATCH, maxBytes = MAX_BATCH_BYTES): T[][] {
  const output: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const image of images) {
    if (current.length && (current.length >= maxImages || bytes + image.bytes > maxBytes)) {
      output.push(current);
      current = [];
      bytes = 0;
    }
    current.push(image);
    bytes += image.bytes;
  }
  if (current.length) output.push(current);
  return output;
}

function responseText(payload: ResponsesPayload): string {
  if (payload.output_text) return payload.output_text;
  return payload.output?.flatMap((item) => item.content ?? []).find((content) => content.type === "output_text")?.text ?? "";
}

export function parseResponsesPayload(response: Pick<Tampermonkey.Response<unknown>, "response" | "responseText">): ResponsesPayload {
  if (response.response && typeof response.response === "object") return response.response as ResponsesPayload;
  const raw = typeof response.response === "string" && response.response.trim()
    ? response.response
    : response.responseText;
  if (!raw?.trim()) throw new Error("API 返回了空响应");
  try {
    return JSON.parse(raw) as ResponsesPayload;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`API 返回的不是有效 JSON | ${reason} | response=${raw}`);
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
}

function apiError(payload: ResponsesPayload): string | undefined {
  if (typeof payload.error === "string") return payload.error;
  if (!payload.error) return undefined;
  return [payload.error.message, payload.error.type, payload.error.code].filter(Boolean).join(" | ");
}

export class OpenAiOcrProvider implements OcrProvider {
  private readonly endpoint: string;

  constructor(private readonly apiKey: string, baseUrl = "https://api.openai.com/v1") {
    this.endpoint = responsesEndpoint(baseUrl);
  }

  async recognize(images: NoteImage[], options: OcrOptions = {}): Promise<OcrBatchResult> {
    let completed = 0;
    let active = 0;
    const results = await mapConcurrent(images, images.length, async (image) => {
      active += 1;
      options.onProgress?.(completed, images.length, "ocr", active);
      try {
        // Keep each image in one independent pipeline so a slow download cannot
        // delay OCR requests for images that are already ready.
        const prepared = await prepareImage(image);
        const [result] = await this.recognizeBatch([prepared], options.model ?? "gpt-5-mini");
        return result ?? { imageId: image.id, text: "", error: "未返回 OCR 结果" };
      } catch (error) {
        return { imageId: image.id, text: "", error: safeError(error) };
      } finally {
        active -= 1;
        completed += 1;
        options.onProgress?.(completed, images.length, "ocr", active);
      }
    });
    return { results };
  }

  private async recognizeBatch(images: PreparedImage[], model: string): Promise<OcrImageResult[]> {
    const content: Array<Record<string, unknown>> = [{
      type: "input_text",
      text: [
        "First make a quick visual decision: OCR only when text is a primary, meaningful part of the image.",
        "Return an empty string immediately for ordinary photos, selfies, scenery, product/lifestyle images, artwork, or illustrations that are not intended to convey textual information.",
        "Also return an empty string when the only text is incidental, such as a watermark, logo, username overlay, camera timestamp, UI label, price tag, packaging label, or distant sign.",
        "Do transcribe text-centric content such as documents, slides, posters, infographics, chat records, and screenshots whose main information is text.",
        "For images that qualify, transcribe all meaningful visible text faithfully.",
        "Preserve reasonable reading order and line breaks. Do not summarize, translate, describe, or correct the text.",
        "Do not explain the decision or describe skipped images; use an empty string as the only skip marker.",
        `The image IDs, in order, are: ${images.map((image) => image.id).join(", ")}.`
      ].join("\n")
    }];
    for (const image of images) content.push({ type: "input_image", image_url: image.dataUrl, detail: "high" });

    const body = {
      model,
      stream: false,
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "ocr_results",
          strict: true,
          schema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: { image_id: { type: "string" }, text: { type: "string" } },
                  required: ["image_id", "text"],
                  additionalProperties: false
                }
              }
            },
            required: ["results"],
            additionalProperties: false
          }
        }
      }
    };
    const response = await request({
      method: "POST",
      url: this.endpoint,
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
      data: JSON.stringify(body),
      responseType: "json",
      timeout: OCR_TIMEOUT_MS
    });
    const payload = parseResponsesPayload(response);
    if (response.status < 200 || response.status >= 300) {
      throw new Error([
        `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        apiError(payload),
        `response=${response.responseText || JSON.stringify(payload)}`
      ].filter(Boolean).join(" | "));
    }
    const output = responseText(payload);
    if (!output) throw new Error(`API 响应中没有可用的 output_text | response=${response.responseText || JSON.stringify(payload)}`);
    let parsed: { results?: Array<{ image_id?: string; text?: string }> };
    try {
      parsed = JSON.parse(output) as typeof parsed;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`output_text 不是有效 JSON | ${reason} | output_text=${output}`);
    }
    const allowed = new Set(images.map((image) => image.id));
    const byId = new Map((parsed.results ?? []).filter((item) => item.image_id && allowed.has(item.image_id)).map((item) => [item.image_id as string, item.text ?? ""]));
    return images.map((image) => byId.has(image.id)
      ? { imageId: image.id, text: byId.get(image.id) ?? "" }
      : { imageId: image.id, text: "", error: "模型未返回该图片的结果" });
  }
}
