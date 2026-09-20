import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Route test: GET /api/debug/env                                       */
/*                                                                      */
/* این مسیر تشخیصی است، پس دو چیز باید اثبات شود:                        */
/* ۱. fail-closed بودن دروازه: production بدون توکن → 404،              */
/*    توکن غلط → 403، توکن صحیح → 200.                                  */
/* ۲. پاسخ، metadata غیرحساس بدهد و هرگز مقدار کامل کلید را افشا نکند.   */
/* ------------------------------------------------------------------ */

import { GET } from "./route"

const KEY = "re_live_placeholder_secret_0123456789"
const TOKEN = "debug-token-xyz"

/** IP یکتا برای هر تست → bucketهای rate-limit درون‌حافظه‌ای بین تست‌ها تداخل نکنند. */
let ipCounter = 0
const nextIp = () => `10.0.0.${++ipCounter}`

const callGET = (opts: { token?: string; viaHeader?: boolean; ip?: string } = {}) => {
    const url = new URL("http://localhost/api/debug/env")
    if (opts.token !== undefined && opts.viaHeader !== true) {
        url.searchParams.set("token", opts.token)
    }
    return GET(
        new NextRequest(url, {
            method: "GET",
            headers: {
                "x-forwarded-for": opts.ip ?? nextIp(),
                ...(opts.token !== undefined && opts.viaHeader === true
                    ? { "x-debug-token": opts.token }
                    : {}),
            },
        }),
    )
}

type Envelope = {
    ok: boolean
    data?: {
        environment: { nodeEnv: string | null; vercelEnv: string | null; commitSha: string | null }
        resend: {
            hasKey: boolean
            keyPrefix: string | null
            length: number
            startsWithResendPrefix: boolean
            hadSurroundingWhitespace: boolean
            fromAddress: string
            senderIsSandbox: boolean
            fromEmailConfigured: boolean
        }
        debug: { tokenConfigured: boolean }
    }
    error?: { code: string }
}

const readBody = async (response: Response): Promise<Envelope> =>
    (await response.json()) as Envelope

describe("GET /api/debug/env", () => {
    beforeEach(() => {
        vi.stubEnv("RESEND_API_KEY", KEY)
        vi.stubEnv("RESEND_FROM_EMAIL", "")
        vi.stubEnv("DEBUG_ENV_TOKEN", "")
        vi.spyOn(console, "warn").mockImplementation(() => {})
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        vi.restoreAllMocks()
    })

    it("does not exist in production when no debug token is configured (fail-closed)", async () => {
        vi.stubEnv("NODE_ENV", "production")

        const response = await callGET()

        expect(response.status).toBe(404)
        const body = await readBody(response)
        expect(body.ok).toBe(false)
        expect(body.error?.code).toBe("NOT_FOUND")
        // هیچ metadata‌ای با نبود توکن بیرون نمی‌رود
        expect(JSON.stringify(body)).not.toContain(KEY)
    })

    it("rejects a missing or wrong token when the token IS configured", async () => {
        vi.stubEnv("NODE_ENV", "production")
        vi.stubEnv("DEBUG_ENV_TOKEN", TOKEN)

        const missing = await callGET()
        const wrong = await callGET({ token: "not-the-token", viaHeader: true })

        expect(missing.status).toBe(403)
        expect(wrong.status).toBe(403)
        expect((await readBody(wrong)).error?.code).toBe("FORBIDDEN")
    })

    it("returns non-secret diagnostics for the correct token — without ever exposing the key", async () => {
        vi.stubEnv("NODE_ENV", "production")
        vi.stubEnv("DEBUG_ENV_TOKEN", TOKEN)

        const response = await callGET({ token: TOKEN, viaHeader: true })

        expect(response.status).toBe(200)
        expect(response.headers.get("X-Request-ID")).toBeTruthy()

        const body = await readBody(response)
        expect(body.ok).toBe(true)
        expect(body.data?.resend.hasKey).toBe(true)
        expect(body.data?.resend.keyPrefix).toBe("re_l")
        expect(body.data?.resend.length).toBe(KEY.length)
        expect(body.data?.resend.startsWithResendPrefix).toBe(true)
        expect(body.data?.resend.hadSurroundingWhitespace).toBe(false)
        expect(body.data?.resend.senderIsSandbox).toBe(true)
        expect(body.data?.resend.fromEmailConfigured).toBe(false)
        expect(body.data?.environment.nodeEnv).toBe("production")
        expect(body.data?.debug.tokenConfigured).toBe(true)

        // تضمین اصلی: مقدار کامل کلید هرگز در پاسخ نیست
        expect(JSON.stringify(body)).not.toContain(KEY)
    })

    it("flags a whitespace-corrupted key value without leaking it", async () => {
        vi.stubEnv("DEBUG_ENV_TOKEN", TOKEN)
        vi.stubEnv("RESEND_API_KEY", ` ${KEY}\n`)

        const response = await callGET({ token: TOKEN, viaHeader: true })
        const body = await readBody(response)

        expect(body.data?.resend.hasKey).toBe(true)
        expect(body.data?.resend.hadSurroundingWhitespace).toBe(true)
        expect(body.data?.resend.length).toBe(KEY.length)
        expect(JSON.stringify(body)).not.toContain(KEY)
    })

    it("reports an absent key as absent instead of pretending it is valid", async () => {
        vi.stubEnv("DEBUG_ENV_TOKEN", TOKEN)
        vi.stubEnv("RESEND_API_KEY", "   ")

        const response = await callGET({ token: TOKEN, viaHeader: true })
        const body = await readBody(response)

        expect(body.data?.resend.hasKey).toBe(false)
        expect(body.data?.resend.keyPrefix).toBeNull()
        expect(body.data?.resend.length).toBe(0)
        expect(body.data?.resend.startsWithResendPrefix).toBe(false)
    })

    it("is reachable without a token outside production (local diagnosis) and rate-limits attempts", async () => {
        // NODE_ENV پیش‌فرض vitest = test ⇒ مسیر باز است (جایگزین اول درخواست کاربر)
        const open = await callGET()
        expect(open.status).toBe(200)
        expect((await readBody(open)).data?.debug.tokenConfigured).toBe(false)

        // brute-force روی همین IP باید محدود شود (سقف ۱۰ تلاش)
        const ip = nextIp()
        const statuses: number[] = []
        for (let attempt = 0; attempt < 11; attempt += 1) {
            statuses.push((await callGET({ ip })).status)
        }
        expect(statuses.slice(0, 10)).not.toContain(429)
        expect(statuses[10]).toBe(429)
    })
})
