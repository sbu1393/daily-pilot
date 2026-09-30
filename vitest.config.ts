import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// B1-lite — minimal vitest setup for service-layer smoke tests.
// محیط: node (بدون DOM) — سرویسها فقط Prisma mock شده را میبینند.
export default defineConfig({
    test: {
        environment: "node",
        // `lib/` هم شامل تست است (مثلاً رمز موقت) — بدون این ورودی، آن فایل‌ها
        // بی‌سروصدا از اجرا حذف می‌مانند و کسی متوجه نمی‌شود که پوشش ندارند.
        include: ["app/**/*.test.ts", "src/**/*.test.ts", "lib/**/*.test.ts"],
    },
    resolve: {
        alias: {
            "@": fileURLToPath(new URL(".", import.meta.url)),
        },
    },
})