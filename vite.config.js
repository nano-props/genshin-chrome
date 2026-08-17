import { defineConfig } from "vite";
import vueJsx from "@vitejs/plugin-vue-jsx";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [vueJsx(), tailwindcss()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true
  }
});
