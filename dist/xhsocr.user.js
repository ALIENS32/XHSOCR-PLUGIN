// ==UserScript==
// @name         Xiaohongshu OCR Markdown Exporter
// @namespace    https://github.com/local/xhsocr
// @version      0.1.0
// @author       xhsocr
// @description  Extract the current Xiaohongshu image note and export OCR-enhanced Markdown.
// @match        https://www.xiaohongshu.com/explore/*
// @match        https://www.xiaohongshu.com/discovery/item/*
// @connect      *
// @connect      *.xhscdn.com
// @connect      *.xhscdn.net
// @grant        GM_addStyle
// @grant        GM_deleteValue
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  const cleanInline = (value) => value.replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>])/g, "\\$1").trim();
  function field(label, value) {
    return value ? `- ${label}: ${cleanInline(value)}` : void 0;
  }
  class MarkdownRenderer {
    render(note, results) {
      var _a;
      const resultMap = new Map(results.map((result) => [result.imageId, result]));
      const { metadata } = note;
      const lines = [
        `# ${cleanInline(metadata.title || "小红书笔记")}`,
        "",
        field("作者", metadata.author),
        field("作者主页", metadata.authorUrl),
        field("发布时间", metadata.publishedAt),
        field("IP 属地", metadata.ipLocation),
        field("点赞", metadata.likes),
        field("收藏", metadata.collects),
        field("评论", metadata.comments),
        field("笔记 ID", metadata.id),
        field("原链接", metadata.url),
        metadata.tags.length ? `- 标签: ${metadata.tags.map((tag) => `#${cleanInline(tag)}`).join(" ")}` : void 0,
        "",
        (_a = metadata.body) == null ? void 0 : _a.trim(),
        ""
      ].filter((line) => line !== void 0);
      for (const image of note.images) {
        const result = resultMap.get(image.id);
        lines.push(`<!-- image: ${image.index} -->`, "");
        if (result == null ? void 0 : result.error) lines.push(`> OCR failed: ${cleanInline(result.error)}`, "");
        else if (result == null ? void 0 : result.text.trim()) lines.push(result.text.trim(), "");
      }
      return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}
`;
    }
  }
  const OCR_TIMEOUT_MS = 24e4;
  const DEFAULT_OCR_PROMPT = [
    "First make a quick visual decision: OCR only when text is a primary, meaningful part of the image.",
    "Return an empty string immediately for ordinary photos, selfies, scenery, product/lifestyle images, artwork, or illustrations that are not intended to convey textual information.",
    "Also return an empty string when the only text is incidental, such as a watermark, logo, username overlay, camera timestamp, UI label, price tag, packaging label, or distant sign.",
    "Do transcribe text-centric content such as documents, slides, posters, infographics, chat records, and screenshots whose main information is text.",
    "For images that qualify, transcribe all meaningful visible text faithfully.",
    "Preserve reasonable reading order and line breaks. Do not summarize, translate, describe, or correct the text.",
    "Do not explain the decision or describe skipped images; use an empty string as the only skip marker."
  ].join("\n");
  async function mapConcurrent(items, concurrency, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const runWorker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, runWorker));
    return results;
  }
  function responsesEndpoint(baseUrl) {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    const url = new URL(trimmed || "https://api.openai.com/v1");
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Base URL 仅支持 HTTP 或 HTTPS");
    return url.pathname.endsWith("/responses") ? url.toString().replace(/\/$/, "") : `${url.toString().replace(/\/$/, "")}/responses`;
  }
  function request(details) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...details,
        onload: resolve,
        onerror: (response) => reject(new Error(requestFailureMessage("请求失败", response))),
        onabort: () => reject(new Error(`请求已中止 | url=${String(details.url)}`)),
        ontimeout: () => reject(new Error(`请求超时 | timeout=${details.timeout ?? 9e4}ms | url=${String(details.url)}`)),
        timeout: details.timeout ?? 9e4
      });
    });
  }
  function requestFailureMessage(label, response) {
    const parts = [label];
    if (response.status !== void 0) parts.push(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    if (response.error) parts.push(`error=${response.error}`);
    if (response.finalUrl) parts.push(`url=${response.finalUrl}`);
    const body = typeof response.responseText === "string" ? response.responseText.trim() : "";
    if (body) parts.push(`response=${body}`);
    return parts.join(" | ");
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
      reader.readAsDataURL(blob);
    });
  }
  async function compressImage(blob) {
    var _a;
    if (blob.size <= 25e5) return blob;
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    (_a = canvas.getContext("2d")) == null ? void 0 : _a.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Promise((resolve) => canvas.toBlob((output) => resolve(output ?? blob), "image/jpeg", 0.9));
  }
  async function prepareImage(image) {
    const response = await request({ method: "GET", url: image.url, responseType: "blob" });
    if (response.status < 200 || response.status >= 300 || !(response.response instanceof Blob)) {
      throw new Error(`图片 ${image.index} 下载失败（HTTP ${response.status}）`);
    }
    const blob = await compressImage(response.response);
    return { ...image, dataUrl: await blobToDataUrl(blob), bytes: blob.size };
  }
  function responseText(payload) {
    var _a, _b;
    if (payload.output_text) return payload.output_text;
    return ((_b = (_a = payload.output) == null ? void 0 : _a.flatMap((item) => item.content ?? []).find((content) => content.type === "output_text")) == null ? void 0 : _b.text) ?? "";
  }
  function parseResponsesPayload(response) {
    if (response.response && typeof response.response === "object") return response.response;
    const raw = typeof response.response === "string" && response.response.trim() ? response.response : response.responseText;
    if (!(raw == null ? void 0 : raw.trim())) throw new Error("API 返回了空响应");
    try {
      return JSON.parse(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`API 返回的不是有效 JSON | ${reason} | response=${raw}`);
    }
  }
  function safeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
  }
  function apiError(payload) {
    if (typeof payload.error === "string") return payload.error;
    if (!payload.error) return void 0;
    return [payload.error.message, payload.error.type, payload.error.code].filter(Boolean).join(" | ");
  }
  class OpenAiOcrProvider {
    constructor(apiKey, baseUrl = "https://api.openai.com/v1") {
      __publicField(this, "endpoint");
      this.apiKey = apiKey;
      this.endpoint = responsesEndpoint(baseUrl);
    }
    async recognize(images, options = {}) {
      let completed = 0;
      let active = 0;
      const results = await mapConcurrent(images, images.length, async (image) => {
        var _a, _b;
        active += 1;
        (_a = options.onProgress) == null ? void 0 : _a.call(options, completed, images.length, "ocr", active);
        try {
          const prepared = await prepareImage(image);
          const [result] = await this.recognizeBatch([prepared], options.model ?? "gpt-5-mini", options.prompt);
          return result ?? { imageId: image.id, text: "", error: "未返回 OCR 结果" };
        } catch (error) {
          return { imageId: image.id, text: "", error: safeError(error) };
        } finally {
          active -= 1;
          completed += 1;
          (_b = options.onProgress) == null ? void 0 : _b.call(options, completed, images.length, "ocr", active);
        }
      });
      return { results };
    }
    async recognizeBatch(images, model, prompt) {
      const effectivePrompt = (prompt == null ? void 0 : prompt.trim()) || DEFAULT_OCR_PROMPT;
      const content = [{
        type: "input_text",
        text: [
          effectivePrompt,
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
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`output_text 不是有效 JSON | ${reason} | output_text=${output}`);
      }
      const allowed = new Set(images.map((image) => image.id));
      const byId = new Map((parsed.results ?? []).filter((item) => item.image_id && allowed.has(item.image_id)).map((item) => [item.image_id, item.text ?? ""]));
      return images.map((image) => byId.has(image.id) ? { imageId: image.id, text: byId.get(image.id) ?? "" } : { imageId: image.id, text: "", error: "模型未返回该图片的结果" });
    }
  }
  const SETTINGS_KEY = "xhsocr.settings";
  const defaults = {
    apiKey: "",
    model: "gpt-5-mini",
    baseUrl: "https://api.openai.com/v1"
  };
  async function loadSettings() {
    const value = await GM_getValue(SETTINGS_KEY, {});
    return { ...defaults, ...value };
  }
  async function saveSettings(settings) {
    await GM_setValue(SETTINGS_KEY, settings);
  }
  async function clearSettings() {
    await GM_deleteValue(SETTINGS_KEY);
  }
  const CSS = `
#xhsocr-root{all:initial;position:fixed;z-index:2147483647;right:20px;bottom:20px;font-family:system-ui,-apple-system,sans-serif;color:#1f2328}
#xhsocr-root *{box-sizing:border-box}
.xhsocr-fab{border:0;border-radius:999px;background:#ff2442;color:white;padding:12px 16px;font-weight:700;box-shadow:0 4px 18px #0003;cursor:pointer}
.xhsocr-panel{position:fixed;right:20px;bottom:76px;width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 110px);overflow:auto;background:#fff;border:1px solid #ddd;border-radius:14px;box-shadow:0 12px 40px #0004;padding:16px;font-size:14px;line-height:1.5}
.xhsocr-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.xhsocr-head strong{font-size:17px}
.xhsocr-row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.xhsocr-row button{border:1px solid #ccc;background:#fff;border-radius:8px;padding:7px 11px;cursor:pointer}.xhsocr-row button.primary{background:#ff2442;border-color:#ff2442;color:#fff}
.xhsocr-field{display:block;margin:9px 0}.xhsocr-field span{display:block;margin-bottom:4px;color:#57606a}.xhsocr-field input,.xhsocr-field textarea{width:100%;padding:8px;border:1px solid #bbb;border-radius:7px}.xhsocr-field textarea{min-height:96px;resize:vertical;font:inherit}
.xhsocr-status{padding:9px;background:#f6f8fa;border-radius:8px;margin:10px 0;white-space:pre-wrap}.xhsocr-error{background:#ffebe9;color:#82071e}
.xhsocr-output{width:100%;min-height:300px;resize:vertical;border:1px solid #bbb;border-radius:8px;padding:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.xhsocr-note{font-size:12px;color:#656d76}.xhsocr-hidden{display:none}
`;
  function filename(note) {
    const title = (note.metadata.title || "xiaohongshu-note").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${title}-${note.metadata.id}.md`;
  }
  class AppUi {
    constructor(extractor) {
      __publicField(this, "panel");
      __publicField(this, "status");
      __publicField(this, "output");
      __publicField(this, "lastMarkdown", "");
      __publicField(this, "lastNote");
      __publicField(this, "lastResults", []);
      this.extractor = extractor;
    }
    mount() {
      var _a, _b, _c, _d, _e, _f;
      if (document.querySelector("#xhsocr-root")) return;
      GM_addStyle(CSS);
      const root = document.createElement("div");
      root.id = "xhsocr-root";
      root.innerHTML = `
      <button class="xhsocr-fab" type="button">OCR 导出</button>
      <div class="xhsocr-panel xhsocr-hidden">
        <div class="xhsocr-head"><strong>小红书 OCR</strong><button data-action="close" type="button">关闭</button></div>
        <div data-view="settings"></div>
        <label class="xhsocr-field"><span>本次 OCR 提示词（留空使用默认提示词）</span><textarea data-field="prompt" placeholder="仅用于本次 OCR，不会保存或覆盖默认提示词"></textarea></label>
        <div class="xhsocr-status">准备就绪</div>
        <textarea class="xhsocr-output xhsocr-hidden" spellcheck="false" aria-label="Markdown result"></textarea>
        <div class="xhsocr-row">
          <button class="primary" data-action="run" type="button">解析并 OCR</button>
          <button data-action="retry" type="button" disabled>重试失败图片</button>
          <button data-action="copy" type="button" disabled>复制</button>
          <button data-action="download" type="button" disabled>下载 Markdown</button>
        </div>
        <p class="xhsocr-note">图片会发送到配置的 OCR API。API Key 保存在本机 Tampermonkey 存储中，但纯浏览器方案无法提供服务端级别的密钥隔离。</p>
      </div>`;
      document.body.append(root);
      this.panel = root.querySelector(".xhsocr-panel");
      this.status = root.querySelector(".xhsocr-status");
      this.output = root.querySelector(".xhsocr-output");
      (_a = root.querySelector(".xhsocr-fab")) == null ? void 0 : _a.addEventListener("click", () => this.toggle(true));
      (_b = root.querySelector("[data-action='close']")) == null ? void 0 : _b.addEventListener("click", () => this.toggle(false));
      (_c = root.querySelector("[data-action='run']")) == null ? void 0 : _c.addEventListener("click", () => void this.run());
      (_d = root.querySelector("[data-action='retry']")) == null ? void 0 : _d.addEventListener("click", () => void this.retryFailed());
      (_e = root.querySelector("[data-action='copy']")) == null ? void 0 : _e.addEventListener("click", () => this.copy());
      (_f = root.querySelector("[data-action='download']")) == null ? void 0 : _f.addEventListener("click", () => this.download());
      void this.renderSettings();
    }
    open() {
      this.mount();
      this.toggle(true);
    }
    toggle(show) {
      this.panel.classList.toggle("xhsocr-hidden", !show);
    }
    async renderSettings() {
      var _a, _b;
      const settings = await loadSettings();
      const container = this.panel.querySelector("[data-view='settings']");
      container.innerHTML = `
      <label class="xhsocr-field"><span>OpenAI API Key</span><input data-field="apiKey" type="password" autocomplete="off" placeholder="sk-..." value="${this.escapeAttribute(settings.apiKey)}"></label>
      <label class="xhsocr-field"><span>Base URL</span><input data-field="baseUrl" type="url" placeholder="https://api.openai.com/v1" value="${this.escapeAttribute(settings.baseUrl)}"></label>
      <label class="xhsocr-field"><span>模型</span><input data-field="model" type="text" value="${this.escapeAttribute(settings.model)}"></label>
      <div class="xhsocr-row"><button data-action="save" type="button">保存设置</button><button data-action="clear" type="button">清除 Key</button></div>`;
      (_a = container.querySelector("[data-action='save']")) == null ? void 0 : _a.addEventListener("click", () => void this.persistSettings());
      (_b = container.querySelector("[data-action='clear']")) == null ? void 0 : _b.addEventListener("click", async () => {
        await clearSettings();
        await this.renderSettings();
        this.setStatus("已清除设置。", false);
      });
    }
    async persistSettings() {
      const apiKey = this.panel.querySelector("[data-field='apiKey']").value.trim();
      const baseUrl = this.panel.querySelector("[data-field='baseUrl']").value.trim() || "https://api.openai.com/v1";
      const model = this.panel.querySelector("[data-field='model']").value.trim() || "gpt-5-mini";
      if (!apiKey) {
        this.setStatus("请先填写 OpenAI API Key。", true);
        return false;
      }
      try {
        responsesEndpoint(baseUrl);
      } catch {
        this.setStatus("Base URL 格式无效，仅支持 HTTP 或 HTTPS 地址。", true);
        return false;
      }
      await saveSettings({ apiKey, model, baseUrl });
      this.setStatus("设置已保存在本机 Tampermonkey 中。", false);
      return true;
    }
    async run() {
      if (!await this.persistSettings()) return;
      const settings = await loadSettings();
      this.setBusy(true);
      try {
        this.setStatus("正在解析当前笔记…", false);
        const note = await this.extractor.extract(document, location);
        this.setStatus(`找到 ${note.images.length} 张图片，正在下载并识别…`, false);
        const ocr = await this.recognizeWithProgress(note.images, settings);
        const markdown = new MarkdownRenderer().render(note, ocr.results);
        this.lastNote = note;
        this.lastResults = ocr.results;
        this.lastMarkdown = markdown;
        this.output.value = markdown;
        this.output.classList.remove("xhsocr-hidden");
        this.setStatus(`完成。成功 ${ocr.results.filter((result) => !result.error).length} 张，失败 ${ocr.results.filter((result) => result.error).length} 张。`, false);
        this.enableResultActions(true);
        this.enableRetry(ocr.results.some((result) => result.error));
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : String(error), true);
      } finally {
        this.setBusy(false);
      }
    }
    async retryFailed() {
      if (!this.lastNote) return;
      const failedIds = new Set(this.lastResults.filter((result) => result.error).map((result) => result.imageId));
      const failedImages = this.lastNote.images.filter((image) => failedIds.has(image.id));
      if (!failedImages.length) return;
      const settings = await loadSettings();
      this.setBusy(true);
      this.enableRetry(false);
      try {
        this.setStatus(`正在重试 ${failedImages.length} 张失败图片…`, false);
        const retried = await this.recognizeWithProgress(failedImages, settings, "重试：");
        const replacements = new Map(retried.results.map((result) => [result.imageId, result]));
        this.lastResults = this.lastResults.map((result) => replacements.get(result.imageId) ?? result);
        this.lastMarkdown = new MarkdownRenderer().render(this.lastNote, this.lastResults);
        this.output.value = this.lastMarkdown;
        const failures = this.lastResults.filter((result) => result.error).length;
        this.setStatus(`重试完成，仍有 ${failures} 张失败。`, false);
        this.enableRetry(failures > 0);
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : String(error), true);
        this.enableRetry(true);
      } finally {
        this.setBusy(false);
      }
    }
    async recognizeWithProgress(images, settings, prefix = "") {
      const startedAt = Date.now();
      let progress = { completed: 0, total: images.length, phase: "download", active: 0 };
      const render = () => {
        const label = progress.phase === "download" ? "下载图片" : "OCR";
        const elapsed = Math.floor((Date.now() - startedAt) / 1e3);
        this.setStatus(`${prefix}${label}：${progress.completed}/${progress.total}，并发处理中 ${progress.active}，已耗时 ${elapsed}s`, false);
      };
      render();
      const timer = window.setInterval(render, 1e3);
      try {
        return await new OpenAiOcrProvider(settings.apiKey, settings.baseUrl).recognize(images, {
          model: settings.model,
          prompt: this.panel.querySelector("[data-field='prompt']").value,
          onProgress: (completed, total, phase = "ocr", active = 0) => {
            progress = { completed, total, phase, active };
            render();
          }
        });
      } finally {
        window.clearInterval(timer);
      }
    }
    copy() {
      if (!this.lastMarkdown) return;
      GM_setClipboard(this.lastMarkdown, "text");
      this.setStatus("Markdown 已复制到剪贴板。", false);
    }
    download() {
      if (!this.lastMarkdown || !this.lastNote) return;
      const url = URL.createObjectURL(new Blob([this.lastMarkdown], { type: "text/markdown;charset=utf-8" }));
      GM_download({ url, name: filename(this.lastNote), saveAs: true, onload: () => URL.revokeObjectURL(url), onerror: () => URL.revokeObjectURL(url) });
    }
    setStatus(message, error) {
      this.status.textContent = message;
      this.status.classList.toggle("xhsocr-error", error);
    }
    setBusy(busy) {
      const button = this.panel.querySelector("[data-action='run']");
      button.disabled = busy;
      button.textContent = busy ? "处理中…" : "解析并 OCR";
    }
    enableResultActions(enabled) {
      for (const action of ["copy", "download"]) this.panel.querySelector(`[data-action='${action}']`).disabled = !enabled;
    }
    enableRetry(enabled) {
      this.panel.querySelector("[data-action='retry']").disabled = !enabled;
    }
    escapeAttribute(value) {
      return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    }
  }
  const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const firstString = (...values) => {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
    return void 0;
  };
  const get = (value, ...path) => {
    let current = value;
    for (const key of path) {
      if (!isRecord(current)) return void 0;
      current = current[key];
    }
    return current;
  };
  function walk(value, visit, seen = /* @__PURE__ */ new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return void 0;
    seen.add(value);
    if (isRecord(value) && visit(value)) return value;
    for (const child of Object.values(value)) {
      const match = walk(child, visit, seen);
      if (match) return match;
    }
    return void 0;
  }
  function parseEmbeddedStates(document2) {
    var _a;
    const states = [];
    for (const script of document2.querySelectorAll("script")) {
      const text = (_a = script.textContent) == null ? void 0 : _a.trim();
      if (!text) continue;
      if (script.type === "application/json") {
        try {
          states.push(JSON.parse(text));
        } catch {
        }
        continue;
      }
      for (const marker of ["window.__INITIAL_STATE__=", "window.__INITIAL_STATE__ =", "window.__NEXT_DATA__="]) {
        const start = text.indexOf(marker);
        if (start < 0) continue;
        let payload = text.slice(start + marker.length).trim().replace(/;$/, "");
        payload = payload.replace(/\bundefined\b/g, "null");
        try {
          states.push(JSON.parse(payload));
        } catch {
        }
      }
    }
    return states;
  }
  function findNoteRecord(states, noteId) {
    for (const state of states) {
      const exact = walk(state, (record) => {
        const id = firstString(record.noteId, record.note_id, record.id);
        return id === noteId && (Array.isArray(record.imageList) || typeof record.desc === "string");
      });
      if (exact) return exact;
    }
    for (const state of states) {
      const probable = walk(
        state,
        (record) => Array.isArray(record.imageList) && (typeof record.desc === "string" || typeof record.title === "string")
      );
      if (probable) return probable;
    }
    return void 0;
  }
  function normalizeImageUrl(value) {
    var _a;
    if (typeof value === "string") return value.replace(/^http:/, "https:");
    if (!isRecord(value)) return void 0;
    return (_a = firstString(value.urlDefault, value.urlPre, value.url, value.src)) == null ? void 0 : _a.replace(/^http:/, "https:");
  }
  function extractStateImages(note) {
    const list = note.imageList;
    if (!Array.isArray(list)) return [];
    return list.map((item, index) => {
      if (!isRecord(item)) return void 0;
      const url = normalizeImageUrl(item.urlDefault) ?? normalizeImageUrl(item.urlPre) ?? normalizeImageUrl(item.url) ?? (Array.isArray(item.infoList) ? item.infoList.map(normalizeImageUrl).find(Boolean) : void 0);
      if (!url) return void 0;
      return { id: `image-${index + 1}`, index: index + 1, url };
    }).filter((image) => Boolean(image));
  }
  function uniqueImages(images) {
    const seen = /* @__PURE__ */ new Set();
    return images.filter((image) => {
      const key = image.url.split("?")[0] ?? image.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((image, index) => ({ ...image, id: `image-${index + 1}`, index: index + 1 }));
  }
  function domText(document2, selectors) {
    var _a, _b;
    for (const selector of selectors) {
      const text = (_b = (_a = document2.querySelector(selector)) == null ? void 0 : _a.textContent) == null ? void 0 : _b.trim();
      if (text) return text;
    }
    return void 0;
  }
  function extractDomImages(document2) {
    const selectors = [
      ".note-slider img",
      ".swiper-slide img",
      ".carousel img",
      "[class*='note'] [class*='image'] img"
    ];
    const nodes = selectors.flatMap((selector) => Array.from(document2.querySelectorAll(selector)));
    return uniqueImages(nodes.map((image, index) => ({
      id: `image-${index + 1}`,
      index: index + 1,
      url: image.currentSrc || image.src
    })).filter((image) => /^https?:/.test(image.url)));
  }
  function tagNames(note, document2) {
    const raw = note == null ? void 0 : note.tagList;
    const stateTags = Array.isArray(raw) ? raw.map((tag) => isRecord(tag) ? firstString(tag.name, tag.title) : firstString(tag)).filter((tag) => Boolean(tag)) : [];
    const domTags = Array.from(document2.querySelectorAll("a[href*='/search_result?keyword='], .tag")).map((element) => {
      var _a;
      return (_a = element.textContent) == null ? void 0 : _a.trim().replace(/^#/, "");
    }).filter((tag) => Boolean(tag));
    return [.../* @__PURE__ */ new Set([...stateTags, ...domTags])];
  }
  class XiaohongshuNoteExtractor {
    canExtract(_document, location2) {
      return location2.hostname.endsWith("xiaohongshu.com") && /\/(explore|discovery\/item)\//.test(location2.pathname);
    }
    async extract(document2, location2) {
      var _a, _b;
      if (!this.canExtract(document2, location2)) throw new Error("请在小红书图文笔记详情页运行此脚本。");
      const noteId = location2.pathname.split("/").filter(Boolean).at(-1) ?? "unknown";
      const note = findNoteRecord(parseEmbeddedStates(document2), noteId);
      const user = get(note, "user");
      const interact = get(note, "interactInfo");
      const userId = firstString(get(user, "userId"), get(user, "user_id"));
      const timestamp = firstString(note == null ? void 0 : note.time, note == null ? void 0 : note.publishTime, note == null ? void 0 : note.lastUpdateTime);
      const metadata = {
        id: firstString(note == null ? void 0 : note.noteId, note == null ? void 0 : note.id, noteId) ?? noteId,
        url: location2.href,
        title: firstString(note == null ? void 0 : note.title, domText(document2, ["#detail-title", ".title", "h1"])),
        author: firstString(get(user, "nickname"), get(user, "name"), domText(document2, [".author-wrapper .name", ".username"])),
        authorUrl: userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : void 0,
        publishedAt: timestamp ? /^\d+$/.test(timestamp) ? new Date(Number(timestamp) < 1e12 ? Number(timestamp) * 1e3 : Number(timestamp)).toISOString() : timestamp : domText(document2, [".date", ".publish-time"]),
        ipLocation: firstString(note == null ? void 0 : note.ipLocation, note == null ? void 0 : note.ip_location, (_b = (_a = domText(document2, [".date", ".publish-time"])) == null ? void 0 : _a.match(/IP属地[:：]?\s*(.+)$/)) == null ? void 0 : _b[1]),
        body: firstString(note == null ? void 0 : note.desc, note == null ? void 0 : note.description, domText(document2, ["#detail-desc", ".desc", ".note-text"])),
        tags: tagNames(note, document2),
        likes: firstString(get(interact, "likedCount"), get(interact, "liked_count"), domText(document2, [".like-wrapper .count"])),
        collects: firstString(get(interact, "collectedCount"), get(interact, "collected_count"), domText(document2, [".collect-wrapper .count"])),
        comments: firstString(get(interact, "commentCount"), get(interact, "comment_count"), domText(document2, [".chat-wrapper .count"]))
      };
      const images = uniqueImages(note ? extractStateImages(note) : extractDomImages(document2));
      if (!images.length) throw new Error("未找到笔记图片。请确认这是图文笔记，并等待页面图片加载完成后重试。");
      return { metadata, images };
    }
  }
  const app = new AppUi(new XiaohongshuNoteExtractor());
  function mount() {
    if (document.body) app.mount();
  }
  mount();
  window.addEventListener("urlchange", mount);
  GM_registerMenuCommand("打开小红书 OCR", () => app.open());

})();