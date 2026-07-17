import type { Note } from "./types";

export interface NoteExtractor {
  canExtract(document: Document, location: Location): boolean;
  extract(document: Document, location: Location): Promise<Note>;
}

