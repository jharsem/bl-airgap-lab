import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  base: "./",
  plugins: [react(), basicSsl(), viteSingleFile()],
  build: {
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    target: "es2022",
  },
  server: { host: true, https: {} },
  preview: { host: true, https: {} },
});
