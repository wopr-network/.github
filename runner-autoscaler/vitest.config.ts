import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    pool: "forks", // Hono + node-server need a real Node environment, no jsdom
  },
});
