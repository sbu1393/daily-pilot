import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// B1-lite — minimal vitest setup for service-layer smoke tests.
// محیط: node (بدون DOM) — سرویسها فقط Prisma mock شده را میبینند.
export default defineConfig({
    test: {
        environment: "node",
        include: ["app/**/*.test.ts", "src/**/*.test.ts"],
    },
    resolve: {
        alias: {
            "@": fileURLToPath(new URL(".", import.meta.url)),
        },
    },
})