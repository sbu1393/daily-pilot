// فاز ۵ — گام ۱۸: route integration tests برای GET /api/billing/callback/zarinpal
// (سند §35 «Callback route tests»)
//
// مرزهای تست:
// - route با mock سرویس/آداپتر ایزوله می‌شود (اجازه‌ی صریح سند گام ۱۸)؛ هیچ DB/provider واقعی نیست.
// - concurrency واقعی (repeated callback concurrently با دو فراخوانی هم‌زمان واقعی) جزو گام ۱۹ است؛
//   این‌جا دو *ترتیب* نتیجه‌ی هم‌زمانی (برنده/بازنده‌ی finalize) به‌صورت قطعی مدل می‌شود.
// - کل route باید با mockهای فعلی سبز بماند؛ هیچ تغییری در production لازم نیست.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
    getPrisma: vi.fn(),
    recordError: vi.fn(),
    recordProductEvent: vi.fn(),
    resolveCallbackOrder: vi.fn(),
    finalizeVerifiedPayment: vi.fn(),
    resolveCallbackResultUrls: vi.fn(),
    parseCallback: vi.fn(),
    verifyPayment: vi.fn(),
}))

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))
vi.mock("@/app/lib/services/productEvent.service", () => ({
    recordProductEvent: mocks.recordProductEvent,
}))
vi.mock("@/app/lib/services/billing.service", () => ({
    resolveCallbackOrder: mocks.resolveCallbackOrder,
    finalizeVerifiedPayment: mocks.finalizeVerifiedPayment,
    resolveCallbackResultUrls: mocks.resolveCallbackResultUrls,
}))
vi.mock("@/app/lib/billing/zarinpal.adapter", () => ({
    zarinpalProvider: {
        parseCallback: mocks.parseCallback,
        verifyPayment: mocks.verifyPayment,
    },
}))

import { GET } from "./route"
import { PaymentNotFoundError } from "@/app/lib/services/errors"

const BASE = "2026-09-17T10:00:00.000Z"
const EXPIRES = new Date(new Date(BASE).getTime() + 30 * 60 * 1000)
const URLS = {
    successUrl: "https://app.example.com/billing/result?state=success",
    failureUrl: "https://app.example.com/billing/result?state=failure",
}

function order(overrides: Record<string, unknown> = {}) {
    return {
        id: "ord_1",
        userId: 7,
        provider: "ZARINPAL",
        merchantOrderId: "mo-1",
        checkoutIdempotencyKey: "key-1",
        amount: 100000,
        currency: "IRR",
        status: "PENDING",
        providerAuthority: "A-1",
        providerReference: null,
        entitlementDays: 30,
        requestId: null,
        expiresAt: EXPIRES,
        paidAt: null,
        failureCode: null,
        entitlementId: null,
        ...overrides,
    }
}

function callback(query: string) {
    return GET(new NextRequest(`http://localhost/api/billing/callback/zarinpal?${query}`))
}

/** ریدایرکت ۳۰۲ به یکی از دو مقصد ثابت config (A1) — تنها خروجی عادی route. */
async function expectRedirect(res: Response, expected: "success" | "failure") {
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(URLS[`${expected}Url`])
    expect(res.headers.get("cache-control")).toBe("no-store")
}

describe("GET /api/billing/callback/zarinpal (§35 Callback route tests)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers({ now: new Date(BASE) })
        mocks.getPrisma.mockReturnValue({})
        mocks.resolveCallbackResultUrls.mockReturnValue(URLS)
        mocks.recordProductEvent.mockResolvedValue({ recorded: true })
        // parseCallback واقعی route را mock نمی‌کنیم به‌صورت پیش‌فرض؟ — نه: برای ایزولاسیون کامل،
        // همان قرارداد آداپتر واقعی را بازسازی می‌کنیم (فقط Authority + Status، بدون پارامتر اضافه).
        mocks.parseCallback.mockImplementation((input: { authority: string | null; status: string | null }) => ({
            authority: typeof input.authority === "string" ? input.authority.trim() || null : null,
            status:
                input.status === "OK" ? "SUCCESS" : input.status === "NOK" ? "FAILURE" : "UNKNOWN",
        }))
    })

    it("unknown payment reference → failure redirect, PAYMENT_NOT_FOUND is normal (never logged as error)", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        mocks.resolveCallbackOrder.mockRejectedValue(new PaymentNotFoundError())

        await expectRedirect(await callback("ref=missing&Authority=A-1&Status=OK"), "failure")

        expect(mocks.recordError).not.toHaveBeenCalled()
        expect(mocks.verifyPayment).not.toHaveBeenCalled()
    })

    it("missing Authority → failure redirect without touching the database", async () => {
        mocks.parseCallback.mockReturnValue({ authority: null, status: "UNKNOWN" })

        await expectRedirect(await callback("ref=mo-1&Status=OK"), "failure")

        expect(mocks.resolveCallbackOrder).not.toHaveBeenCalled()
        expect(mocks.verifyPayment).not.toHaveBeenCalled()
    })

    it("missing ref → failure redirect (callback params are untrusted and never logged)", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "UNKNOWN" })

        await expectRedirect(await callback("Authority=A-1"), "failure")

        expect(mocks.resolveCallbackOrder).not.toHaveBeenCalled()
        expect(mocks.recordError).not.toHaveBeenCalled()
    })

    it("invalid callback (unrecognized status) → failure redirect; Status alone is never authoritative", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "UNKNOWN" })
        mocks.resolveCallbackOrder.mockResolvedValue(order())
        mocks.verifyPayment.mockRejectedValue(new Error("must not be called for invalid status"))

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=WEIRD"), "failure")
    })

    it("failed provider verification → failure redirect, order unchanged (no FAILED persistence in callback)", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        mocks.resolveCallbackOrder.mockResolvedValue(order())
        mocks.verifyPayment.mockRejectedValue(new Error("provider said no"))

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=OK"), "failure")

        expect(mocks.finalizeVerifiedPayment).not.toHaveBeenCalled()
        expect(mocks.recordError).toHaveBeenCalledTimes(1) // operational failure is recorded (§22)
    })

    it("amount mismatch → failure redirect with no mutation (PAYMENT_INVALID_AMOUNT from finalize)", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        mocks.resolveCallbackOrder
            .mockResolvedValueOnce(order())
            .mockResolvedValueOnce(order())
        mocks.verifyPayment.mockResolvedValue({ reference: "ref-1", amount: 999 })
        const { PaymentInvalidAmountError } = await import("@/app/lib/services/errors")
        mocks.finalizeVerifiedPayment.mockRejectedValue(new PaymentInvalidAmountError())

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=OK"), "failure")

        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("successful verification → finalize + activation event + success redirect", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        mocks.resolveCallbackOrder
            .mockResolvedValueOnce(order())
            .mockResolvedValueOnce(order())
        mocks.verifyPayment.mockResolvedValue({ reference: "ref-1", amount: 100000 })
        mocks.finalizeVerifiedPayment.mockResolvedValue({
            order: order({ status: "PAID", providerReference: "ref-1" }),
            finalized: true,
            entitlement: { status: "ACTIVE" },
            entitlementAction: "ACTIVATED",
        })

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=OK"), "success")

        // verify سمت سرور با مبلغ سفارش سروری انجام شده است
        expect(mocks.verifyPayment).toHaveBeenCalledWith({ authority: "A-1", amount: 100000 })
        expect(mocks.finalizeVerifiedPayment).toHaveBeenCalledWith(expect.anything(), {
            authority: "A-1",
            verification: { reference: "ref-1", amount: 100000 },
        })
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(1)
        const [userId, eventName, props] = mocks.recordProductEvent.mock.calls[0] as [
            number,
            string,
            Record<string, unknown>,
        ]
        expect(userId).toBe(7)
        expect(eventName).toBe("billing.entitlement_activated")
        expect(props).toEqual({ provider: "ZARINPAL", entitlementDays: 30 })
    })

    it("successful renewal → billing.entitlement_renewed with the renewal-type property", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        mocks.resolveCallbackOrder
            .mockResolvedValueOnce(order())
            .mockResolvedValueOnce(order())
        mocks.verifyPayment.mockResolvedValue({ reference: "ref-1", amount: 100000 })
        mocks.finalizeVerifiedPayment.mockResolvedValue({
            order: order({ status: "PAID", providerReference: "ref-1" }),
            finalized: true,
            entitlement: { status: "ACTIVE" },
            entitlementAction: "RENEWED",
        })

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=OK"), "success")

        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            7,
            "billing.entitlement_renewed",
            { provider: "ZARINPAL", entitlementDays: 30, renewalType: "EXTENDS_CURRENT" },
            expect.objectContaining({ requestId: expect.any(String), feature: "billing" }),
        )
    })

    it("duplicate callback after PAID → idempotent success redirect, NO provider verify, NO event", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        mocks.resolveCallbackOrder.mockResolvedValue(order({ status: "PAID" }))

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=OK"), "success")

        expect(mocks.verifyPayment).not.toHaveBeenCalled()
        expect(mocks.finalizeVerifiedPayment).not.toHaveBeenCalled()
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        // کم‌نویز (§22): یک مشاهده‌ی INFO، هرگز خطای تکرارشونده
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
        const [error, , opts] = mocks.recordError.mock.calls[0] as [
            { severity?: string },
            unknown,
            { severity?: string },
        ]
        expect(opts?.severity).toBe("INFO")
    })

    it("repeated callback concurrently (loser path: finalize returns finalized=false) → no second event", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        mocks.resolveCallbackOrder
            .mockResolvedValueOnce(order())
            .mockResolvedValueOnce(order({ status: "PENDING" }))
        mocks.verifyPayment.mockResolvedValue({ reference: "ref-1", amount: 100000 })
        // یکی دیگر از callbackها همین الان نهایی کرده است (finalized=false = no-op replay)
        mocks.finalizeVerifiedPayment.mockResolvedValue({
            order: order({ status: "PAID", providerReference: "ref-1" }),
            finalized: false,
            entitlement: { status: "ACTIVE" },
            entitlementAction: null,
        })

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=OK"), "success")

        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("repeated callback concurrently (winner finished between verify and re-read) → idempotent success", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        // خواندن اول PENDING، خواندن دوم (بعد از verify) PAID → هم‌زمانی‌ای که برنده جلو زده
        mocks.resolveCallbackOrder
            .mockResolvedValueOnce(order())
            .mockResolvedValueOnce(order({ status: "PAID" }))

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=OK"), "success")

        expect(mocks.finalizeVerifiedPayment).not.toHaveBeenCalled()
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("provider timeout during verify → failure redirect, order untouched", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        mocks.resolveCallbackOrder.mockResolvedValue(order())
        mocks.verifyPayment.mockRejectedValue(new Error("timeout"))

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=OK"), "failure")

        expect(mocks.finalizeVerifiedPayment).not.toHaveBeenCalled()
    })

    it("expired PENDING order with a late successful callback → failure, no grant, no revive (A4)", async () => {
        vi.useRealTimers()
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        const expired = order({
            expiresAt: new Date(new Date(BASE).getTime() - 1000),
        })
        mocks.resolveCallbackOrder
            .mockResolvedValueOnce(expired)
            .mockResolvedValueOnce(expired)
        mocks.verifyPayment.mockResolvedValue({ reference: "ref-1", amount: 100000 })

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=OK"), "failure")

        // هرگز verify/finalize نزده و هیچ سفارشی را زنده نکرده است
        expect(mocks.verifyPayment).not.toHaveBeenCalled()
        expect(mocks.finalizeVerifiedPayment).not.toHaveBeenCalled()
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("Status=NOK → failure redirect with zero mutation and no verify (A3)", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "FAILURE" })
        mocks.resolveCallbackOrder.mockResolvedValue(order())

        await expectRedirect(await callback("ref=mo-1&Authority=A-1&Status=NOK"), "failure")

        expect(mocks.verifyPayment).not.toHaveBeenCalled()
        expect(mocks.finalizeVerifiedPayment).not.toHaveBeenCalled()
        expect(mocks.recordError).not.toHaveBeenCalled()
    })

    it("safe redirect: destinations come only from config — no param, ref or authority ever lands in Location", async () => {
        mocks.parseCallback.mockReturnValue({ authority: "A-1", status: "SUCCESS" })
        mocks.resolveCallbackOrder.mockResolvedValue(order({ status: "PAID" }))

        const res = await callback("ref=mo-1&Authority=A-1&Status=OK&next=https://evil.example")
        const location = res.headers.get("location") ?? ""

        expect(location).toBe(URLS.successUrl)
        expect(location).not.toContain("evil.example")
        expect(location).not.toContain("A-1")
        expect(location).not.toContain("mo-1")
    })

    it("response and redirects never leak provider fields (§33)", async () => {
        // Status=NOK (پارس پیش‌فرض beforeEach) → مسیر شکست قطعی بدون verify/finalize
        mocks.resolveCallbackOrder.mockResolvedValue(order())

        const res = await callback("ref=mo-1&Authority=A-1&Status=NOK")
        const headers = JSON.stringify(Object.fromEntries(res.headers.entries()))

        expect(headers.toLowerCase()).not.toContain("authority")
        expect(headers.toLowerCase()).not.toContain("mo-1")
        await expectRedirect(res, "failure")
    })

    it("invalid result-URL configuration → 500 PAYMENT_CONFIGURATION_ERROR envelope (no unsafe fallback redirect)", async () => {
        const { PaymentConfigurationError } = await import("@/app/lib/services/errors")
        mocks.resolveCallbackResultUrls.mockImplementation(() => {
            throw new PaymentConfigurationError()
        })

        const res = await callback("ref=mo-1&Authority=A-1&Status=OK")

        expect(res.status).toBe(500)
        const body = await res.json()
        expect(body.ok).toBe(false)
        expect(body.error.code).toBe("PAYMENT_CONFIGURATION_ERROR")
    })

    it("propagates the observability context requestId into error responses", async () => {
        const { PaymentConfigurationError } = await import("@/app/lib/services/errors")
        mocks.resolveCallbackResultUrls.mockImplementation(() => {
            throw new PaymentConfigurationError()
        })

        const res = await callback("ref=mo-1&Authority=A-1&Status=OK")

        expect(res.headers.get("X-Request-ID")).toMatch(/[0-9a-f-]{36}/)
        const context = mocks.recordError.mock.calls[0][1] as { endpoint?: string; feature?: string }
        expect(context.endpoint).toBe("/api/billing/callback/zarinpal")
        expect(context.feature).toBe("billing")
    })
})
