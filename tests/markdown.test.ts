import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "../src/markdown";
import type { Note } from "../src/types";

const note: Note = {
  metadata: {
    id: "abc123",
    url: "https://www.xiaohongshu.com/explore/abc123",
    title: "标题 *测试*",
    author: "作者",
    body: "正文",
    tags: ["旅行", "上海"]
  },
  images: [
    { id: "image-1", index: 1, url: "https://img/1.jpg" },
    { id: "image-2", index: 2, url: "https://img/2.jpg" },
    { id: "image-3", index: 3, url: "https://img/3.jpg" }
  ]
};

describe("MarkdownRenderer", () => {
  it("keeps placeholders in image order and renders partial failures", () => {
    const output = new MarkdownRenderer().render(note, [
      { imageId: "image-2", text: "第二张文字" },
      { imageId: "image-1", text: "第一张文字" },
      { imageId: "image-3", text: "", error: "timeout" }
    ]);
    expect(output).toContain("# 标题 \\*测试\\*");
    expect(output).toContain("- 标签: #旅行 #上海");
    expect(output.indexOf("<!-- image: 1 -->")).toBeLessThan(output.indexOf("<!-- image: 2 -->"));
    expect(output).toContain("<!-- image: 1 -->\n\n第一张文字");
    expect(output).toContain("> OCR failed: timeout");
  });
});

