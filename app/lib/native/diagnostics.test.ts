import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
    captureDiagnosticStack,
    classifyReminderKind,
    clearNativeDiagnostics,
    formatNativeDiagnostic,
    getNativeDiagnostics,
    MAX_NATIVE_DIAGNOSTIC_ENTRIES,
    NATIVE_DIAGNOSTIC_STACK_FRAMES,
    readExactAlarmDiagnostic,
    recordNativeDiagnostic,
    subscribeNativeDiagnostics,
} from "@/app/lib/native/diagnostics"

/*
 * گزارش تشخیصی یادآورهای نیتیو
 * ----------------------------
 * این ماژول عمداً هیچ وابستگی به Capacitor/Context ندارد (نه `window`، نه
 * `localStorage` در محیط node)، پس کاملاً بدون mock قابل تست است.
 *
 * چیزهایی که اینجا قابل اثبات‌اند و برای خودِ تشخیص مهم‌اند:
 *   - استنتاج نوع یادآور از عنوانی که واقعاً به نیتیو داده می‌شود؛
 *   - حلقه‌ی `MAX_NATIVE_DIAGNOSTIC_ENTRIES` که هرگز بی‌نهایت رشد نمی‌کند؛
 *   - اینکه `recordNativeDiagnostic` هرگز throw نمی‌کند.
 */

describe("classifyReminderKind", () => {
    it("یادآور تسک را از پیشوند عنوان تشخیص می‌دهد", () => {
        // `scheduleTaskReminder` عنوان را همیشه با همین پیشوند می‌سازد.
        expect(classifyReminderKind("🔔 خرید نان")).toBe("TASK")
        expect(classifyReminderKind("🔔")).toBe("TASK")
    })

    it("یادآور روزانه را از عنوان ثابتش تشخیص می‌دهد", () => {
        expect(classifyReminderKind("یادآور روزساز")).toBe("DAILY")
    })

    it("عنوان ناشناخته یا خالی را UNKNOWN می‌دهد", () => {
        expect(classifyReminderKind("")).toBe("UNKNOWN")
        expect(classifyReminderKind("یادآور روزساز  ")).toBe("UNKNOWN")
        expect(classifyReminderKind("روزساز — یادآور آزمایشی")).toBe("UNKNOWN")
        expect(classifyReminderKind(undefined)).toBe("UNKNOWN")
    })
})

describe("recordNativeDiagnostic", () => {
    beforeEach(() => {
        clearNativeDiagnostics()
    })

    it("ورودی را با seq صعودی و زمان ثبت می‌کند", () => {
        const first = recordNativeDiagnostic({
            event: "SCHEDULE_REQUESTED",
            kind: "TASK",
            id: 42,
            title: "🔔 تست",
            requestedAt: 1_700_000_000_000,
            requestedAtIso: "2023-11-14T22:13:20.000Z",
            delayMs: 120_000,
            isExact: true,
            allowWhileIdle: true,
            channelId: "roozsaz_reminders",
        })
        const second = recordNativeDiagnostic({ event: "SCHEDULE_RESOLVED", kind: "TASK", id: 42 })

        expect(first).not.toBeNull()
        expect(second).not.toBeNull()
        expect(second!.seq).toBeGreaterThan(first!.seq)
        expect(first!.at).toBeGreaterThan(0)
        expect(first!.iso).toBe(new Date(first!.at).toISOString())

        const all = getNativeDiagnostics()
        expect(all).toHaveLength(2)
        expect(all[0].event).toBe("SCHEDULE_REQUESTED")
        expect(all[0].isExact).toBe(true)
        expect(all[0].allowWhileIdle).toBe(true)
        expect(all[1].event).toBe("SCHEDULE_RESOLVED")
    })

    it("هرگز بیش از سقف رشد نمی‌کند و قدیمی‌ترین‌ها را می‌ریزد", () => {
        for (let i = 0; i < MAX_NATIVE_DIAGNOSTIC_ENTRIES + 10; i += 1) {
            recordNativeDiagnostic({ event: "SCHEDULE_REQUESTED", kind: "DAILY", id: i })
        }

        const all = getNativeDiagnostics()
        expect(all).toHaveLength(MAX_NATIVE_DIAGNOSTIC_ENTRIES)
        // قدیمی‌ترین ۱۰ مورد ریخته شده‌اند؛ آخرین مورد همان آخرین ثبت است.
        expect(all[all.length - 1].id).toBe(MAX_NATIVE_DIAGNOSTIC_ENTRIES + 9)
    })

    it("snapshot فهرست pending را همان‌طور که بود نگه می‌دارد", () => {
        recordNativeDiagnostic({
            event: "PENDING_SNAPSHOT",
            kind: "TASK",
            id: 7,
            focusFound: true,
            pending: [{ id: 7, title: "🔔 تست", atIso: "2023-11-14T22:15:20.000Z" }],
        })

        const snapshot = getNativeDiagnostics()[0]
        expect(snapshot.focusFound).toBe(true)
        expect(snapshot.pending).toHaveLength(1)
        expect(snapshot.pending?.[0].atIso).toBe("2023-11-14T22:15:20.000Z")
    })

    it("اگر ورودی عجیب باشد هم throw نمی‌کند", () => {
        expect(() =>
            recordNativeDiagnostic({
                event: "CANNOT_HAPPEN" as never,
                kind: "UNKNOWN",
            }),
        ).not.toThrow()
    })
})

describe("subscribeNativeDiagnostics", () => {
    beforeEach(() => {
        clearNativeDiagnostics()
    })

    it("بلافاصله وضعیت فعلی را می‌دهد و بعد از هر ثبت دوباره صدا زده می‌شود", () => {
        const listener = vi.fn()

        const unsubscribe = subscribeNativeDiagnostics(listener)
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenLastCalledWith([])

        recordNativeDiagnostic({ event: "CANCEL_REQUESTED", kind: "UNKNOWN", id: 1 })
        expect(listener).toHaveBeenCalledTimes(2)
        expect(listener.mock.calls[1][0]).toHaveLength(1)

        unsubscribe()
        recordNativeDiagnostic({ event: "CANCEL_DONE", kind: "UNKNOWN", id: 1 })
        // بعد از لغو اشتراک، هیچ فراخوانی تازه‌ای نباید بیاید.
        expect(listener).toHaveBeenCalledTimes(2)
    })

    it("مشترک خراب بقیه را متوقف نمی‌کند", () => {
        const broken = vi.fn(() => {
            throw new Error("boom")
        })
        const healthy = vi.fn()

        const stopBroken = subscribeNativeDiagnostics(broken)
        const stopHealthy = subscribeNativeDiagnostics(healthy)

        expect(() =>
            recordNativeDiagnostic({ event: "SCHEDULE_FAILED", kind: "DAILY", id: 2 }),
        ).not.toThrow()

        expect(healthy).toHaveBeenCalledTimes(2)
        stopBroken()
        stopHealthy()
    })
})

describe("clearNativeDiagnostics", () => {
    it("حلقه را خالی می‌کند و شماره‌ی ترتیبی دیگر لازم نیست صفر شود", () => {
        recordNativeDiagnostic({ event: "SCHEDULE_REQUESTED", kind: "TASK", id: 1 })
        clearNativeDiagnostics()
        expect(getNativeDiagnostics()).toHaveLength(0)

        const after = recordNativeDiagnostic({ event: "SCHEDULE_REQUESTED", kind: "TASK", id: 2 })
        expect(after).not.toBeNull()
    })
})

describe("formatNativeDiagnostic", () => {
    beforeEach(() => {
        clearNativeDiagnostics()
    })

    it("همه‌ی فیلدهای مهمِ یک زمان‌بندی را در یک خط می‌آورد", () => {
        const entry = recordNativeDiagnostic({
            event: "SCHEDULE_RESOLVED",
            kind: "TASK",
            id: 42,
            title: "🔔 تست",
            requestedAtIso: "2023-11-14T22:15:20.000Z",
            delayMs: 120_000,
            isExact: true,
            allowWhileIdle: true,
        })

        const line = formatNativeDiagnostic(entry!)

        expect(line).toContain("SCHEDULE_RESOLVED")
        expect(line).toContain("kind=TASK")
        expect(line).toContain("id=42")
        expect(line).toContain("at=2023-11-14T22:15:20.000Z")
        expect(line).toContain("in=120s")
        expect(line).toContain("exact=true")
        expect(line).toContain("whileIdle=true")
    })

    it("پشته‌ی فشرده خط اول Error را دور می‌ریزد و چند فریم می‌دهد", () => {
        const stack = captureDiagnosticStack()

        expect(typeof stack).toBe("string")
        // خط اول همیشه «Error: native-diagnostics» است و عمداً حذف می‌شود.
        expect(stack).not.toContain("Error:")
        // هرگز بیش از تعداد فریم‌های اعلام‌شده فریم ندارد (با جداکننده‌ی ` | `).
        expect(stack.split(" | ").length).toBeLessThanOrEqual(NATIVE_DIAGNOSTIC_STACK_FRAMES)
    })
})

describe("readExactAlarmDiagnostic", () => {
    it("در non-native محیط وضعیت unknown برمی‌گرداند", async () => {
        const diag = await readExactAlarmDiagnostic(null)

        expect(diag.native).toBe(false)
        expect(diag.canReadExactSetting).toBe(false)
        expect(diag.exactAlarmSetting).toBe("unknown")
        expect(diag.manifestDeclarativeOnly).toBe(false)
    })

    /*
     * حالت‌های زیر فقط داخل محیط نیتیو معنا دارند: خودِ تابع عمداً قبل از هر
     * کاری `window.Capacitor.isNativePlatform()` را می‌پرسد و بیرون از APK
     * `native: false` برمی‌گرداند. محیط تست `node` است (نه jsdom)، پس globals
     * لازم است stub شوند — وگرنه این تست‌ها هرگز نمی‌توانند تابع را در حالت
     * نیتیو اجرا کنند.
     */
    describe("در محیط نیتیو", () => {
        beforeEach(() => {
            vi.stubGlobal("window", { Capacitor: { isNativePlatform: () => true } })
        })

        afterEach(() => {
            vi.unstubAllGlobals()
        })

        it("وقتی تابع خوانشی نداشته باشیم یک diagnostic only برمی‌گرداند", async () => {
            /*
             * ورودی اینجا `null` است، نه یک تابع که `null` برمی‌گرداند:
             * وقتی خودِ خواننده وجود ندارد، API قابل خواندن نیست، پس
             * `canReadExactSetting` باید false بماند. تابعی که اجرا می‌شود و
             * مقدار نامعتبر می‌دهد حالت دیگری است، نه این یکی.
             */
            const diag = await readExactAlarmDiagnostic(null)

            expect(diag.native).toBe(true)
            expect(diag.canReadExactSetting).toBe(false)
            expect(diag.exactAlarmSetting).toBe("unknown")
            expect(diag.manifestDeclarativeOnly).toBe(true)
        })

        it("در صورت خوانش موفق وضعیت را برچسب‌گذاری می‌کند", async () => {
            const read = vi.fn()
            read.mockResolvedValue({ exact_alarm: "granted" })

            const granted = await readExactAlarmDiagnostic(read)

            expect(granted.native).toBe(true)
            expect(granted.canReadExactSetting).toBe(true)
            expect(granted.exactAlarmSetting).toBe("granted")
            expect(read).toHaveBeenCalledTimes(1)

            read.mockResolvedValue({ exact_alarm: "denied" })
            const denied = await readExactAlarmDiagnostic(read)

            expect(denied.exactAlarmSetting).toBe("denied")

            read.mockResolvedValue({ exact_alarm: "unknown" })
            const unknown = await readExactAlarmDiagnostic(read)

            expect(unknown.exactAlarmSetting).toBe("unknown")
        })

        it("خطای خوانش را خاموش می‌کند و fallback برمی‌گرداند", async () => {
            const read = vi.fn()
            read.mockRejectedValue(new Error("kitamura"))

            const diag = await readExactAlarmDiagnostic(read)

            expect(diag.native).toBe(true)
            expect(diag.canReadExactSetting).toBe(false)
            expect(diag.exactAlarmSetting).toBe("unknown")
            expect(diag.manifestDeclarativeOnly).toBe(true)
        })
    })
})
