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
            "src/tunnel/**/*.test.ts",
            "scripts/**/*.test.ts",
            "test/**/*.test.ts",
          ],
          ...(process.platform === "win32"
            ? {
                exclude: [
                  "**/node_modules/**",
                  "test/eval/**",
                ],
              }
            : {}),
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
