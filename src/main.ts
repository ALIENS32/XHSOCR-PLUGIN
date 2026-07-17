import { AppUi } from "./ui";
import { XiaohongshuNoteExtractor } from "./xiaohongshu-extractor";

const app = new AppUi(new XiaohongshuNoteExtractor());

function mount(): void {
  if (document.body) app.mount();
}

mount();
window.addEventListener("urlchange", mount);
GM_registerMenuCommand("打开小红书 OCR", () => app.open());

