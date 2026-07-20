import { MarkdownRenderer } from "./markdown";
import { OpenAiOcrProvider, responsesEndpoint } from "./openai-provider";
import { clearSettings, loadSettings, saveSettings } from "./settings";
import type { AppSettings, Note, NoteImage, OcrBatchResult, OcrImageResult } from "./types";
import type { NoteExtractor } from "./extractor";

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

function filename(note: Note): string {
  const title = (note.metadata.title || "xiaohongshu-note").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${title}-${note.metadata.id}.md`;
}

export class AppUi {
  private panel!: HTMLDivElement;
  private status!: HTMLDivElement;
  private output!: HTMLTextAreaElement;
  private lastMarkdown = "";
  private lastNote?: Note;
  private lastResults: OcrImageResult[] = [];

  constructor(private readonly extractor: NoteExtractor) {}

  mount(): void {
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
    this.panel = root.querySelector(".xhsocr-panel") as HTMLDivElement;
    this.status = root.querySelector(".xhsocr-status") as HTMLDivElement;
    this.output = root.querySelector(".xhsocr-output") as HTMLTextAreaElement;
    root.querySelector(".xhsocr-fab")?.addEventListener("click", () => this.toggle(true));
    root.querySelector("[data-action='close']")?.addEventListener("click", () => this.toggle(false));
    root.querySelector("[data-action='run']")?.addEventListener("click", () => void this.run());
    root.querySelector("[data-action='retry']")?.addEventListener("click", () => void this.retryFailed());
    root.querySelector("[data-action='copy']")?.addEventListener("click", () => this.copy());
    root.querySelector("[data-action='download']")?.addEventListener("click", () => this.download());
    void this.renderSettings();
  }

  open(): void {
    this.mount();
    this.toggle(true);
  }

  private toggle(show: boolean): void {
    this.panel.classList.toggle("xhsocr-hidden", !show);
  }

  private async renderSettings(): Promise<void> {
    const settings = await loadSettings();
    const container = this.panel.querySelector("[data-view='settings']") as HTMLDivElement;
    container.innerHTML = `
      <label class="xhsocr-field"><span>OpenAI API Key</span><input data-field="apiKey" type="password" autocomplete="off" placeholder="sk-..." value="${this.escapeAttribute(settings.apiKey)}"></label>
      <label class="xhsocr-field"><span>Base URL</span><input data-field="baseUrl" type="url" placeholder="https://api.openai.com/v1" value="${this.escapeAttribute(settings.baseUrl)}"></label>
      <label class="xhsocr-field"><span>模型</span><input data-field="model" type="text" value="${this.escapeAttribute(settings.model)}"></label>
      <div class="xhsocr-row"><button data-action="save" type="button">保存设置</button><button data-action="clear" type="button">清除 Key</button></div>`;
    container.querySelector("[data-action='save']")?.addEventListener("click", () => void this.persistSettings());
    container.querySelector("[data-action='clear']")?.addEventListener("click", async () => {
      await clearSettings();
      await this.renderSettings();
      this.setStatus("已清除设置。", false);
    });
  }

  private async persistSettings(): Promise<boolean> {
    const apiKey = (this.panel.querySelector("[data-field='apiKey']") as HTMLInputElement).value.trim();
    const baseUrl = (this.panel.querySelector("[data-field='baseUrl']") as HTMLInputElement).value.trim() || "https://api.openai.com/v1";
    const model = (this.panel.querySelector("[data-field='model']") as HTMLInputElement).value.trim() || "gpt-5-mini";
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

  private async run(): Promise<void> {
    if (!(await this.persistSettings())) return;
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

  private async retryFailed(): Promise<void> {
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

  private async recognizeWithProgress(images: NoteImage[], settings: AppSettings, prefix = ""): Promise<OcrBatchResult> {
    const startedAt = Date.now();
    let progress = { completed: 0, total: images.length, phase: "download" as "download" | "ocr", active: 0 };
    const render = () => {
      const label = progress.phase === "download" ? "下载图片" : "OCR";
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      this.setStatus(`${prefix}${label}：${progress.completed}/${progress.total}，并发处理中 ${progress.active}，已耗时 ${elapsed}s`, false);
    };
    render();
    const timer = window.setInterval(render, 1_000);
    try {
      return await new OpenAiOcrProvider(settings.apiKey, settings.baseUrl).recognize(images, {
        model: settings.model,
        prompt: (this.panel.querySelector("[data-field='prompt']") as HTMLTextAreaElement).value,
        onProgress: (completed, total, phase = "ocr", active = 0) => {
          progress = { completed, total, phase, active };
          render();
        }
      });
    } finally {
      window.clearInterval(timer);
    }
  }

  private copy(): void {
    if (!this.lastMarkdown) return;
    GM_setClipboard(this.lastMarkdown, "text");
    this.setStatus("Markdown 已复制到剪贴板。", false);
  }

  private download(): void {
    if (!this.lastMarkdown || !this.lastNote) return;
    const url = URL.createObjectURL(new Blob([this.lastMarkdown], { type: "text/markdown;charset=utf-8" }));
    GM_download({ url, name: filename(this.lastNote), saveAs: true, onload: () => URL.revokeObjectURL(url), onerror: () => URL.revokeObjectURL(url) });
  }

  private setStatus(message: string, error: boolean): void {
    this.status.textContent = message;
    this.status.classList.toggle("xhsocr-error", error);
  }

  private setBusy(busy: boolean): void {
    const button = this.panel.querySelector("[data-action='run']") as HTMLButtonElement;
    button.disabled = busy;
    button.textContent = busy ? "处理中…" : "解析并 OCR";
  }

  private enableResultActions(enabled: boolean): void {
    for (const action of ["copy", "download"]) (this.panel.querySelector(`[data-action='${action}']`) as HTMLButtonElement).disabled = !enabled;
  }

  private enableRetry(enabled: boolean): void {
    (this.panel.querySelector("[data-action='retry']") as HTMLButtonElement).disabled = !enabled;
  }

  private escapeAttribute(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }
}
