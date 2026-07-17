import type { Note, OcrImageResult } from "./types";

const cleanInline = (value: string): string => value.replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>])/g, "\\$1").trim();

function field(label: string, value?: string): string | undefined {
  return value ? `- ${label}: ${cleanInline(value)}` : undefined;
}

export class MarkdownRenderer {
  render(note: Note, results: OcrImageResult[]): string {
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
      metadata.tags.length ? `- 标签: ${metadata.tags.map((tag) => `#${cleanInline(tag)}`).join(" ")}` : undefined,
      "",
      metadata.body?.trim(),
      ""
    ].filter((line): line is string => line !== undefined);

    for (const image of note.images) {
      const result = resultMap.get(image.id);
      lines.push(`<!-- image: ${image.index} -->`, "");
      if (result?.error) lines.push(`> OCR failed: ${cleanInline(result.error)}`, "");
      else if (result?.text.trim()) lines.push(result.text.trim(), "");
    }
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }
}

