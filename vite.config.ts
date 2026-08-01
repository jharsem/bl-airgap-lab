import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// zxing-wasm's default `locateFile` resolves its .wasm against a jsDelivr CDN.
// decoder.worker.ts overrides `locateFile` to return the copy Vite inlines, and
// that override fully replaces the default rather than merging with it, so the
// CDN branch is already unreachable. It is stripped anyway: a live CDN URL
// inside an air-gapped artifact means any later change that drops the override
// would fail open to the network instead of failing loudly. Rewritten to a
// relative path that cannot resolve, so the same mistake fails closed.
//
// zxing-wasm is only reached from decoder.worker.ts, which Vite bundles in a
// separate Rollup pass that does not inherit `plugins` — hence the duplicate
// registration under `worker.plugins` below. Registered in both places because
// nothing pins the import to the worker.
//
// The real guarantee is the "ships no network path" test, which asserts the
// built file is free of external URLs. This plugin is what makes it pass; if a
// zxing-wasm upgrade moves the URL out of reach of this pattern, that test
// fails rather than the artifact silently regaining a CDN reference.
const stripZXingCdnFallback = (): Plugin => ({
  name: "strip-zxing-cdn-fallback",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("zxing-wasm") || !code.includes("jsdelivr")) return null;
    const stripped = code.replace(
      /https:\/\/[\w.-]*jsdelivr[\w.-]*\/npm\/zxing-wasm@[^/]+\/dist\//g,
      "zxing-wasm-cdn-fallback-removed/",
    );
    return { code: stripped, map: null };
  },
});

export default defineConfig({
  base: "./",
  plugins: [react(), basicSsl(), viteSingleFile(), stripZXingCdnFallback()],
  worker: { plugins: () => [stripZXingCdnFallback()] },
  build: {
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    target: "es2022",
  },
  server: { host: true, https: {} },
  preview: { host: true, https: {} },
});
