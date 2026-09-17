// فاز ۵ — گام ۱۷: unit test های billing.service (سند §35: «payment state transitions»،
// «invalid transitions»، idempotency سفارش، resolve سفارش callback و نمای subscription)
//
// مرزهای تست:
// - فقط `PrismaClientLike` تزریق‌شده mock می‌شود؛ هیچ DB/provider واقعی وجود ندارد.
// - mockها state واقعی سرویس را مدل می‌کنند (نه race پنهان‌کن): شرط‌های `updateMany` عیناً
//   همان‌طور که سرویس می‌فرستد بررسی می‌شوند و «باخت در race» با count=0 مدل می‌شود.
// - config از env تستیِ صریح می‌آید و در پایان restore می‌شود (هیچ secret واقعی خوانده نمی‌شود).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BILLING_ENV } from "../billing/config"
import {
    PaymentConfigurationError,
    PaymentIdempotencyConflictError,
    PaymentInvalidAmountError,
    PaymentNotFoundError,
    PaymentStateUnresolvedError,
    PaymentVerificationFailedError,
} from "./errors"
import {
    attachProviderAuthority,
    finalizeVerifiedPayment,
    getSubscriptionView,
    prepareCheckout,
    resolveCallbackOrder,
    resolveCallbackResultUrls,
    resolveCheckoutSettings,
} from "./billing.service"

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date("2026-09-17T10:00:00.000Z")
const USER = 7
const KEY = "idem-key-1"
const TTL = 1_800_000
const AMOUNT = 100000
const DAYS = 30

const TEST_ENV: Record<string, string> = {
    [BILLING_ENV.proAmount]: String(AMOUNT),
    [BILLING_ENV.proCurrency]: "IRR",
    [BILLING_ENV.proEntitlementDays]: String(DAYS),
    [BILLING_ENV.merchantId]: "merchant-id-for-tests",
    [BILLING_ENV.mode]: "sandbox",
    [BILLING_ENV.baseUrl]: "https://sandbox.zarinpal.com/pg",
    [BILLING_ENV.callbackUrl]: "https://app.example.com/api/billing/callback/zarinpal",
    [BILLING_ENV.zarinpalDescription]: "DailyPilot PRO",
    [BILLING_ENV.orderTtlMs]: String(TTL),
    [BILLING_ENV.resultUrlSuccess]: "https://app.example.com/billing/result?state=success",
    [BILLING_ENV.resultUrlFailure]: "https://app.example.com/billing/result?state=failure",
}

const ENV_KEYS = Object.values(BILLING_ENV)
let originalEnv: Record<string, string | undefined> = {}

function order(overrides: Record<string, unknown> = {}) {
    return {
        id: "ord_1",
        userId: USER,
        provider: "ZARINPAL",
        merchantOrderId: "mo-1",
        checkoutIdempotencyKey: KEY,
        amount: AMOUNT,
        currency: "IRR",
        status: "PENDING",
        providerAuthority: null,
        providerReference: null,
        entitlementDays: DAYS,
        requestId: null,
        expiresAt: new Date(NOW.getTime() + TTL),
        paidAt: null,
        failureCode: null,
        entitlementId: null,
        ...overrides,
    }
}

function entitlementRow(overrides: Record<string, unknown> = {}) {
    return {
        id: "ent_1",
        userId: USER,
        provider: "ZARINPAL",
        status: "ACTIVE",
        planCode: "PRO",
        currentPeriodStart: new Date(NOW.getTime() - 10 * DAY),
        currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
        ...overrides,
    }
}

type Mock = ReturnType<typeof vi.fn>

interface FakeDb {
    paymentOrder: {
        findUnique: Mock
        findFirst: Mock
        create: Mock
        updateMany: Mock
        update: Mock
    }
    entitlement: { findUnique: Mock; create: Mock; updateMany: Mock }
    user: { updateMany: Mock }
    aiUsage: { findUnique: Mock }
    aiUsageEvent: { findMany: Mock }
    $transaction: Mock
}

/** کلاینت جعلی: کلیدها/شناسه‌ها از state خودِ تست resolve می‌شوند. */
function makeDb(): FakeDb {
    const db: FakeDb = {
        paymentOrder: {
            findUnique: vi.fn(async (args: unknown) => {
                const where = (args as { where?: Record<string, unknown> }).where ?? {}
                const compound = where.userId_checkoutIdempotencyKey as
                    | { userId?: number; checkoutIdempotencyKey?: string }
                    | undefined
                if (compound) return byKey.get(`${compound.userId}:${compound.checkoutIdempotencyKey}`) ?? null
                if (typeof where.id === "string") return byId.get(where.id) ?? null
                if (typeof where.merchantOrderId === "string") {
                    return byMerchant.get(where.merchantOrderId) ?? null
                }
                return null
            }),
            findFirst: vi.fn(async (args: unknown) => {
                const where = (args as { where?: Record<string, unknown> }).where ?? {}
                return typeof where.providerAuthority === "string"
                    ? (byAuthority.get(where.providerAuthority) ?? null)
                    : null
            }),
            create: vi.fn(async (args: unknown) => {
                const data = (args as { data: Record<string, unknown> }).data
                return {
                    id: "ord_new",
                    providerAuthority: null,
                    providerReference: null,
                    paidAt: null,
                    failureCode: null,
                    entitlementId: null,
                    ...data,
                }
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            update: vi.fn(),
        },
        entitlement: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn(async (args: unknown) => {
                const data = (args as { data: Record<string, unknown> }).data
                return { id: "ent_1", ...data }
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        // اگر سرویس بیلیینگ به مدل‌های quota دست بزند، تست باید صریحاً بشکند (§35)
        aiUsage: { findUnique: vi.fn(() => { throw new Error("billing must not touch quota") }) },
        aiUsageEvent: { findMany: vi.fn(() => { throw new Error("billing must not touch quota") }) },
        $transaction: vi.fn(),
    }
    db.$transaction = vi.fn(async (fn: (tx: FakeDb) => Promise<unknown>) => fn(db))
    return db
}

/** state lookup برای مدل‌کردن دقیق idempotency/authority. */
let byKey: Map<string, Record<string, unknown>>
let byId: Map<string, Record<string, unknown>>
let byAuthority: Map<string, Record<string, unknown>>
let byMerchant: Map<string, Record<string, unknown>>

function seed(...rows: Array<Record<string, unknown>>) {
    for (const row of rows) {
        byId.set(String(row.id), row)
        byKey.set(`${row.userId}:${row.checkoutIdempotencyKey}`, row)
        byMerchant.set(String(row.merchantOrderId), row)
        if (typeof row.providerAuthority === "string") byAuthority.set(row.providerAuthority, row)
    }
}

describe("billing.service", () => {
    let db: FakeDb

    beforeEach(() => {
        originalEnv = {}
        for (const key of ENV_KEYS) {
            originalEnv[key] = process.env[key]
            delete process.env[key]
        }
        for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value

        byKey = new Map()
        byId = new Map()
        byAuthority = new Map()
        byMerchant = new Map()
        db = makeDb()
    })

    afterEach(() => {
        for (const key of ENV_KEYS) {
            const value = originalEnv[key]
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    })

    // ------------------------------------------------------------ config mapping
    describe("resolveCheckoutSettings / resolveCallbackResultUrls", () => {
        it("maps server-side checkout settings from config (no hard-coded business values)", () => {
            expect(resolveCheckoutSettings()).toEqual({
                provider: "ZARINPAL",
                orderTtlMs: TTL,
                description: "DailyPilot PRO",
                callbackUrl: TEST_ENV[BILLING_ENV.callbackUrl],
            })
        })

        it("maps the two fixed callback result destinations from config", () => {
            expect(resolveCallbackResultUrls()).toEqual({
                successUrl: TEST_ENV[BILLING_ENV.resultUrlSuccess],
                failureUrl: TEST_ENV[BILLING_ENV.resultUrlFailure],
            })
        })

        it("maps invalid/missing configuration to PAYMENT_CONFIGURATION_ERROR without leaking values", () => {
            delete process.env[BILLING_ENV.orderTtlMs]

            for (const run of [() => resolveCheckoutSettings(), () => resolveCallbackResultUrls()]) {
                let caught: unknown
                try {
                    run()
                } catch (error) {
                    caught = error
                }

                expect(caught).toBeInstanceOf(PaymentConfigurationError)
                const message = (caught as Error).message
                expect(message).not.toContain(BILLING_ENV.orderTtlMs)
                expect(message).not.toContain(TEST_ENV[BILLING_ENV.merchantId])
            }
        })
    })

    // ------------------------------------------------------------ prepareCheckout
    describe("prepareCheckout (idempotent order creation)", () => {
        it("creates a PENDING order from server-side values with a server-generated reference", async () => {
            const result = await prepareCheckout(
                db as never,
                { userId: USER, checkoutIdempotencyKey: KEY, orderTtlMs: TTL, requestId: "req-1" },
                NOW,
            )

            const data = db.paymentOrder.create.mock.calls[0][0].data
            expect(data).toMatchObject({
                userId: USER,
                provider: "ZARINPAL",
                amount: AMOUNT,
                currency: "IRR",
                entitlementDays: DAYS,
                status: "PENDING",
                checkoutIdempotencyKey: KEY,
                requestId: "req-1",
                expiresAt: new Date(NOW.getTime() + TTL),
            })
            // ارجاع داخلی سرور-ساخته است (opaque) و هیچ ورودی client داخلش نیست
            expect(String(data.merchantOrderId)).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            )
            expect(result.reused).toBe(false)
            expect(result.order.status).toBe("PENDING")
        })

        it("omits requestId when no correlation id was provided", async () => {
            await prepareCheckout(db as never, { userId: USER, checkoutIdempotencyKey: KEY, orderTtlMs: TTL }, NOW)

            expect("requestId" in db.paymentOrder.create.mock.calls[0][0].data).toBe(false)
        })

        it("reuses the existing PENDING order for the same key (no second order, no provider work)", async () => {
            seed(order())
            const existing = byId.get("ord_1")

            const result = await prepareCheckout(
                db as never,
                { userId: USER, checkoutIdempotencyKey: KEY, orderTtlMs: TTL },
                NOW,
            )

            expect(result.reused).toBe(true)
            expect(result.order).toEqual(existing)
            expect(db.paymentOrder.create).not.toHaveBeenCalled()
            expect(db.paymentOrder.updateMany).not.toHaveBeenCalled()
        })

        it("lazily expires a past-due PENDING order with a conditional update and returns the terminal state", async () => {
            seed(order({ expiresAt: new Date(NOW.getTime() - 1000) }))
            const expiredRow = order({ expiresAt: new Date(NOW.getTime() - 1000), status: "EXPIRED" })
            db.paymentOrder.findUnique
                // ۱) lookup کلید، ۲) re-read بعد از transition
                .mockImplementationOnce(async () => byId.get("ord_1") ?? null)
                .mockImplementationOnce(async () => expiredRow)

            const result = await prepareCheckout(
                db as never,
                { userId: USER, checkoutIdempotencyKey: KEY, orderTtlMs: TTL },
                NOW,
            )

            expect(db.paymentOrder.updateMany).toHaveBeenCalledWith({
                where: { id: "ord_1", status: "PENDING", expiresAt: new Date(NOW.getTime() - 1000) },
                data: { status: "EXPIRED" },
            })
            expect(result.reused).toBe(true)
            expect(result.order.status).toBe("EXPIRED")
            expect(db.paymentOrder.create).not.toHaveBeenCalled()
        })

        it("returns every terminal order verbatim — never revives, resets or re-creates it", async () => {
            for (const status of ["PAID", "FAILED", "CANCELED", "EXPIRED"]) {
                byKey = new Map()
                byId = new Map()
                byMerchant = new Map()
                seed(order({ status }))

                const result = await prepareCheckout(
                    db as never,
                    { userId: USER, checkoutIdempotencyKey: KEY, orderTtlMs: TTL },
                    NOW,
                )

                expect(result.reused).toBe(true)
                expect(result.order.status).toBe(status)
                expect(db.paymentOrder.create).not.toHaveBeenCalled()
                expect(db.paymentOrder.updateMany).not.toHaveBeenCalled()
            }
        })

        it("treats an invalid order TTL as a configuration failure (no invented default)", async () => {
            for (const ttl of [0, -1, 1.5, Number.NaN]) {
                await expect(
                    prepareCheckout(db as never, { userId: USER, checkoutIdempotencyKey: KEY, orderTtlMs: ttl }, NOW),
                ).rejects.toBeInstanceOf(PaymentConfigurationError)
            }
            expect(db.paymentOrder.create).not.toHaveBeenCalled()
        })

        it("resolves a concurrent same-key creation race to PAYMENT_IDEMPOTENCY_CONFLICT", async () => {
            db.paymentOrder.create.mockRejectedValue({ code: "P2002" })

            await expect(
                prepareCheckout(db as never, { userId: USER, checkoutIdempotencyKey: KEY, orderTtlMs: TTL }, NOW),
            ).rejects.toBeInstanceOf(PaymentIdempotencyConflictError)
            expect(db.paymentOrder.create).toHaveBeenCalledTimes(3)
        })

        it("rethrows a non-unique infrastructure failure untouched (standard 500 path)", async () => {
            const infra = new Error("connection terminated unexpectedly")
            db.paymentOrder.create.mockRejectedValue(infra)

            await expect(
                prepareCheckout(db as never, { userId: USER, checkoutIdempotencyKey: KEY, orderTtlMs: TTL }, NOW),
            ).rejects.toBe(infra)
        })

        // ---------------------------------------------------- Idempotency-Key scope (§6)
        it("scopes idempotency to the key: a different key creates a separate order", async () => {
            seed(order())

            const result = await prepareCheckout(
                db as never,
                { userId: USER, checkoutIdempotencyKey: "idem-key-2", orderTtlMs: TTL },
                NOW,
            )

            expect(result.reused).toBe(false)
            expect(result.order.checkoutIdempotencyKey).toBe("idem-key-2")
            expect(db.paymentOrder.create).toHaveBeenCalledTimes(1)
        })

        it("scopes idempotency per user: the same key for another user is not reused", async () => {
            seed(order())

            const result = await prepareCheckout(
                db as never,
                { userId: USER + 1, checkoutIdempotencyKey: KEY, orderTtlMs: TTL },
                NOW,
            )

            expect(result.reused).toBe(false)
            expect(db.paymentOrder.create).toHaveBeenCalledTimes(1)
        })

        it("persists the key verbatim (shape validation is the route's job — never trimmed here)", async () => {
            await prepareCheckout(
                db as never,
                { userId: USER, checkoutIdempotencyKey: "  key-with-spaces  ", orderTtlMs: TTL },
                NOW,
            )

            const data = (db.paymentOrder.create.mock.calls[0] as unknown[])[0] as {
                data: Record<string, unknown>
            }
            expect(data.data.checkoutIdempotencyKey).toBe("  key-with-spaces  ")
        })

        it("creates the order without any provider authority or reference (provider work stays in the route)", async () => {
            await prepareCheckout(db as never, { userId: USER, checkoutIdempotencyKey: KEY, orderTtlMs: TTL }, NOW)

            const data = (db.paymentOrder.create.mock.calls[0] as unknown[])[0] as {
                data: Record<string, unknown>
            }
            expect(data.data).not.toHaveProperty("providerAuthority")
            expect(data.data).not.toHaveProperty("providerReference")
            expect(data.data.status).toBe("PENDING")
        })
    })

    // ------------------------------------------------------------ attachProviderAuthority
    describe("attachProviderAuthority (conditional authority persistence)", () => {
        it("attaches the authority to a PENDING order with a conditional update", async () => {
            seed(order())
            db.paymentOrder.findUnique
                .mockImplementationOnce(async () => byId.get("ord_1") ?? null)
                .mockImplementationOnce(async () => order({ providerAuthority: "A1" }))

            const result = await attachProviderAuthority(db as never, {
                userId: USER,
                checkoutIdempotencyKey: KEY,
                authority: "A1",
            })

            expect(db.paymentOrder.updateMany).toHaveBeenCalledWith({
                where: { id: "ord_1", status: "PENDING", providerAuthority: null },
                data: { providerAuthority: "A1" },
            })
            expect(result.providerAuthority).toBe("A1")
        })

        it("is a no-op when the same authority is already attached", async () => {
            seed(order({ providerAuthority: "A1" }))

            const result = await attachProviderAuthority(db as never, {
                userId: USER,
                checkoutIdempotencyKey: KEY,
                authority: "A1",
            })

            expect(db.paymentOrder.updateMany).not.toHaveBeenCalled()
            expect(result.providerAuthority).toBe("A1")
        })

        it("never overwrites a different stored authority", async () => {
            seed(order({ providerAuthority: "A1" }))

            await expect(
                attachProviderAuthority(db as never, {
                    userId: USER,
                    checkoutIdempotencyKey: KEY,
                    authority: "A2",
                }),
            ).rejects.toBeInstanceOf(PaymentIdempotencyConflictError)
            expect(db.paymentOrder.updateMany).not.toHaveBeenCalled()
        })

        it("refuses to attach to a terminal order (no revive)", async () => {
            for (const status of ["PAID", "FAILED", "CANCELED", "EXPIRED"]) {
                byKey = new Map()
                byId = new Map()
                byMerchant = new Map()
                seed(order({ status }))

                await expect(
                    attachProviderAuthority(db as never, {
                        userId: USER,
                        checkoutIdempotencyKey: KEY,
                        authority: "A1",
                    }),
                ).rejects.toBeInstanceOf(PaymentIdempotencyConflictError)
            }
            expect(db.paymentOrder.updateMany).not.toHaveBeenCalled()
        })

        it("fails closed with PAYMENT_NOT_FOUND when the order does not exist", async () => {
            await expect(
                attachProviderAuthority(db as never, { userId: USER, checkoutIdempotencyKey: KEY, authority: "A1" }),
            ).rejects.toBeInstanceOf(PaymentNotFoundError)
        })

        it("treats a lost race with the same authority as an idempotent success", async () => {
            seed(order())
            db.paymentOrder.findUnique
                .mockImplementationOnce(async () => byId.get("ord_1") ?? null)
                .mockImplementationOnce(async () => order({ providerAuthority: "A1" }))
            db.paymentOrder.updateMany.mockResolvedValue({ count: 0 })

            const result = await attachProviderAuthority(db as never, {
                userId: USER,
                checkoutIdempotencyKey: KEY,
                authority: "A1",
            })

            expect(result.providerAuthority).toBe("A1")
        })

        it("conflicts when a concurrent request attached a different authority", async () => {
            seed(order())
            db.paymentOrder.findUnique
                .mockImplementationOnce(async () => byId.get("ord_1") ?? null)
                .mockImplementationOnce(async () => order({ providerAuthority: "A2" }))
            db.paymentOrder.updateMany.mockResolvedValue({ count: 0 })

            await expect(
                attachProviderAuthority(db as never, {
                    userId: USER,
                    checkoutIdempotencyKey: KEY,
                    authority: "A1",
                }),
            ).rejects.toBeInstanceOf(PaymentIdempotencyConflictError)
        })

        it("surfaces PAYMENT_STATE_UNRESOLVED when the persisted state cannot be confirmed", async () => {
            seed(order())
            db.paymentOrder.findUnique
                .mockImplementationOnce(async () => byId.get("ord_1") ?? null)
                .mockImplementationOnce(async () => null)

            await expect(
                attachProviderAuthority(db as never, {
                    userId: USER,
                    checkoutIdempotencyKey: KEY,
                    authority: "A1",
                }),
            ).rejects.toBeInstanceOf(PaymentStateUnresolvedError)
        })

        it("maps any infrastructure failure to PAYMENT_STATE_UNRESOLVED without raw DB details", async () => {
            db.paymentOrder.findUnique.mockRejectedValue(new Error("db down: relation PaymentOrder"))

            let caught: unknown
            try {
                await attachProviderAuthority(db as never, {
                    userId: USER,
                    checkoutIdempotencyKey: KEY,
                    authority: "A1",
                })
            } catch (error) {
                caught = error
            }

            expect(caught).toBeInstanceOf(PaymentStateUnresolvedError)
            expect((caught as Error).message).not.toContain("relation PaymentOrder")
        })
    })

    // ------------------------------------------------------------ resolveCallbackOrder
    describe("resolveCallbackOrder (untrusted ref + authority binding)", () => {
        it("resolves the order only when both the reference and the authority match", async () => {
            const row = order({ status: "PENDING", providerAuthority: "A1" })
            seed(row)

            await expect(resolveCallbackOrder(db as never, { ref: "mo-1", authority: "A1" })).resolves.toEqual(
                row,
            )
        })

        it("trims both untrusted values before matching", async () => {
            seed(order({ providerAuthority: "A1" }))

            await expect(
                resolveCallbackOrder(db as never, { ref: "  mo-1 ", authority: " A1 " }),
            ).resolves.toMatchObject({ id: "ord_1" })
        })

        it("returns PAYMENT_NOT_FOUND for an unknown reference", async () => {
            await expect(
                resolveCallbackOrder(db as never, { ref: "mo-unknown", authority: "A1" }),
            ).rejects.toBeInstanceOf(PaymentNotFoundError)
        })

        it("returns PAYMENT_NOT_FOUND for an authority mismatch (no IDOR by ref alone)", async () => {
            seed(order({ providerAuthority: "A1" }))

            await expect(
                resolveCallbackOrder(db as never, { ref: "mo-1", authority: "A2" }),
            ).rejects.toBeInstanceOf(PaymentNotFoundError)
        })

        it("returns PAYMENT_NOT_FOUND for missing/blank inputs without touching the database", async () => {
            for (const input of [
                { ref: "", authority: "A1" },
                { ref: "   ", authority: "A1" },
                { ref: "mo-1", authority: "" },
                { ref: "mo-1", authority: "   " },
            ]) {
                await expect(resolveCallbackOrder(db as never, input)).rejects.toBeInstanceOf(
                    PaymentNotFoundError,
                )
            }
            expect(db.paymentOrder.findUnique).not.toHaveBeenCalled()
        })
    })

    // ------------------------------------------------------------ getSubscriptionView
    describe("getSubscriptionView (safe effective subscription view)", () => {
        it("returns the safe view for an active entitlement (ISO dates, no operational identifiers)", async () => {
            db.entitlement.findUnique.mockResolvedValue(entitlementRow())

            const view = await getSubscriptionView(db as never, USER, NOW)

            expect(view).toEqual({
                plan: "PRO",
                entitlement: {
                    status: "ACTIVE",
                    provider: "ZARINPAL",
                    currentPeriodStart: new Date(NOW.getTime() - 10 * DAY).toISOString(),
                    currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY).toISOString(),
                },
                renewal: { available: true, mode: "EXTENDS_CURRENT" },
            })
            expect(Object.keys(view.entitlement ?? {}).sort()).toEqual([
                "currentPeriodEnd",
                "currentPeriodStart",
                "provider",
                "status",
            ])
            expect(JSON.stringify(view)).not.toContain("ent_1")
            expect(JSON.stringify(view)).not.toContain("userId")
            expect(db.entitlement.updateMany).not.toHaveBeenCalled()
            expect(db.user.updateMany).not.toHaveBeenCalled()
        })

        it("returns FREE / null entitlement / NEW_PERIOD when there is no entitlement", async () => {
            db.entitlement.findUnique.mockResolvedValue(null)

            await expect(getSubscriptionView(db as never, USER, NOW)).resolves.toEqual({
                plan: "FREE",
                entitlement: null,
                renewal: { available: true, mode: "NEW_PERIOD" },
            })
        })

        it("materializes expiry through the entitlement service and reports FREE / NEW_PERIOD", async () => {
            db.entitlement.findUnique
                .mockResolvedValueOnce(entitlementRow({ currentPeriodEnd: new Date(NOW.getTime() - DAY) }))
                .mockResolvedValueOnce(
                    entitlementRow({ status: "EXPIRED", currentPeriodEnd: new Date(NOW.getTime() - DAY) }),
                )

            const view = await getSubscriptionView(db as never, USER, NOW)

            expect(view.plan).toBe("FREE")
            expect(view.entitlement?.status).toBe("EXPIRED")
            expect(view.renewal).toEqual({ available: true, mode: "NEW_PERIOD" })
            expect(db.entitlement.updateMany).toHaveBeenCalledTimes(1)
            expect(db.user.updateMany).toHaveBeenCalledWith({ where: { id: USER }, data: { plan: "FREE" } })
        })

        it("reports FREE / NEW_PERIOD for a stored EXPIRED row", async () => {
            db.entitlement.findUnique.mockResolvedValue(
                entitlementRow({ status: "EXPIRED", currentPeriodEnd: new Date(NOW.getTime() - DAY) }),
            )

            const view = await getSubscriptionView(db as never, USER, NOW)

            expect(view.plan).toBe("FREE")
            expect(view.renewal.mode).toBe("NEW_PERIOD")
        })
    })

    // ------------------------------------------------------------ finalizeVerifiedPayment
    describe("finalizeVerifiedPayment (single finalization owner)", () => {
        const VERIFIED = { reference: "REF-1", amount: AMOUNT }

        beforeEach(() => {
            seed(order({ providerAuthority: "A1" }))
        })

        it("fails with PAYMENT_NOT_FOUND when no order matches the authority", async () => {
            await expect(
                finalizeVerifiedPayment(db as never, { authority: "A-unknown", verification: VERIFIED }, NOW),
            ).rejects.toBeInstanceOf(PaymentNotFoundError)
        })

        it("keeps a duplicate PAID callback an idempotent no-op (no mutation, no second entitlement)", async () => {
            byAuthority.set("A1", order({ status: "PAID", providerAuthority: "A1", paidAt: NOW, entitlementId: "ent_1" }))
            db.entitlement.findUnique.mockResolvedValue(entitlementRow())

            const result = await finalizeVerifiedPayment(
                db as never,
                { authority: "A1", verification: VERIFIED },
                NOW,
            )

            expect(result.finalized).toBe(false)
            expect(result.entitlementAction).toBeNull()
            expect(result.order.status).toBe("PAID")
            expect(db.paymentOrder.updateMany).not.toHaveBeenCalled()
            expect(db.entitlement.create).not.toHaveBeenCalled()
            expect(db.entitlement.updateMany).not.toHaveBeenCalled()
            expect(db.user.updateMany).not.toHaveBeenCalled()
        })

        it("refuses to finalize a terminal non-PAID order (never revived)", async () => {
            for (const status of ["FAILED", "EXPIRED", "CANCELED"]) {
                byAuthority.set("A1", order({ status, providerAuthority: "A1" }))

                await expect(
                    finalizeVerifiedPayment(db as never, { authority: "A1", verification: VERIFIED }, NOW),
                ).rejects.toBeInstanceOf(PaymentVerificationFailedError)
            }
            expect(db.paymentOrder.updateMany).not.toHaveBeenCalled()
        })

        it("rejects an amount mismatch without any mutation (exact amount verification)", async () => {
            await expect(
                finalizeVerifiedPayment(
                    db as never,
                    { authority: "A1", verification: { reference: "REF-1", amount: AMOUNT + 1 } },
                    NOW,
                ),
            ).rejects.toBeInstanceOf(PaymentInvalidAmountError)
            expect(db.paymentOrder.updateMany).not.toHaveBeenCalled()
        })

        it("treats a null verified amount as 'not reportable' (not a mismatch)", async () => {
            db.paymentOrder.update.mockResolvedValue(order({ status: "PAID", entitlementId: "ent_1" }))

            const result = await finalizeVerifiedPayment(
                db as never,
                { authority: "A1", verification: { reference: null, amount: null } },
                NOW,
            )

            expect(result.finalized).toBe(true)
            const claimData = db.paymentOrder.updateMany.mock.calls[0][0].data
            expect(claimData.status).toBe("PAID")
            expect("providerReference" in claimData).toBe(false)
        })

        it("finalizes a first purchase: conditional claim → entitlement → link (ACTIVATED)", async () => {
            db.paymentOrder.update.mockResolvedValue(
                order({ status: "PAID", paidAt: NOW, providerReference: "REF-1", entitlementId: "ent_1" }),
            )

            const result = await finalizeVerifiedPayment(
                db as never,
                { authority: "A1", verification: VERIFIED },
                NOW,
            )

            expect(db.paymentOrder.updateMany).toHaveBeenCalledWith({
                where: { id: "ord_1", status: "PENDING" },
                data: { status: "PAID", paidAt: NOW, providerReference: "REF-1" },
            })
            // entitlement داخل همان تراکنش و از snapshot سفارش
            const entitlementData = db.entitlement.create.mock.calls[0][0].data
            expect(entitlementData).toMatchObject({
                userId: USER,
                provider: "ZARINPAL",
                status: "ACTIVE",
                planCode: "PRO",
                currentPeriodStart: NOW,
                currentPeriodEnd: new Date(NOW.getTime() + DAYS * DAY),
            })
            expect(db.user.updateMany).toHaveBeenCalledWith({ where: { id: USER }, data: { plan: "PRO" } })
            expect(db.paymentOrder.update).toHaveBeenCalledWith(
                expect.objectContaining({ where: { id: "ord_1" }, data: { entitlementId: "ent_1" } }),
            )
            expect(result).toMatchObject({ finalized: true, entitlementAction: "ACTIVATED" })
            expect(result.order.status).toBe("PAID")
        })

        it("extends an active period and reports the RENEWED action", async () => {
            const active = entitlementRow()
            db.entitlement.findUnique.mockResolvedValue(active)
            db.paymentOrder.update.mockResolvedValue(order({ status: "PAID", entitlementId: "ent_1" }))

            const result = await finalizeVerifiedPayment(
                db as never,
                { authority: "A1", verification: VERIFIED },
                NOW,
            )

            expect(db.entitlement.create).not.toHaveBeenCalled()
            expect(db.entitlement.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        userId: USER,
                        status: "ACTIVE",
                        currentPeriodStart: active.currentPeriodStart,
                        currentPeriodEnd: active.currentPeriodEnd,
                    },
                    data: expect.objectContaining({
                        currentPeriodStart: active.currentPeriodStart,
                        currentPeriodEnd: new Date(active.currentPeriodEnd.getTime() + DAYS * DAY),
                    }),
                }),
            )
            expect(result.entitlementAction).toBe("RENEWED")
        })

        it("treats a lost claim that landed PAID as an idempotent success (no second entitlement)", async () => {
            // باخت در claim → re-read نشان می‌دهد درخواست دیگری برنده شده است
            db.paymentOrder.updateMany.mockResolvedValue({ count: 0 })
            db.paymentOrder.findUnique.mockResolvedValueOnce(
                order({ status: "PAID", entitlementId: "ent_1" }),
            )
            db.entitlement.findUnique.mockResolvedValue(entitlementRow())

            const result = await finalizeVerifiedPayment(
                db as never,
                { authority: "A1", verification: VERIFIED },
                NOW,
            )

            expect(result.finalized).toBe(false)
            expect(result.entitlementAction).toBeNull()
            expect(db.entitlement.create).not.toHaveBeenCalled()
            expect(db.entitlement.updateMany).not.toHaveBeenCalled()
        })

        it("fails verification when a lost claim did not end up PAID", async () => {
            db.paymentOrder.updateMany.mockResolvedValue({ count: 0 })
            db.paymentOrder.findUnique.mockResolvedValueOnce(order({ status: "PENDING" }))

            await expect(
                finalizeVerifiedPayment(db as never, { authority: "A1", verification: VERIFIED }, NOW),
            ).rejects.toBeInstanceOf(PaymentVerificationFailedError)
        })

        it("lets an entitlement invariant failure abort the whole finalization (rollback, no fake success)", async () => {
            db.entitlement.findUnique.mockRejectedValue(new Error("db down"))

            await expect(
                finalizeVerifiedPayment(db as never, { authority: "A1", verification: VERIFIED }, NOW),
            ).rejects.toThrow()
            // هیچ link/entitlement موفقی ساخته نمی‌شود
            expect(db.paymentOrder.update).not.toHaveBeenCalled()
        })
    })

    // ------------------------------------------------------------ quota isolation
    describe("billing never touches AI quota", () => {
        it("no billing operation reads or writes the quota models (§35 AI quota independence)", async () => {
            seed(order({ providerAuthority: "A1" }))
            db.paymentOrder.update.mockResolvedValue(order({ status: "PAID" }))

            await prepareCheckout(db as never, { userId: USER, checkoutIdempotencyKey: KEY, orderTtlMs: TTL }, NOW)
            await attachProviderAuthority(db as never, {
                userId: USER,
                checkoutIdempotencyKey: KEY,
                authority: "A1",
            })
            await finalizeVerifiedPayment(
                db as never,
                { authority: "A1", verification: { reference: "REF-1", amount: AMOUNT } },
                NOW,
            )
            await getSubscriptionView(db as never, USER, NOW)

            expect(db.aiUsage.findUnique).not.toHaveBeenCalled()
            expect(db.aiUsageEvent.findMany).not.toHaveBeenCalled()
        })
    })
})
