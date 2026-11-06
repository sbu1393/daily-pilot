// اعلان‌های زمان‌بندی‌شده‌ی تسک‌ها — route tests برای /api/notifications/cron
//
// این مسیر نشست ندارد، پس تنها محافظش CRON_SECRET است. تست‌ها قفل می‌کنند که
// هدر جعل‌پذیر `x-vercel-cron` به‌تنهایی مجوز نیست و نوع نامعتبر اجرا نمی‌شود.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
    readCronSecret: vi.fn<() => string | null>(() => "super-secret-cron-value"),
    runTaskDigestCron: vi.fn(),
    runInactivityReminderCron: vi.fn(),
    recordError: vi.fn(),
}))

vi.mock("@/app/lib/cron/config", () => ({
    CRON_ENV: { secret: "CRON_SECRET", vercelHeader: "x-vercel-cron" },
    readCronSecret: mocks.readCronSecret,
    isCronConfigured: () => mocks.readCronSecret() !== null,
}))
vi.mock("@/app/lib/services/taskDigestCron.service", () => ({
    isTaskDigestKind: (value: string | null) =>
        value === "morning" || value === "night" || value === "overdue",
    runTaskDigestCron: mocks.runTaskDigestCron,
}))
vi.mock("@/app/lib/services/inactivityReminder.service", () => ({
    runInactivityReminderCron: mocks.runInactivityReminderCron,
}))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { GET, POST } from "./route"

const SECRET = "super-secret-cron-value"
const SUMMARY = {
    configured: true,
    kind: "morning",
    scanned: 12,
    matched: 3,
    skipped: 0,
    tasks: 7,
    sent: 2,
    failed: 1,
    removed: 0,
    errored: 0,
    truncated: false,
}

const INACTIVITY_SUMMARY = {
    configured: true,
    kind: "inactivity",
    scanned: 5,
    matched: 2,
    skipped: 1,
    sent: 3,
    failed: 1,
    removed: 0,
    errored: 0,
    truncated: false,
}

function request(options: {
    method?: "GET" | "POST"
    type?: string | null
    bearer?: string | null
    vercelHeader?: boolean
    scheduleHeader?: string
} = {}) {
    const headers = new Headers()
    if (options.bearer) headers.set("authorization", `Bearer ${options.bearer}`)
    if (options.vercelHeader) headers.set("x-vercel-cron", "1")
    if (options.scheduleHeader) headers.set("x-vercel-cron-schedule", options.scheduleHeader)

    const url = new URL("http://localhost/api/notifications/cron")
    if (options.type !== null && options.type !== undefined) {
        url.searchParams.set("type", options.type)
    }

    return new NextRequest(url, { method: options.method ?? "GET", headers })
}

beforeEach(() => {
    mocks.readCronSecret.mockReset().mockReturnValue(SECRET)
    mocks.runTaskDigestCron.mockReset().mockResolvedValue(SUMMARY)
    mocks.runInactivityReminderCron.mockReset().mockResolvedValue(INACTIVITY_SUMMARY)
    mocks.recordError.mockReset()
})

describe("GET /api/notifications/cron — احراز هویت", () => {
    it("بدون CRON_SECRET روی سرور → 503 (fail-closed)", async () => {
        mocks.readCronSecret.mockReturnValue(null)

        const res = await GET(request({ type: "morning", bearer: SECRET }))

        expect(res.status).toBe(503)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "CRON_NOT_CONFIGURED" } })
        expect(mocks.runTaskDigestCron).not.toHaveBeenCalled()
    })

    it("بدون هدر Authorization → 401", async () => {
        const res = await GET(request({ type: "morning" }))

        expect(res.status).toBe(401)
        expect(mocks.runTaskDigestCron).not.toHaveBeenCalled()
    })

    it("توکن اشتباه یا طرح نامعتبر → 401", async () => {
        expect((await GET(request({ type: "morning", bearer: "wrong" }))).status).toBe(401)

        const basic = new NextRequest(
            "http://localhost/api/notifications/cron?type=morning",
            { headers: { authorization: `Basic ${SECRET}` } },
        )
        expect((await GET(basic)).status).toBe(401)

        // قالب دقیق: حروف scheme حساس است و توکن نباید فاصله/بخش اضافه داشته باشد
        for (const authorization of [
            `bearer ${SECRET}`,
            `BEARER ${SECRET}`,
            `Bearer${SECRET}`,
            `Bearer ${SECRET} extra`,
            `Bearer  ${SECRET}`,
        ]) {
            const malformed = new NextRequest(
                "http://localhost/api/notifications/cron?type=morning",
                { headers: { authorization } },
            )
            expect((await GET(malformed)).status).toBe(401)
        }

        expect(mocks.runTaskDigestCron).not.toHaveBeenCalled()
    })

    it("هدر x-vercel-cron به‌تنهایی مجوز نیست", async () => {
        const res = await GET(request({ type: "morning", vercelHeader: true }))

        expect(res.status).toBe(401)
        expect(mocks.runTaskDigestCron).not.toHaveBeenCalled()
    })
})

describe("GET /api/notifications/cron — نوع اجرا", () => {
    it("type=morning → سرویس morning اجرا می‌شود", async () => {
        const res = await GET(request({ type: "morning", bearer: SECRET }))

        expect(res.status).toBe(200)
        expect(res.headers.get("X-Request-ID")).toBeTruthy()
        expect(await res.json()).toMatchObject({
            ok: true,
            data: { ...SUMMARY, trigger: "external" },
        })
        expect(mocks.runTaskDigestCron).toHaveBeenCalledWith("morning", expect.any(Date))
    })

    it("type=night و type=overdue هم پشتیبانی می‌شوند", async () => {
        expect((await GET(request({ type: "night", bearer: SECRET }))).status).toBe(200)
        expect(mocks.runTaskDigestCron).toHaveBeenLastCalledWith("night", expect.any(Date))

        expect((await GET(request({ type: "overdue", bearer: SECRET }))).status).toBe(200)
        expect(mocks.runTaskDigestCron).toHaveBeenLastCalledWith("overdue", expect.any(Date))
    })

    it("type=inactivity → سرویس اختصاصی بازگشت اجرا می‌شود (نه task digest)", async () => {
        const res = await GET(request({ type: "inactivity", bearer: SECRET }))

        expect(res.status).toBe(200)
        expect(mocks.runInactivityReminderCron).toHaveBeenCalledWith(expect.any(Date))
        expect(mocks.runTaskDigestCron).not.toHaveBeenCalled()
        expect(await res.json()).toMatchObject({
            ok: true,
            data: { ...INACTIVITY_SUMMARY, trigger: "external" },
        })
    })

    it("بدون type → از هدر x-vercel-cron-schedule نگاشت می‌شود", async () => {
        const res = await GET(
            request({ bearer: SECRET, scheduleHeader: "30 18 * * *", vercelHeader: true }),
        )

        expect(res.status).toBe(200)
        expect(mocks.runTaskDigestCron).toHaveBeenCalledWith("night", expect.any(Date))
        expect(await res.json()).toMatchObject({ data: { trigger: "vercel-cron" } })
    })

    it("schedule جدید 30 6 * * * به inactivity نگاشت می‌شود", async () => {
        const res = await GET(
            request({ bearer: SECRET, scheduleHeader: "30 6 * * *", vercelHeader: true }),
        )

        expect(res.status).toBe(200)
        expect(mocks.runInactivityReminderCron).toHaveBeenCalledWith(expect.any(Date))
        expect(mocks.runTaskDigestCron).not.toHaveBeenCalled()
        expect(await res.json()).toMatchObject({ data: { trigger: "vercel-cron" } })
    })

    it("type نامعتبر → 400 و بدون اجرا", async () => {
        const res = await GET(request({ type: "weekly", bearer: SECRET }))

        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } })
        expect(mocks.runTaskDigestCron).not.toHaveBeenCalled()
    })

    it("نه type و نه هدر زمان‌بندی → 400", async () => {
        const res = await GET(request({ bearer: SECRET }))

        expect(res.status).toBe(400)
        expect(mocks.runTaskDigestCron).not.toHaveBeenCalled()
    })

    it("خطای غیرمنتظره → 500 و recordError", async () => {
        mocks.runTaskDigestCron.mockRejectedValue(new Error("db down"))

        const res = await GET(request({ type: "morning", bearer: SECRET }))

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "INTERNAL" } })
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })

    it("خطای سرویس inactivity هم 500 و recordError می‌دهد", async () => {
        mocks.runInactivityReminderCron.mockRejectedValue(new Error("db down"))

        const res = await GET(request({ type: "inactivity", bearer: SECRET }))

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "INTERNAL" } })
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })

    it("POST هم با همان راز کار می‌کند", async () => {
        const res = await POST(request({ method: "POST", type: "overdue", bearer: SECRET }))

        expect(res.status).toBe(200)
        expect(mocks.runTaskDigestCron).toHaveBeenCalledWith("overdue", expect.any(Date))
    })
})
