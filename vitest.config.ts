import { defineConfig } from "vitest/config";
import { TEST_TIMEOUT_MS } from "./src/shared/limits.ts";

const timeouts = { testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          ...timeouts,
          environment: "node",
          setupFiles: ["test/clean-env.ts", "test/spawn-guard.ts"],
          include: [
            "src/shared/**/*.test.ts",
            "src/vendors/**/*.test.ts",
            "src/daemon/**/*.test.ts",
            "src/hub/**/*.test.ts",
            "src/relay/**/*.test.ts",
            "src/mesh/**/*.test.ts",
            "scripts/**/*.test.ts",
            "test/**/*.test.ts",
          ],
          exclude: [
            "**/node_modules/**",
            "src/relay/cloudflare/**",
            ...(process.platform === "win32" ? ["test/eval/**"] : []),
          ],
        },
      },
      {
        test: {
          name: "cloudflare",
          ...timeouts,
          environment: "node",
          setupFiles: ["test/clean-env.ts"],
          include: ["src/relay/cloudflare/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "web",
          ...timeouts,
          environment: "jsdom",
          include: ["src/web/**/*.test.{ts,tsx}"],
          setupFiles: ["src/web/test-setup.ts"],
        },
      },
    ],
  },
});
