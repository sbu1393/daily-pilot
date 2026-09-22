// یادآورها — route tests برای /api/cron/reminders (تریگر زمان‌بندی‌شده)
//
// تمرکز اصلی امنیتی: این مسیر نشست ندارد، پس تنها محافظش CRON_SECRET است.
// تست‌ها قفل می‌کنند که هدر جعل‌پذیر `x-vercel-cron` به‌تنهایی **مجوز نیست**
// (وگرنه هر کلاینتی می‌توانست برای همه‌ی کاربران Push اسپم بفرستد).

import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
    // نوع بازگشت عمداً union است تا تستِ «CRON_SECRET تنظیم نشده → 503» بتواند null برگرداند
    readCronSecret: vi.fn<() => string | null>(() => "super-secret-cron-value"),
    runReminderCron: vi.fn(),
    recordError: vi.fn(),
}))

vi.mock("@/app/lib/cron/config", () => ({
    CRON_ENV: { secret: "CRON_SECRET", vercelHeader: "x-vercel-cron" },
    readCronSecret: mocks.readCronSecret,
    isCronConfigured: () => mocks.readCronSecret() !== null,
}))
vi.mock("@/app/lib/services/reminderCron.service", () => ({
    runReminderCron: mocks.runReminderCron,
}))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { GET, POST } from "./route"

const SECRET = "super-secret-cron-value"
const SUMMARY = {
    configured: true,
    scanned: 12,
    due: 3,
    sent: 2,
    failed: 1,
    removed: 0,
    errored: 0,
    truncated: false,
}

function request(options: {
    method?: "GET" | "POST"
    bearer?: string | null
    vercelHeader?: boolean
} = {}) {
    const headers = new Headers()
    if (options.bearer) headers.set("authorization", `Bearer ${options.bearer}`)
    if (options.vercelHeader) headers.set("x-vercel-cron", "1")

    return new NextRequest("http://localhost/api/cron/reminders", {
        method: options.method ?? "GET",
        headers,
    })
}

beforeEach(() => {
    mocks.readCronSecret.mockReset().mockReturnValue(SECRET)
    mocks.runReminderCron.mockReset().mockResolvedValue(SUMMARY)
    mocks.recordError.mockReset()
})

describe("GET /api/cron/reminders — احراز هویت", () => {
    it("بدون CRON_SECRET روی سرور → 503 (fail-closed، هیچ ارسالی)", async () => {
        mocks.readCronSecret.mockReturnValue(null)

        const res = await GET(request({ bearer: SECRET }))

        expect(res.status).toBe(503)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "CRON_NOT_CONFIGURED" } })
        expect(mocks.runReminderCron).not.toHaveBeenCalled()
    })

    it("بدون هدر Authorization → 401", async () => {
        const res = await GET(request())

        expect(res.status).toBe(401)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } })
        expect(mocks.runReminderCron).not.toHaveBeenCalled()
    })

    it("توکن اشتباه یا طرح احراز هویت نامعتبر → 401", async () => {
        for (const options of [
            { bearer: "wrong-secret" },
            { bearer: "super-secret-cron-valu" },
            { bearer: SECRET.toUpperCase() },
        ]) {
            const res = await GET(request(options))
            expect(res.status).toBe(401)
        }

        const basic = new NextRequest("http://localhost/api/cron/reminders", {
            headers: { authorization: `Basic ${SECRET}` },
        })
        expect((await GET(basic)).status).toBe(401)

        expect(mocks.runReminderCron).not.toHaveBeenCalled()
    })

    it("هدر x-vercel-cron به‌تنهایی مجوز نیست (ضد اسپم Push)", async () => {
        const res = await GET(request({ vercelHeader: true }))

        expect(res.status).toBe(401)
        expect(mocks.runReminderCron).not.toHaveBeenCalled()
    })

    it("توکن درست → 200 با شمارنده‌های تجمیعی", async () => {
        const res = await GET(request({ bearer: SECRET }))

        expect(res.status).toBe(200)
        expect(res.headers.get("X-Request-ID")).toBeTruthy()
        expect(await res.json()).toMatchObject({ ok: true, data: { ...SUMMARY, trigger: "external" } })
        expect(mocks.runReminderCron).toHaveBeenCalledTimes(1)
    })

    it("هدر Vercel فقط به‌عنوان نشانه‌ی منبع در پاسخ می‌آید", async () => {
        const res = await GET(request({ bearer: SECRET, vercelHeader: true }))

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ data: { trigger: "vercel-cron" } })
    })

    it("POST هم با همان راز کار می‌کند (زمان‌بند بیرونی)", async () => {
        const res = await POST(request({ method: "POST", bearer: SECRET }))

        expect(res.status).toBe(200)
        expect(mocks.runReminderCron).toHaveBeenCalledTimes(1)
    })

    it("خطای غیرمنتظره سرویس → 500 و recordError (بدون افشای جزئیات)", async () => {
        mocks.runReminderCron.mockRejectedValue(new Error("db down"))

        const res = await GET(request({ bearer: SECRET }))

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "INTERNAL" } })
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })

    it("پاسخ هیچ شناسه‌ی کاربر/ایمیلی افشا نمی‌کند", async () => {
        const res = await GET(request({ bearer: SECRET }))
        const body = JSON.stringify(await res.json())

        expect(body).not.toContain("@")
        expect(Object.keys(JSON.parse(body).data).sort()).toEqual([
            "configured",
            "due",
            "errored",
            "failed",
            "removed",
            "scanned",
            "sent",
            "trigger",
            "truncated",
        ])
    })
})
