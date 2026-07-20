import { afterEach, describe, expect, it, vi } from "vitest";
import { createBatches, DEFAULT_OCR_PROMPT, mapConcurrent, OpenAiOcrProvider, parseResponsesPayload, parseResponsesStream, requestFailureMessage, responsesEndpoint, streamRequest } from "../src/openai-provider";

afterEach(() => vi.unstubAllGlobals());

describe("createBatches", () => {
  it("preserves order while splitting on image count", () => {
    const images = [1, 2, 3, 4, 5].map((id) => ({ id, bytes: 10 }));
    expect(createBatches(images, 2, 100).map((batch) => batch.map((image) => image.id))).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("starts a new batch before exceeding the byte limit", () => {
    const images = [{ id: 1, bytes: 60 }, { id: 2, bytes: 50 }, { id: 3, bytes: 40 }];
    expect(createBatches(images, 10, 100).map((batch) => batch.map((image) => image.id))).toEqual([[1], [2, 3]]);
  });
});

describe("mapConcurrent", () => {
  it("runs work concurrently while preserving result order", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapConcurrent([30, 10, 20, 5], 2, async (delay, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3]);
    expect(maxActive).toBe(2);
  });

  it("allows all items to start when concurrency equals item count", async () => {
    let active = 0;
    let maxActive = 0;
    await mapConcurrent([1, 2, 3, 4], 4, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(maxActive).toBe(4);
  });
});

describe("OpenAiOcrProvider", () => {
  it("starts OCR for a ready image without waiting for other downloads", async () => {
    let releaseSlowDownload: (() => void) | undefined;
    let resolveFastOcrStarted: (() => void) | undefined;
    const fastOcrStarted = new Promise<void>((resolve) => {
      resolveFastOcrStarted = resolve;
    });

    vi.stubGlobal("GM_xmlhttpRequest", (details: Tampermonkey.Request) => {
      if (details.method === "GET") {
        const finish = () => details.onload?.call({} as never, {
          response: new Blob(["image"]),
          responseText: "",
          status: 200,
          statusText: "OK"
        } as Tampermonkey.Response<Blob>);
        if (details.url === "https://images.example/slow") releaseSlowDownload = finish;
        else queueMicrotask(finish);
        return;
      }

      const data = JSON.parse(String(details.data)) as { input: Array<{ content: Array<{ text?: string }> }> };
      const imageId = data.input[0]?.content[0]?.text?.match(/in order, are: ([^.]+)/)?.[1] ?? "unknown";
      if (imageId === "fast") resolveFastOcrStarted?.();
      queueMicrotask(() => details.onload?.call({} as never, {
        response: { output_text: JSON.stringify({ results: [{ image_id: imageId, text: `text-${imageId}` }] }) },
        responseText: "",
        status: 200,
        statusText: "OK"
      } as Tampermonkey.Response<object>));
    });

    const recognition = new OpenAiOcrProvider("test-key").recognize([
      { id: "slow", index: 0, url: "https://images.example/slow" },
      { id: "fast", index: 1, url: "https://images.example/fast" }
    ]);

    await fastOcrStarted;
    expect(releaseSlowDownload).toBeTypeOf("function");
    releaseSlowDownload?.();
    await expect(recognition).resolves.toEqual({
      results: [
        { imageId: "slow", text: "text-slow" },
        { imageId: "fast", text: "text-fast" }
      ]
    });
  });

  it("uses independent non-streaming requests for every image", async () => {
    const postBodies: Array<{ stream?: boolean; input?: Array<{ content?: Array<{ text?: string }> }> }> = [];
    vi.stubGlobal("GM_xmlhttpRequest", (details: Tampermonkey.Request) => {
      if (details.method === "GET") {
        queueMicrotask(() => details.onload?.call({} as never, {
          response: new Blob(["image"]), responseText: "", status: 200, statusText: "OK"
        } as Tampermonkey.Response<Blob>));
        return;
      }
      const body = JSON.parse(String(details.data)) as { stream?: boolean; input: Array<{ content: Array<{ text?: string }> }> };
      postBodies.push(body);
      const imageId = body.input[0]?.content[0]?.text?.match(/in order, are: ([^.]+)/)?.[1] ?? "unknown";
      queueMicrotask(() => details.onload?.call({} as never, {
        response: { output_text: JSON.stringify({ results: [{ image_id: imageId, text: "ok" }] }) },
        responseText: "",
        status: 200,
        statusText: "OK"
      } as Tampermonkey.Response<object>));
    });

    await new OpenAiOcrProvider("test-key").recognize([
      { id: "one", index: 0, url: "https://images.example/one" },
      { id: "two", index: 1, url: "https://images.example/two" },
      { id: "three", index: 2, url: "https://images.example/three" }
    ]);

    expect(postBodies).toHaveLength(3);
    expect(postBodies.every((body) => body.stream === false)).toBe(true);
    const prompt = postBodies[0]?.input?.[0]?.content?.[0]?.text ?? "";
    expect(prompt).toContain("OCR only when text is a primary, meaningful part");
    expect(prompt).toContain("empty string as the only skip marker");
  });

  it("uses a one-time custom prompt without including the default prompt", async () => {
    let sentPrompt = "";
    vi.stubGlobal("GM_xmlhttpRequest", (details: Tampermonkey.Request) => {
      if (details.method === "GET") {
        queueMicrotask(() => details.onload?.call({} as never, {
          response: new Blob(["image"]), responseText: "", status: 200, statusText: "OK"
        } as Tampermonkey.Response<Blob>));
        return;
      }
      const body = JSON.parse(String(details.data)) as { input: Array<{ content: Array<{ text?: string }> }> };
      sentPrompt = body.input[0]?.content[0]?.text ?? "";
      queueMicrotask(() => details.onload?.call({} as never, {
        response: { output_text: JSON.stringify({ results: [{ image_id: "one", text: "ok" }] }) },
        responseText: "",
        status: 200,
        statusText: "OK"
      } as Tampermonkey.Response<object>));
    });

    await new OpenAiOcrProvider("test-key").recognize([
      { id: "one", index: 0, url: "https://images.example/one" }
    ], { prompt: "  Extract only handwritten Chinese.  " });

    expect(sentPrompt).toContain("Extract only handwritten Chinese.");
    expect(sentPrompt).toContain("The image IDs, in order, are: one.");
    expect(sentPrompt).not.toContain(DEFAULT_OCR_PROMPT);
  });

  it("falls back to the default prompt when the one-time prompt is blank", async () => {
    let sentPrompt = "";
    vi.stubGlobal("GM_xmlhttpRequest", (details: Tampermonkey.Request) => {
      if (details.method === "GET") {
        queueMicrotask(() => details.onload?.call({} as never, {
          response: new Blob(["image"]), responseText: "", status: 200, statusText: "OK"
        } as Tampermonkey.Response<Blob>));
        return;
      }
      const body = JSON.parse(String(details.data)) as { input: Array<{ content: Array<{ text?: string }> }> };
      sentPrompt = body.input[0]?.content[0]?.text ?? "";
      queueMicrotask(() => details.onload?.call({} as never, {
        response: { output_text: JSON.stringify({ results: [{ image_id: "one", text: "ok" }] }) },
        responseText: "",
        status: 200,
        statusText: "OK"
      } as Tampermonkey.Response<object>));
    });

    await new OpenAiOcrProvider("test-key").recognize([
      { id: "one", index: 0, url: "https://images.example/one" }
    ], { prompt: "   \n  " });

    expect(sentPrompt).toContain(DEFAULT_OCR_PROMPT);
  });

  it("keeps successful OCR results when another concurrent request fails", async () => {
    vi.stubGlobal("GM_xmlhttpRequest", (details: Tampermonkey.Request) => {
      if (details.method === "GET") {
        queueMicrotask(() => details.onload?.call({} as never, {
          response: new Blob(["image"]), responseText: "", status: 200, statusText: "OK"
        } as Tampermonkey.Response<Blob>));
        return;
      }
      const data = JSON.parse(String(details.data)) as { input: Array<{ content: Array<{ text?: string }> }> };
      const imageId = data.input[0]?.content[0]?.text?.match(/in order, are: ([^.]+)/)?.[1] ?? "unknown";
      if (imageId === "bad") {
        queueMicrotask(() => details.onerror?.call({} as never, {
          status: 502, statusText: "Bad Gateway", responseText: "upstream failed"
        } as Tampermonkey.ErrorResponse));
        return;
      }
      queueMicrotask(() => details.onload?.call({} as never, {
        response: { output_text: JSON.stringify({ results: [{ image_id: imageId, text: "success" }] }) },
        responseText: "",
        status: 200,
        statusText: "OK"
      } as Tampermonkey.Response<object>));
    });

    const result = await new OpenAiOcrProvider("test-key").recognize([
      { id: "good", index: 0, url: "https://images.example/good" },
      { id: "bad", index: 1, url: "https://images.example/bad" }
    ]);

    expect(result.results[0]).toEqual({ imageId: "good", text: "success" });
    expect(result.results[1]).toMatchObject({ imageId: "bad", text: "", error: expect.stringContaining("502") });
  });
});

describe("responsesEndpoint", () => {
  it("appends the Responses API path to a base URL", () => {
    expect(responsesEndpoint("https://api.openai.com/v1/"))
      .toBe("https://api.openai.com/v1/responses");
  });

  it("keeps a complete Responses API endpoint", () => {
    expect(responsesEndpoint("https://example.com/openai/v1/responses"))
      .toBe("https://example.com/openai/v1/responses");
  });

  it("rejects unsupported URL protocols", () => {
    expect(() => responsesEndpoint("file:///tmp/api")).toThrow("HTTP");
  });
});

describe("parseResponsesPayload", () => {
  it("uses an object response when Tampermonkey parsed JSON", () => {
    const payload = { output_text: "ok" };
    expect(parseResponsesPayload({ response: payload, responseText: "" })).toBe(payload);
  });

  it("falls back to responseText when response is undefined", () => {
    expect(parseResponsesPayload({ response: undefined, responseText: '{"output_text":"ok"}' }))
      .toEqual({ output_text: "ok" });
  });

  it("reports an empty response clearly", () => {
    expect(() => parseResponsesPayload({ response: undefined, responseText: "" })).toThrow("空响应");
  });

  it("includes the original body and JSON parser error", () => {
    expect(() => parseResponsesPayload({ response: undefined, responseText: "upstream exploded" }))
      .toThrow(/Unexpected token.*response=upstream exploded/);
  });
});

describe("requestFailureMessage", () => {
  it("keeps the actual Tampermonkey failure details", () => {
    expect(requestFailureMessage("请求失败", {
      status: 502,
      statusText: "Bad Gateway",
      error: "dns lookup failed",
      finalUrl: "https://proxy.example/v1/responses",
      responseText: "upstream unavailable"
    })).toBe("请求失败 | HTTP 502 Bad Gateway | error=dns lookup failed | url=https://proxy.example/v1/responses | response=upstream unavailable");
  });
});

describe("parseResponsesStream", () => {
  it("joins output text deltas from SSE events", () => {
    const raw = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"results\\":"}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"[]}"}',
      'data: [DONE]'
    ].join("\n\n");
    expect(parseResponsesStream(raw)).toEqual({ output_text: '{"results":[]}' });
  });

  it("returns the completed response when no deltas are emitted", () => {
    const response = { output_text: '{"results":[]}' };
    const raw = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}`;
    expect(parseResponsesStream(raw)).toEqual(response);
  });

  it("surfaces a streaming error event", () => {
    const raw = 'event: error\ndata: {"type":"error","message":"upstream timeout"}';
    expect(() => parseResponsesStream(raw)).toThrow("upstream timeout");
  });
});

describe("streamRequest", () => {
  it("waits for the final response instead of using the provisional onloadstart status", async () => {
    const raw = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"results\\":[]}"}\n\ndata: [DONE]';
    const bytes = new TextEncoder().encode(raw);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
    vi.stubGlobal("GM_xmlhttpRequest", (details: Tampermonkey.Request) => {
      const provisional = { response: stream, status: 0 } as Tampermonkey.Response<object>;
      details.onloadstart?.call(provisional, provisional);
      queueMicrotask(() => {
        const final = { response: stream, responseText: "", status: 200, statusText: "OK" } as Tampermonkey.Response<object>;
        details.onload?.call(final, final);
      });
    });

    const result = await streamRequest({ method: "POST", url: "https://example.com/v1/responses" });
    expect(result.response.status).toBe(200);
    expect(result.payload.output_text).toBe('{"results":[]}');
  });
});
