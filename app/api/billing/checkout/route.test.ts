// فاز ۵ — گام ۱۸: route integration tests برای POST /api/billing/checkout (سند §35 «Checkout route tests»)
//
// مرزهای تست:
// - route با mock لایه سرویس/آداپتر ایزوله می‌شود (اجازه‌ی صریح سند گام ۱۸)؛ هیچ DB/provider واقعی نیست.
// - concurrency واقعی جزو گام ۱۹ است و این‌جا فقط رفتار مسیر طبیعی route تست می‌شود.
// - کل route باید با mockهای فعلی سبز بماند؛ هیچ تغییری در production لازم نیست.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getPrisma: vi.fn(),
    recordError: vi.fn(),
    prepareCheckout: vi.fn(),
    attachProviderAuthority: vi.fn(),
    resolveCheckoutSettings: vi.fn(),
    createPayment: vi.fn(),
    buildRedirectUrl: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))
vi.mock("@/app/lib/services/billing.service", () => ({
    prepareCheckout: mocks.prepareCheckout,
    attachProviderAuthority: mocks.attachProviderAuthority,
    resolveCheckoutSettings: mocks.resolveCheckoutSettings,
}))
vi.mock("@/app/lib/billing/zarinpal.adapter", () => ({
    zarinpalProvider: { id: "ZARINPAL", createPayment: mocks.createPayment },
    buildRedirectUrl: mocks.buildRedirectUrl,
}))

import { POST } from "./route"
import {
    PaymentConfigurationError,
    PaymentIdempotencyConflictError,
    PaymentStateUnresolvedError,
} from "@/app/lib/services/errors"
import { PaymentProviderError } from "@/app/lib/billing/provider"

const USER = { id: 7, email: "user@example.com", plan: "FREE" }
const NOW = new Date("2026-09-17T10:00:00.000Z")
const AMOUNT = 100000
const SETTINGS = {
    provider: "ZARINPAL" as const,
    orderTtlMs: 1_800_000,
    description: "DailyPilot PRO",
    callbackUrl: "https://app.example.com/api/billing/callback/zarinpal",
}

function pendingOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: "ord_1",
        userId: USER.id,
        provider: "ZARINPAL",
        merchantOrderId: "mo-1",
        checkoutIdempotencyKey: "key-1",
        amount: AMOUNT,
        currency: "IRR",
        status: "PENDING",
        providerAuthority: null,
        providerReference: null,
        entitlementDays: 30,
        requestId: null,
        expiresAt: new Date(NOW.getTime() + SETTINGS.orderTtlMs),
        paidAt: null,
        failureCode: null,
        entitlementId: null,
        ...overrides,
    }
}

function post(key: string | null, body?: unknown) {
    const headers = new Headers()
    if (key !== null) headers.set("Idempotency-Key", key)
    return POST(
        new NextRequest("http://localhost/api/billing/checkout", {
            method: "POST",
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    )
}

describe("POST /api/billing/checkout (§35 Checkout route tests)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getPrisma.mockReturnValue({})
        mocks.resolveCheckoutSettings.mockReturnValue(SETTINGS)
        mocks.buildRedirectUrl.mockImplementation(
            (authority: string) => `https://pay.example.com/start?Authority=${encodeURIComponent(authority)}`,
        )
    })

    it("unauthenticated → 401 with the standard UNAUTHORIZED envelope (no service call)", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await post("key-1")

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.prepareCheckout).not.toHaveBeenCalled()
        expect(mocks.createPayment).not.toHaveBeenCalled()
    })

    it("missing Idempotency-Key → 400 validation error; blank-after-trim counts as missing", async () => {
        for (const key of [null, "   "]) {
            const res = await post(key)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.ok).toBe(false)
            expect(body.error.code).toBe("VALIDATION_ERROR")
            expect(body.error.errors).toEqual({ idempotencyKey: expect.any(String) })
        }
        expect(mocks.prepareCheckout).not.toHaveBeenCalled()
    })

    it("trims the key before passing it to the service (route-level shape validation)", async () => {
        const order = pendingOrder({ providerAuthority: "A1" })
        mocks.prepareCheckout.mockResolvedValue({ order, reused: true })

        await post("  key-1  ")

        expect(mocks.prepareCheckout).toHaveBeenCalledWith(expect.anything(), {
            userId: USER.id,
            checkoutIdempotencyKey: "key-1",
            orderTtlMs: SETTINGS.orderTtlMs,
            requestId: expect.any(String),
        })
    })

    it("same key + same parameters → reuse: no second provider create, redirect from the stored authority", async () => {
        const order = pendingOrder({ providerAuthority: "A-STORED" })
        mocks.prepareCheckout.mockResolvedValue({ order, reused: true })

        const res = await post("key-1")

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: {
                orderId: "ord_1",
                status: "PENDING",
                redirectUrl: "https://pay.example.com/start?Authority=A-STORED",
                expiresAt: new Date(NOW.getTime() + SETTINGS.orderTtlMs).toISOString(),
            },
        })
        expect(mocks.createPayment).not.toHaveBeenCalled()
        expect(mocks.attachProviderAuthority).not.toHaveBeenCalled()
    })

    it("same key + conflicting concurrent creation (service conflict) → 409 PAYMENT_IDEMPOTENCY_CONFLICT", async () => {
        mocks.prepareCheckout.mockRejectedValue(new PaymentIdempotencyConflictError())

        const res = await post("key-1")

        expect(res.status).toBe(409)
        const body = await res.json()
        expect(body.ok).toBe(false)
        expect(body.error.code).toBe("PAYMENT_IDEMPOTENCY_CONFLICT")
        expect(mocks.createPayment).not.toHaveBeenCalled()
    })

    it("client cannot override amount, duration or plan — provider request uses only server-side order values", async () => {
        const order = pendingOrder()
        mocks.prepareCheckout.mockResolvedValue({ order, reused: false })
        mocks.createPayment.mockResolvedValue({ authority: "A-NEW", redirectUrl: "ignored" })
        mocks.attachProviderAuthority.mockResolvedValue(pendingOrder({ providerAuthority: "A-NEW" }))

        const res = await post("key-1", {
            amount: 1,
            currency: "USD",
            entitlementDays: 9999,
            plan: "MAX",
            merchantOrderId: "client-chosen",
        })

        expect(res.status).toBe(200)
        expect(mocks.createPayment).toHaveBeenCalledTimes(1)
        const arg = mocks.createPayment.mock.calls[0][0] as Record<string, unknown>
        expect(arg.amount).toBe(AMOUNT) // از سفارش سروری، نه از بدنه‌ی client
        expect(arg.merchantOrderId).toBe("mo-1") // server-generated
        expect(arg.description).toBe(SETTINGS.description)
        expect(arg.currency).toBe("IRR")
        // سرویس هرگز ورودی client را نمی‌پذیرد — فقط userId/key/ttl/requestId
        const serviceArg = mocks.prepareCheckout.mock.calls[0][1] as Record<string, unknown>
        expect(Object.keys(serviceArg).sort()).toEqual(
            ["checkoutIdempotencyKey", "orderTtlMs", "requestId", "userId"].sort(),
        )
    })

    it("provider create success → 200 safe envelope with orderId/status/redirectUrl/expiresAt and X-Request-ID", async () => {
        mocks.prepareCheckout.mockResolvedValue({ order: pendingOrder(), reused: false })
        mocks.createPayment.mockResolvedValue({ authority: "A-NEW", redirectUrl: "https://provider-raw.example" })
        mocks.attachProviderAuthority.mockResolvedValue(pendingOrder({ providerAuthority: "A-NEW" }))

        const res = await post("key-1")

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({
            ok: true,
            data: {
                orderId: "ord_1",
                status: "PENDING",
                redirectUrl: "https://pay.example.com/start?Authority=A-NEW",
                expiresAt: new Date(NOW.getTime() + SETTINGS.orderTtlMs).toISOString(),
            },
        })
        // داده‌ی خام provider (redirectUrl خود provider) هرگز به پاسخ نمی‌رسد
        // (این test-double مقدارش را با authority یکسان کرده، پس فقط دامنه‌ی خام provider را چک می‌کنیم)
        expect(JSON.stringify(body)).not.toContain("provider-raw.example")
        expect(res.headers.get("X-Request-ID")).toBeTruthy()
        // requestId همان correlation وارد شده به سرویس است (سند §22)
        const serviceArg = mocks.prepareCheckout.mock.calls[0][1] as { requestId?: string }
        expect(res.headers.get("X-Request-ID")).toBe(serviceArg.requestId)
    })

    it("builds the per-order callback URL with ref=<merchantOrderId> from the configured base (URL API)", async () => {
        mocks.prepareCheckout.mockResolvedValue({ order: pendingOrder(), reused: false })
        mocks.createPayment.mockResolvedValue({ authority: "A-NEW" })
        mocks.attachProviderAuthority.mockResolvedValue(pendingOrder({ providerAuthority: "A-NEW" }))

        await post("key-1")

        const arg = mocks.createPayment.mock.calls[0][0] as { callbackUrl: string }
        expect(arg.callbackUrl).toBe(
            "https://app.example.com/api/billing/callback/zarinpal?ref=mo-1",
        )
    })

    it("provider timeout → 503 PAYMENT_PROVIDER_UNAVAILABLE, authority never attached, error recorded", async () => {
        mocks.prepareCheckout.mockResolvedValue({ order: pendingOrder(), reused: false })
        mocks.createPayment.mockRejectedValue(new PaymentProviderError("UNAVAILABLE", "provider timeout"))

        const res = await post("key-1")

        expect(res.status).toBe(503)
        const body = await res.json()
        expect(body.error.code).toBe("PAYMENT_PROVIDER_UNAVAILABLE")
        // پیام/بدنه‌ی خام provider منتقل نمی‌شود (سند §33)
        expect(body.error.message).not.toContain("provider timeout")
        expect(mocks.attachProviderAuthority).not.toHaveBeenCalled()
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })

    it("provider failure → 503 PAYMENT_PROVIDER_REJECTED with the safe envelope", async () => {
        mocks.prepareCheckout.mockResolvedValue({ order: pendingOrder(), reused: false })
        mocks.createPayment.mockRejectedValue(new PaymentProviderError("REJECTED", "merchant invalid"))

        const res = await post("key-1")

        expect(res.status).toBe(503)
        const body = await res.json()
        expect(body.error.code).toBe("PAYMENT_PROVIDER_REJECTED")
        expect(JSON.stringify(body)).not.toContain("merchant invalid")
    })

    it("provider malformed response → 503 PAYMENT_PROVIDER_INVALID_RESPONSE", async () => {
        mocks.prepareCheckout.mockResolvedValue({ order: pendingOrder(), reused: false })
        mocks.createPayment.mockRejectedValue(new PaymentProviderError("INVALID_RESPONSE", "no authority"))

        const res = await post("key-1")

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("PAYMENT_PROVIDER_INVALID_RESPONSE")
    })

    it("terminal order (PAID) → idempotent 200 with NO redirectUrl and NO provider call", async () => {
        mocks.prepareCheckout.mockResolvedValue({
            order: pendingOrder({ status: "PAID", providerAuthority: "A-PAID" }),
            reused: true,
        })

        const res = await post("key-1")

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.data.status).toBe("PAID")
        expect(body.data).not.toHaveProperty("redirectUrl")
        expect(mocks.createPayment).not.toHaveBeenCalled()
        expect(mocks.buildRedirectUrl).not.toHaveBeenCalled()
    })

    it("reused PENDING without a stored authority → 503 PAYMENT_STATE_UNRESOLVED (never a second create)", async () => {
        mocks.prepareCheckout.mockResolvedValue({ order: pendingOrder(), reused: true })

        const res = await post("key-1")

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("PAYMENT_STATE_UNRESOLVED")
        expect(mocks.createPayment).not.toHaveBeenCalled()
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
        expect(mocks.recordError.mock.calls[0][0]).toBeInstanceOf(PaymentStateUnresolvedError)
    })

    it("authority persistence failure after a successful create → 503 PAYMENT_STATE_UNRESOLVED (order stays PENDING)", async () => {
        mocks.prepareCheckout.mockResolvedValue({ order: pendingOrder(), reused: false })
        mocks.createPayment.mockResolvedValue({ authority: "A-NEW" })
        mocks.attachProviderAuthority.mockResolvedValue(pendingOrder({ providerAuthority: null }))

        const res = await post("key-1")

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("PAYMENT_STATE_UNRESOLVED")
    })

    it("invalid server configuration → 500 PAYMENT_CONFIGURATION_ERROR (no invented defaults)", async () => {
        mocks.resolveCheckoutSettings.mockImplementation(() => {
            throw new PaymentConfigurationError()
        })

        const res = await post("key-1")

        expect(res.status).toBe(500)
        expect((await res.json()).error.code).toBe("PAYMENT_CONFIGURATION_ERROR")
        expect(mocks.createPayment).not.toHaveBeenCalled()
    })

    it("redirect is derived only from the stored authority after attach (no raw provider payload)", async () => {
        mocks.prepareCheckout.mockResolvedValue({ order: pendingOrder(), reused: false })
        mocks.createPayment.mockResolvedValue({ authority: "A-ATTACHED" })
        mocks.attachProviderAuthority.mockResolvedValue(pendingOrder({ providerAuthority: "A-ATTACHED" }))

        await post("key-1")

        expect(mocks.buildRedirectUrl).toHaveBeenCalledWith("A-ATTACHED")
    })
})
