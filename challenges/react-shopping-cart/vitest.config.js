import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.js"],
    include: ["tests/**/*.test.{js,jsx}"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    reporters: ["verbose"],
  },
});
