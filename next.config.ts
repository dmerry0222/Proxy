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

  /*
   * serverExternalPackages alone was NOT enough, and the trace proves why:
   * `pdfjs-dist/legacy/build/pdf.mjs` (the file with `new DOMMatrix()`) is
   * traced into the lambda, while `@napi-rs/canvas` -- the package that
   * SUPPLIES DOMMatrix -- traced 0 files. pdfjs reaches for it through
   * `createRequire(import.meta.url)` inside a try/catch, which Next's
   * static file tracer cannot follow, so the deployed function shipped the
   * code that needs the polyfill without the polyfill itself.
   *
   * The glob covers both the `@napi-rs/canvas` wrapper and its sibling
   * platform package (`@napi-rs/canvas-linux-x64-gnu` on Vercel,
   * `-win32-x64-msvc` locally), which is where the actual `.node` binary
   * and `icudtl.dat` live.
   *
   * Only PDFs need this. Markdown/text ingestion never loads the parser at
   * all (see the lazy imports in parseDocument.ts), which is why the
   * text path was already fixed by the earlier change.
   */
  outputFileTracingIncludes: {
    "/api/ingestion/artifacts/**": ["./node_modules/@napi-rs/canvas*/**"],
  },
};

export default nextConfig;
