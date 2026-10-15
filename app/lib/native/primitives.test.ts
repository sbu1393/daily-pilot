import { afterEach, describe, expect, it, vi } from "vitest"

import { enqueueNative, NATIVE_QUEUE_STALL_RELEASE_MS } from "@/app/lib/native/primitives"

/*
 * صف سریال عملیات نیتیو
 * ---------------------
 * صف وجود دارد تا `cancel` بعد از `schedule` روی یک شناسه ننشیند. اما صف
 * نباید به «همیشه settle می‌شود» تکیه کند: پلاگین Capacitor در حالت آلارم دقیق
 * بدون مجوز، عمداً `schedule()` را معلق می‌گذارد (صفحه‌ی تنظیمات را باز می‌کند
 * و منتظر کاربر می‌ماند). بدون نگهبان، همان یک promise معلق کل صف — و در نتیجه
 * *هر* یادآور بعدی — را تا ابد قفل می‌کند.
 *
 * اینجا فقط همین تضمین تست می‌شود: یک عملیات معلق، صف را برای همیشه نگه نمی‌دارد.
 */

afterEach(() => {
    vi.useRealTimers()
})

describe("enqueueNative", () => {
    it("کارها را به ترتیب اجرا می‌کند", async () => {
        const order: string[] = []

        const first = enqueueNative(async () => {
            order.push("first")
            return 1
        })
        const second = enqueueNative(async () => {
            order.push("second")
            return 2
        })

        await expect(first).resolves.toBe(1)
        await expect(second).resolves.toBe(2)
        expect(order).toEqual(["first", "second"])
    })

    it("یک عملیات معلق، صف را برای همیشه قفل نمی‌کند", async () => {
        vi.useFakeTimers()

        let secondRan = false

        // هرگز settle نمی‌شود — دقیقاً همان چیزی که پل نیتیو در حالت
        // «آلارم دقیق بدون مجوز» پس می‌دهد.
        void enqueueNative(() => new Promise<void>(() => undefined))

        const second = enqueueNative(async () => {
            secondRan = true
            return "ok"
        })

        // تا قبل از مهلت، صف هنوز منتظر است (نه زودتر رها می‌شود، نه قفل ابدی).
        await vi.advanceTimersByTimeAsync(NATIVE_QUEUE_STALL_RELEASE_MS - 1)
        expect(secondRan).toBe(false)

        await vi.advanceTimersByTimeAsync(1)
        await expect(second).resolves.toBe("ok")
        expect(secondRan).toBe(true)
    })

    /*
     * همان سناریوی باگ «فقط اولین یادآور کار می‌کند»، ولی در لایه‌ی درست.
     *
     * یک عملیات معلق (schedule اول) صف را قفل می‌کند؛ بعد دو عملیات سالم
     * (schedule دوم و سوم) صف می‌شوند. چیزی که باید اثبات شود این است که صف
     * بعد از مهلت رها می‌شود و **هر دو** عملیات بعدی واقعاً اجرا می‌شوند —
     * یعنی قفل همیشگی رخ نمی‌دهد و بعدی‌ها پشت promise مرده گیر نمی‌مانند.
     */
    it("بعد از یک عملیات معلق، دو عملیات بعدی پشت‌سرهم اجرا می‌شوند", async () => {
        vi.useFakeTimers()

        const ran: string[] = []

        void enqueueNative(() => new Promise<void>(() => undefined))

        const second = enqueueNative(async () => {
            ran.push("second")
            return 2
        })
        const third = enqueueNative(async () => {
            ran.push("third")
            return 3
        })

        await vi.advanceTimersByTimeAsync(NATIVE_QUEUE_STALL_RELEASE_MS + 1)

        await expect(second).resolves.toBe(2)
        await expect(third).resolves.toBe(3)

        // هر دو اجرا شدند و ترتیب سریال حفظ شد.
        expect(ran).toEqual(["second", "third"])
    })
})
