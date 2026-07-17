# Project Guidelines

## Project shape

- This repository builds a Tampermonkey userscript for extracting Xiaohongshu image notes and exporting OCR-enhanced Markdown.
- Use Node.js and npm for the TypeScript toolchain. The earlier `uv` idea was intentionally dropped because the final product is a browser-only userscript.
- Keep the generated userscript in `dist/`; never edit generated files by hand.

## Architecture

- Keep page extraction, OCR, Markdown rendering, settings storage, and UI independent.
- New OCR services must implement `OcrProvider`; do not add provider-specific behavior to the UI or extractor.
- Xiaohongshu-specific selectors and state traversal belong only in `XiaohongshuNoteExtractor`.
- Treat all fields extracted from the page and all model output as untrusted input.
- Never log or render the full API key. Do not put secrets in URLs, Markdown, fixtures, or error messages.

## Commands

- Install dependencies: `npm install`
- Type-check: `npm run typecheck`
- Run tests: `npm test`
- Build userscript: `npm run build`
- Run all verification: `npm run check`

## Change expectations

- Add or update tests for extractor, batching/provider, and Markdown behavior when those modules change.
- Keep the production build as one installable `.user.js` file with a valid userscript metadata block.
- Preserve image order and stable image IDs across extraction, OCR batching, retries, and Markdown output.
- A partial OCR failure must not discard successful results.

