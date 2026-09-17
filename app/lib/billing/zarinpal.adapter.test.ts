// فاز ۵ — گام ۱۷: unit test های adapter زرین‌پال (سند §35: «provider callback parsing»،
// «provider result normalization»، «safe provider error normalization»)
//
// قراردادها:
// - تنها نقطه‌ی تماس خارجی `fetch` است که این‌جا کاملاً mock می‌شود؛ هیچ درخواست شبکه‌ای واقعی
//   و هیچ secret واقعی وجود ندارد (env با مقادیر تستیِ صریح ست و در پایان restore می‌شود).
// - assertion ها روی «رفتار نرمال‌شده» هستند: هیچ raw provider payload/merchant/callback در
//   خطاها یا نتیجه‌ها نباید درز کند.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BILLING_ENV } from "./config"
import { PaymentProviderError } from "./provider"
import { buildRedirectUrl, zarinpalProvider } from "./zarinpal.adapter"

const MERCHANT = "merchant-id-for-tests"
const BASE_URL = "https://sandbox.zarinpal.com/pg"
const CALLBACK_URL = "https://app.example.com/api/billing/callback/zarinpal?ref=mo-1"

const TEST_ENV: Record<string, string> = {
    [BILLING_ENV.proAmount]: "100000",
    [BILLING_ENV.proCurrency]: "IRR",
    [BILLING_ENV.proEntitlementDays]: "30",
    [BILLING_ENV.merchantId]: MERCHANT,
    [BILLING_ENV.mode]: "sandbox",
    [BILLING_ENV.baseUrl]: BASE_URL,
    [BILLING_ENV.callbackUrl]: "https://app.example.com/api/billing/callback/zarinpal",
    [BILLING_ENV.zarinpalDescription]: "DailyPilot PRO",
    [BILLING_ENV.providerTimeoutMs]: "6000",
    [BILLING_ENV.orderTtlMs]: "1800000",
    [BILLING_ENV.resultUrlSuccess]: "https://app.example.com/billing/result?state=success",
    [BILLING_ENV.resultUrlFailure]: "https://app.example.com/billing/result?state=failure",
}

const ENV_KEYS = Object.values(BILLING_ENV)

let originalEnv: Record<string, string | undefined> = {}
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(body: unknown): Response {
    return { text: async () => JSON.stringify(body) } as unknown as Response
}

function rawResponse(raw: string): Response {
    return { text: async () => raw } as unknown as Response
}

/** body ارسال‌شده به provider در آخرین فراخوانی fetch. */
function lastRequestBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls.at(-1)?.[1] as { body: string }
    return JSON.parse(init.body) as Record<string, unknown>
}

function lastRequestUrl(): string {
    return String(fetchMock.mock.calls.at(-1)?.[0])
}

const CREATE_INPUT = {
    merchantOrderId: "mo-1",
    amount: 100000,
    currency: "IRR",
    callbackUrl: CALLBACK_URL,
    description: "DailyPilot PRO",
}

describe("zarinpal adapter", () => {
    beforeEach(() => {
        originalEnv = {}
        for (const key of ENV_KEYS) {
            originalEnv[key] = process.env[key]
            delete process.env[key]
        }
        for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value

        fetchMock = vi.fn()
        vi.stubGlobal("fetch", fetchMock)
    })

    afterEach(() => {
        for (const key of ENV_KEYS) {
            const value = originalEnv[key]
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    // ---------------------------------------------------------------- parseCallback
    describe("parseCallback (untrusted browser params → normalized)", () => {
        it("maps only the two documented statuses (exact, case-sensitive)", () => {
            expect(zarinpalProvider.parseCallback({ authority: "A1", status: "OK" })).toEqual({
                authority: "A1",
                status: "SUCCESS",
            })
            expect(zarinpalProvider.parseCallback({ authority: "A1", status: "NOK" })).toEqual({
                authority: "A1",
                status: "FAILURE",
            })
        })

        it("normalizes anything unrecognized to UNKNOWN (Status alone is never authoritative)", () => {
            for (const status of ["ok", "nok", "SUCCESS", "FAIL", "", "  ", null, undefined, "1"]) {
                expect(zarinpalProvider.parseCallback({ authority: "A1", status }).status).toBe(
                    "UNKNOWN",
                )
            }
        })

        it("trims the authority and tolerates missing/non-string input", () => {
            expect(zarinpalProvider.parseCallback({ authority: "  A1  ", status: "OK" }).authority).toBe(
                "A1",
            )
            expect(zarinpalProvider.parseCallback({}).authority).toBe("")
            expect(zarinpalProvider.parseCallback({ authority: null }).authority).toBe("")
            expect(
                zarinpalProvider.parseCallback({ authority: 42 as unknown as string }).authority,
            ).toBe("")
        })

        it("keeps only authority + status (no extra callback params leak into the result)", () => {
            const parsed = zarinpalProvider.parseCallback({
                authority: "A1",
                status: "OK",
                ...({ ref: "mo-1", extra: "x" } as Record<string, string>),
            })

            expect(Object.keys(parsed).sort()).toEqual(["authority", "status"])
        })
    })

    // ---------------------------------------------------------------- buildRedirectUrl
    describe("buildRedirectUrl (server-controlled payment page)", () => {
        it("uses the sandbox host in sandbox mode and production host in production mode", () => {
            expect(buildRedirectUrl("A1")).toBe("https://sandbox.zarinpal.com/pg/StartPay/A1")

            process.env[BILLING_ENV.mode] = "production"
            expect(buildRedirectUrl("A1")).toBe("https://payment.zarinpal.com/pg/StartPay/A1")
        })

        it("encodes the authority so it cannot inject a path/query/host", () => {
            const authority = "A/../evil?a=1&b=2#frag"
            const url = buildRedirectUrl(authority)

            expect(url.startsWith("https://sandbox.zarinpal.com/pg/StartPay/")).toBe(true)
            expect(url.slice("https://sandbox.zarinpal.com/pg/StartPay/".length)).toBe(
                encodeURIComponent(authority),
            )
            expect(url).not.toContain(authority)
        })
    })

    // ---------------------------------------------------------------- createPayment
    describe("createPayment", () => {
        it("posts to the configured v4 endpoint with server-side values and the supplied callback URL", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ data: { code: 100, authority: "A1" } }))

            const result = await zarinpalProvider.createPayment(CREATE_INPUT)

            expect(lastRequestUrl()).toBe(`${BASE_URL}/pg/v4/payment/request.json`)
            expect(lastRequestBody()).toEqual({
                merchant_id: MERCHANT,
                amount: 100000,
                currency: "IRR",
                description: "DailyPilot PRO",
                callback_url: CALLBACK_URL,
            })
            // redirect از همان authority ذخیره‌شده ساخته می‌شود (helper مشترک)
            expect(result).toEqual({
                authority: "A1",
                redirectUrl: "https://sandbox.zarinpal.com/pg/StartPay/A1",
            })
        })

        it("never substitutes the globally configured callback URL for the per-order one", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ data: { code: 100, authority: "A1" } }))

            await zarinpalProvider.createPayment({ ...CREATE_INPUT, callbackUrl: "https://x.test/cb" })

            expect(lastRequestBody().callback_url).toBe("https://x.test/cb")
            expect(lastRequestBody().callback_url).not.toBe(TEST_ENV[BILLING_ENV.callbackUrl])
        })

        it("maps a non-100 provider code to REJECTED (definitive)", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ data: { code: -9, authority: "A1" } }))

            await expect(zarinpalProvider.createPayment(CREATE_INPUT)).rejects.toMatchObject({
                kind: "REJECTED",
                retryable: false,
            })
        })

        it("maps the provider's transient -12 (too many attempts) to UNAVAILABLE", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ data: { code: -12 } }))

            await expect(zarinpalProvider.createPayment(CREATE_INPUT)).rejects.toMatchObject({
                kind: "UNAVAILABLE",
                retryable: true,
            })
        })

        it("rejects a successful code without a usable authority as INVALID_RESPONSE", async () => {
            for (const body of [
                { data: { code: 100 } },
                { data: { code: 100, authority: "   " } },
                { data: { code: 100, authority: 123 } },
                { code: 100, authority: "A1" },
                {},
            ]) {
                fetchMock.mockResolvedValue(jsonResponse(body))

                await expect(zarinpalProvider.createPayment(CREATE_INPUT)).rejects.toMatchObject({
                    kind: "INVALID_RESPONSE",
                    retryable: false,
                })
            }
        })

        it("rejects a non-JSON provider body as INVALID_RESPONSE", async () => {
            fetchMock.mockResolvedValue(rawResponse("<html>gateway</html>"))

            await expect(zarinpalProvider.createPayment(CREATE_INPUT)).rejects.toMatchObject({
                kind: "INVALID_RESPONSE",
            })
        })

        it("maps network failure / timeout to UNAVAILABLE (ambiguous, never blindly retried)", async () => {
            fetchMock.mockRejectedValue(new Error("ECONNRESET"))

            await expect(zarinpalProvider.createPayment(CREATE_INPUT)).rejects.toMatchObject({
                kind: "UNAVAILABLE",
                retryable: true,
            })
        })

        it("aborts the request when the configured timeout elapses → UNAVAILABLE", async () => {
            vi.useFakeTimers()
            fetchMock.mockImplementation((_url: unknown, init: { signal: AbortSignal }) => {
                return new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(new Error("aborted")))
                })
            })

            const pending = zarinpalProvider.createPayment(CREATE_INPUT)
            const expectation = expect(pending).rejects.toMatchObject({ kind: "UNAVAILABLE" })
            await vi.advanceTimersByTimeAsync(6000)

            await expectation
        })

        it("rejects a non-IRR currency before any provider call", async () => {
            await expect(
                zarinpalProvider.createPayment({ ...CREATE_INPUT, currency: "IRT" }),
            ).rejects.toMatchObject({ kind: "REJECTED", retryable: false })
            expect(fetchMock).not.toHaveBeenCalled()
        })

        it("rejects a missing/blank description or callback URL before any provider call", async () => {
            await expect(
                zarinpalProvider.createPayment({ ...CREATE_INPUT, description: "   " }),
            ).rejects.toMatchObject({ kind: "REJECTED" })
            await expect(
                zarinpalProvider.createPayment({ ...CREATE_INPUT, callbackUrl: "" }),
            ).rejects.toMatchObject({ kind: "REJECTED" })
            expect(fetchMock).not.toHaveBeenCalled()
        })
    })

    // ---------------------------------------------------------------- verifyPayment
    describe("verifyPayment", () => {
        it("returns the provider reference and verified amount for code 100", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ data: { code: 100, ref_id: 123456789, amount: 100000 } }))

            await expect(
                zarinpalProvider.verifyPayment({ authority: "A1", amount: 100000 }),
            ).resolves.toEqual({ reference: "123456789", amount: 100000 })

            expect(lastRequestUrl()).toBe(`${BASE_URL}/pg/v4/payment/verify.json`)
            // amount ذخیره‌شده‌ی دامنه ارسال می‌شود (بدون conversion)
            expect(lastRequestBody()).toEqual({
                merchant_id: MERCHANT,
                amount: 100000,
                authority: "A1",
            })
        })

        it("treats code 101 (already verified) as success with reference null — never a fabricated value", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ data: { code: 101 } }))

            await expect(
                zarinpalProvider.verifyPayment({ authority: "A1", amount: 100000 }),
            ).resolves.toEqual({ reference: null, amount: null })
        })

        it("never falls back to the requested amount when the provider omits it", async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ data: { code: 100, ref_id: 5, amount: "100000" } }),
            )

            await expect(
                zarinpalProvider.verifyPayment({ authority: "A1", amount: 100000 }),
            ).resolves.toEqual({ reference: "5", amount: null })
        })

        it("rejects code 100 without a usable reference as INVALID_RESPONSE", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ data: { code: 100 } }))

            await expect(
                zarinpalProvider.verifyPayment({ authority: "A1", amount: 100000 }),
            ).rejects.toMatchObject({ kind: "INVALID_RESPONSE" })
        })

        it("maps definitive rejection codes to REJECTED", async () => {
            for (const code of [-50, -51, -53, -54, -55, -100, 99]) {
                fetchMock.mockResolvedValue(jsonResponse({ data: { code } }))

                await expect(
                    zarinpalProvider.verifyPayment({ authority: "A1", amount: 100000 }),
                ).rejects.toMatchObject({ kind: "REJECTED", retryable: false })
            }
        })

        it("maps the unexpected provider code -52 to UNAVAILABLE (order stays PENDING)", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ data: { code: -52 } }))

            await expect(
                zarinpalProvider.verifyPayment({ authority: "A1", amount: 100000 }),
            ).rejects.toMatchObject({ kind: "UNAVAILABLE", retryable: true })
        })

        it("maps malformed/absent provider bodies to INVALID_RESPONSE", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ errors: { authority: ["-54"] } }))

            await expect(
                zarinpalProvider.verifyPayment({ authority: "A1", amount: 100000 }),
            ).rejects.toMatchObject({ kind: "INVALID_RESPONSE" })
        })
    })

    // ---------------------------------------------------------------- inquirePayment
    describe("inquirePayment (reconciliation only)", () => {
        it("normalizes the documented provider statuses", async () => {
            const cases: Array<[string, string]> = [
                ["VERIFIED", "PAID"],
                ["PAID", "PENDING"],
                ["IN_BANK", "PENDING"],
                ["FAILED", "FAILED"],
                ["REVERSED", "FAILED"],
                ["SOMETHING_ELSE", "UNKNOWN"],
            ]

            for (const [providerStatus, expected] of cases) {
                fetchMock.mockResolvedValue(jsonResponse({ data: { code: 100, status: providerStatus } }))

                await expect(
                    zarinpalProvider.inquirePayment({ authority: "A1" }),
                ).resolves.toEqual({ status: expected, reference: null, amount: null })
            }

            expect(lastRequestUrl()).toBe(`${BASE_URL}/pg/v4/payment/inquiry.json`)
        })

        it("maps a documented error shape to REJECTED and anything unusable to INVALID_RESPONSE", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ errors: { authority: ["-54"] } }))
            await expect(zarinpalProvider.inquirePayment({ authority: "A1" })).rejects.toMatchObject({
                kind: "REJECTED",
            })

            fetchMock.mockResolvedValue(jsonResponse({ data: { code: 100 } }))
            await expect(zarinpalProvider.inquirePayment({ authority: "A1" })).rejects.toMatchObject({
                kind: "INVALID_RESPONSE",
            })
        })
    })

    // ---------------------------------------------------------------- error normalization
    describe("safe provider error normalization (§33 — no raw data in errors)", () => {
        it("keeps provider failure messages free of merchant id, authority, callback URL and raw body", async () => {
            const failureCases: Array<() => Promise<unknown>> = [
                () => {
                    fetchMock.mockResolvedValue(jsonResponse({ data: { code: -9 } }))
                    return zarinpalProvider.createPayment(CREATE_INPUT)
                },
                () => {
                    fetchMock.mockResolvedValue(rawResponse("<html>merchant leak</html>"))
                    return zarinpalProvider.createPayment(CREATE_INPUT)
                },
                () => {
                    fetchMock.mockRejectedValue(new Error("merchant leak in network error"))
                    return zarinpalProvider.verifyPayment({ authority: "A/secret", amount: 100000 })
                },
            ]

            for (const run of failureCases) {
                let caught: unknown
                try {
                    await run()
                } catch (error) {
                    caught = error
                }

                expect(caught).toBeInstanceOf(PaymentProviderError)
                const message = (caught as Error).message
                expect(message).not.toContain(MERCHANT)
                expect(message).not.toContain("A/secret")
                expect(message).not.toContain(CALLBACK_URL)
                expect(message).not.toContain("merchant leak")
                expect(message).not.toContain(BASE_URL)
            }
        })

        it("only UNAVAILABLE is retryable", () => {
            expect(new PaymentProviderError("UNAVAILABLE", "x").retryable).toBe(true)
            expect(new PaymentProviderError("REJECTED", "x").retryable).toBe(false)
            expect(new PaymentProviderError("INVALID_RESPONSE", "x").retryable).toBe(false)
        })

        it("exposes the provider id required for order/provider matching", () => {
            expect(zarinpalProvider.id).toBe("ZARINPAL")
        })
    })
})
