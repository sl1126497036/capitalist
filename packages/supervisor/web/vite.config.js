import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/** 版本与仓库地址在构建期从 supervisor/package.json 注入。 */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const repoUrl = String(pkg.repository?.url ?? "")
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");

/**
 * 看板前端构建配置。`base: "./"` 用相对路径，产物由 `capitalist board` 从 dist 目录托管。
 * `outDir` 指向 supervisor 的 dist，前端产物随监工一起分发。
 * 开发时 `npm run dev` 监听 5173，`/api` 代理到 7788；代码改动经热更新生效，监工无需重启。
 */
export default defineConfig({
  base: "./",
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? ""),
    __APP_REPO__: JSON.stringify(repoUrl),
  },
  // 组件按目录导入：`./components/chat-pane` → `chat-pane/index.vue`
  resolve: {
    extensions: [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json", ".vue"],
  },
  build: {
    outDir: "../dist/board-web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7788",
        changeOrigin: true,
      },
    },
  },
});
