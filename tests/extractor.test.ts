import { describe, expect, it } from "vitest";
import { XiaohongshuNoteExtractor } from "../src/xiaohongshu-extractor";

describe("XiaohongshuNoteExtractor", () => {
  it("extracts metadata and ordered images from embedded state", async () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      note: {
        noteId: "abc123",
        title: "测试笔记",
        desc: "正文内容",
        time: 1710000000000,
        ipLocation: "上海",
        user: { userId: "u1", nickname: "Alice" },
        interactInfo: { likedCount: "10", collectedCount: "4", commentCount: "2" },
        tagList: [{ name: "旅行" }],
        imageList: [{ urlDefault: "http://img/1.jpg" }, { urlPre: "https://img/2.jpg" }]
      }
    })};</script>`;
    const location = new URL("https://www.xiaohongshu.com/explore/abc123") as unknown as Location;
    const result = await new XiaohongshuNoteExtractor().extract(document, location);
    expect(result.metadata).toMatchObject({ id: "abc123", title: "测试笔记", author: "Alice", ipLocation: "上海" });
    expect(result.metadata.tags).toEqual(["旅行"]);
    expect(result.images.map((image) => image.url)).toEqual(["https://img/1.jpg", "https://img/2.jpg"]);
  });

  it("falls back to DOM images", async () => {
    document.body.innerHTML = `<h1>DOM 标题</h1><div class="note-slider"><img src="https://img/1.jpg"><img src="https://img/2.jpg"></div>`;
    const location = new URL("https://www.xiaohongshu.com/explore/dom123") as unknown as Location;
    const result = await new XiaohongshuNoteExtractor().extract(document, location);
    expect(result.metadata.title).toBe("DOM 标题");
    expect(result.images).toHaveLength(2);
  });
});

