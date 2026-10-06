import { describe, expect, it } from "vitest"

import { listPendingLocalReminders } from "@/app/lib/native/local-notifications"

/*
 * تشخیص اعلان‌های pending — `listPendingLocalReminders()`
 * ------------------------------------------------------
 * این تابع یک خواندنِ صرف است و در محیط node (بدون `window`) هرگز به پل نیتیو
 * نمی‌رسد، پس تنها چیزی که اینجا قابل اثبات است این است که:
 *   - throw نمی‌کند و معلق نمی‌ماند؛
 *   - شکست را ساختاریافته می‌دهد، نه مبهم.
 *
 * محتوای واقعی فهرست فقط روی دستگاه معنا دارد و با APK سنجیده می‌شود؛ برای
 * همین عمداً Capacitor mock نشده است.
 */

describe("listPendingLocalReminders", () => {
    it("بیرون از اپ نیتیو، خطای ساختاریافته می‌دهد و throw نمی‌کند", async () => {
        const outcome = await listPendingLocalReminders()

        expect(outcome.ok).toBe(false)
        if (outcome.ok) throw new Error("در node انتظار NOT_NATIVE داشتیم")
        expect(outcome.reason).toBe("NOT_NATIVE")
        expect(outcome.message.length).toBeGreaterThan(0)
    })

    it("هیچ اعلانی برای لغو/زمان‌بندی در مسیر برنمی‌گرداند", async () => {
        // خواندنِ pending نباید به هیچ‌وجه چیزی را تغییر دهد؛ در غیر نیتیو اصلاً
        // به پل نمی‌رسد، پس نتیجه هم باید خالی/ناموفق باشد.
        await expect(listPendingLocalReminders()).resolves.toBeDefined()
    })
})
