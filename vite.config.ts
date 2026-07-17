import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "Xiaohongshu OCR Markdown Exporter",
        namespace: "https://github.com/local/xhsocr",
        version: "0.1.0",
        description: "Extract the current Xiaohongshu image note and export OCR-enhanced Markdown.",
        author: "xhsocr",
        match: ["https://www.xiaohongshu.com/explore/*", "https://www.xiaohongshu.com/discovery/item/*"],
        connect: ["*", "*.xhscdn.com", "*.xhscdn.net"],
        grant: [
          "GM_xmlhttpRequest",
          "GM_addStyle",
          "GM_getValue",
          "GM_setValue",
          "GM_deleteValue",
          "GM_setClipboard",
          "GM_download",
          "GM_registerMenuCommand"
        ],
        "run-at": "document-idle",
        noframes: true
      },
      build: {
        fileName: "xhsocr.user.js",
        externalGlobals: {}
      }
    })
  ],
  build: {
    minify: false,
    sourcemap: false
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"]
  }
});
