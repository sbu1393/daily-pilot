import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({ runReminderScheduler: vi.fn(), recordError: vi.fn() }))

vi.mock("@/app/lib/services/reminderScheduler.service", () => ({
    runReminderScheduler: mocks.runReminderScheduler,
}))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { GET, POST } from "./route"

const SUMMARY = { ran: true, dueTasks: 1, sent: 1, failed: 0, gone: 0, skipped: 0 }

function req(method: string, headers: Record<string, string> = {}) {
    return new NextRequest("http://localhost/api/push/cron", { method, headers })
}

describe("/api/push/cron", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.runReminderScheduler.mockResolvedValue(SUMMARY)
        mocks.recordError.mockResolvedValue(undefined)
        delete process.env.CRON_SECRET
    })

    afterEach(() => {
        delete process.env.CRON_SECRET
    })

    it("rejects with 503 when CRON_SECRET is not configured and never runs", async () => {
        const res = await POST(req("POST"))

        expect(res.status).toBe(503)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("CRON_NOT_CONFIGURED")
        expect(mocks.runReminderScheduler).not.toHaveBeenCalled()
    })

    it("rejects with 401 for a wrong secret and never runs", async () => {
        process.env.CRON_SECRET = "top-secret"

        const res = await GET(req("GET", { authorization: "Bearer wrong" }))

        expect(res.status).toBe(401)
        expect(mocks.runReminderScheduler).not.toHaveBeenCalled()
    })

    it("runs the scheduler with a valid Bearer secret and returns the summary", async () => {
        process.env.CRON_SECRET = "top-secret"

        const res = await POST(req("POST", { authorization: "Bearer top-secret" }))

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: SUMMARY })
        expect(mocks.runReminderScheduler).toHaveBeenCalledTimes(1)
    })

    it("accepts x-cron-secret on GET as well", async () => {
        process.env.CRON_SECRET = "top-secret"

        const res = await GET(req("GET", { "x-cron-secret": "top-secret" }))

        expect(res.status).toBe(200)
        expect(mocks.runReminderScheduler).toHaveBeenCalledTimes(1)
    })

    it("never echoes the configured secret back (401 body, 200 body and headers)", async () => {
        process.env.CRON_SECRET = "top-secret"

        const rejected = await GET(req("GET", { authorization: "Bearer top-secret-ish" }))
        expect(rejected.status).toBe(401)
        expect(await rejected.text()).not.toContain("top-secret")
        expect(JSON.stringify([...rejected.headers.entries()])).not.toContain("top-secret")

        const accepted = await POST(req("POST", { authorization: "Bearer top-secret" }))
        expect(accepted.status).toBe(200)
        expect(await accepted.text()).not.toContain("top-secret")
    })

    it("returns a generic 500 without leaking the secret when the scheduler throws", async () => {
        process.env.CRON_SECRET = "top-secret"
        mocks.runReminderScheduler.mockRejectedValue(new Error("boom top-secret"))

        const res = await POST(req("POST", { authorization: "Bearer top-secret" }))

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } })
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })

    it("is fail-closed for a missing header even when the secret is configured", async () => {
        process.env.CRON_SECRET = "top-secret"

        const res = await GET(req("GET"))

        expect(res.status).toBe(401)
        expect(mocks.runReminderScheduler).not.toHaveBeenCalled()
    })
})
