import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Keep the PDF/DOCX parsing stack OUT of the server bundle.
   *
   * `pdf-parse` pulls in `pdfjs-dist`, which on Node polyfills `DOMMatrix`
   * (and ImageData/Path2D) by `require`ing the NATIVE `@napi-rs/canvas`
   * addon via `createRequire(import.meta.url)`. Bundling breaks that:
   * the runtime require can't find the platform-specific `.node` binary,
   * pdfjs only warns, and then throws `ReferenceError: DOMMatrix is not
   * defined` when it evaluates `new DOMMatrix()` at module scope.
   *
   * Listing these as external means they are loaded from node_modules at
   * runtime with normal Node resolution, so the addon and its polyfill
   * work. `parseDocument.ts` additionally imports them lazily, so a text
   * or Markdown artifact never loads them at all -- the two changes are
   * complementary, not redundant: this one fixes PDFs, the lazy import
   * keeps non-PDFs from ever depending on it.
   */
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas", "mammoth"],
};

export default nextConfig;
