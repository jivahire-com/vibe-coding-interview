// Vite config — used ONLY by the optional dev playground (`npm run dev`).
// The test suite uses vitest.config.js, which takes precedence for `npm test`,
// so the two never collide.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { open: true },
});
