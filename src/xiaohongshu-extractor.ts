import type { NoteExtractor } from "./extractor";
import type { Note, NoteImage, NoteMetadata } from "./types";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
};

const get = (value: unknown, ...path: string[]): unknown => {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

function walk(value: unknown, visit: (record: JsonRecord) => boolean, seen = new Set<unknown>()): JsonRecord | undefined {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (isRecord(value) && visit(value)) return value;
  for (const child of Object.values(value)) {
    const match = walk(child, visit, seen);
    if (match) return match;
  }
  return undefined;
}

function parseEmbeddedStates(document: Document): unknown[] {
  const states: unknown[] = [];
  for (const script of document.querySelectorAll("script")) {
    const text = script.textContent?.trim();
    if (!text) continue;
    if (script.type === "application/json") {
      try {
        states.push(JSON.parse(text));
      } catch {
        // Ignore unrelated or malformed script tags.
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
        // DOM extraction remains available as a fallback.
      }
    }
  }
  return states;
}

function findNoteRecord(states: unknown[], noteId: string): JsonRecord | undefined {
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
  return undefined;
}

function normalizeImageUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value.replace(/^http:/, "https:");
  if (!isRecord(value)) return undefined;
  return firstString(value.urlDefault, value.urlPre, value.url, value.src)?.replace(/^http:/, "https:");
}

function extractStateImages(note: JsonRecord): NoteImage[] {
  const list = note.imageList;
  if (!Array.isArray(list)) return [];
  return list
    .map((item, index) => {
      if (!isRecord(item)) return undefined;
      const url =
        normalizeImageUrl(item.urlDefault) ??
        normalizeImageUrl(item.urlPre) ??
        normalizeImageUrl(item.url) ??
        (Array.isArray(item.infoList) ? item.infoList.map(normalizeImageUrl).find(Boolean) : undefined);
      if (!url) return undefined;
      return { id: `image-${index + 1}`, index: index + 1, url };
    })
    .filter((image): image is NoteImage => Boolean(image));
}

function uniqueImages(images: NoteImage[]): NoteImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = image.url.split("?")[0] ?? image.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((image, index) => ({ ...image, id: `image-${index + 1}`, index: index + 1 }));
}

function domText(document: Document, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const text = document.querySelector(selector)?.textContent?.trim();
    if (text) return text;
  }
  return undefined;
}

function extractDomImages(document: Document): NoteImage[] {
  const selectors = [
    ".note-slider img",
    ".swiper-slide img",
    ".carousel img",
    "[class*='note'] [class*='image'] img"
  ];
  const nodes = selectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLImageElement>(selector)));
  return uniqueImages(nodes.map((image, index) => ({
    id: `image-${index + 1}`,
    index: index + 1,
    url: image.currentSrc || image.src
  })).filter((image) => /^https?:/.test(image.url)));
}

function tagNames(note: JsonRecord | undefined, document: Document): string[] {
  const raw = note?.tagList;
  const stateTags = Array.isArray(raw)
    ? raw.map((tag) => isRecord(tag) ? firstString(tag.name, tag.title) : firstString(tag)).filter((tag): tag is string => Boolean(tag))
    : [];
  const domTags = Array.from(document.querySelectorAll("a[href*='/search_result?keyword='], .tag"))
    .map((element) => element.textContent?.trim().replace(/^#/, ""))
    .filter((tag): tag is string => Boolean(tag));
  return [...new Set([...stateTags, ...domTags])];
}

export class XiaohongshuNoteExtractor implements NoteExtractor {
  canExtract(_document: Document, location: Location): boolean {
    return location.hostname.endsWith("xiaohongshu.com") && /\/(explore|discovery\/item)\//.test(location.pathname);
  }

  async extract(document: Document, location: Location): Promise<Note> {
    if (!this.canExtract(document, location)) throw new Error("请在小红书图文笔记详情页运行此脚本。");
    const noteId = location.pathname.split("/").filter(Boolean).at(-1) ?? "unknown";
    const note = findNoteRecord(parseEmbeddedStates(document), noteId);
    const user = get(note, "user");
    const interact = get(note, "interactInfo");
    const userId = firstString(get(user, "userId"), get(user, "user_id"));
    const timestamp = firstString(note?.time, note?.publishTime, note?.lastUpdateTime);

    const metadata: NoteMetadata = {
      id: firstString(note?.noteId, note?.id, noteId) ?? noteId,
      url: location.href,
      title: firstString(note?.title, domText(document, ["#detail-title", ".title", "h1"])),
      author: firstString(get(user, "nickname"), get(user, "name"), domText(document, [".author-wrapper .name", ".username"])),
      authorUrl: userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : undefined,
      publishedAt: timestamp ? (/^\d+$/.test(timestamp) ? new Date(Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp)).toISOString() : timestamp) : domText(document, [".date", ".publish-time"]),
      ipLocation: firstString(note?.ipLocation, note?.ip_location, domText(document, [".date", ".publish-time"])?.match(/IP属地[:：]?\s*(.+)$/)?.[1]),
      body: firstString(note?.desc, note?.description, domText(document, ["#detail-desc", ".desc", ".note-text"])),
      tags: tagNames(note, document),
      likes: firstString(get(interact, "likedCount"), get(interact, "liked_count"), domText(document, [".like-wrapper .count"])),
      collects: firstString(get(interact, "collectedCount"), get(interact, "collected_count"), domText(document, [".collect-wrapper .count"])),
      comments: firstString(get(interact, "commentCount"), get(interact, "comment_count"), domText(document, [".chat-wrapper .count"]))
    };

    const images = uniqueImages(note ? extractStateImages(note) : extractDomImages(document));
    if (!images.length) throw new Error("未找到笔记图片。请确认这是图文笔记，并等待页面图片加载完成后重试。");
    return { metadata, images };
  }
}

