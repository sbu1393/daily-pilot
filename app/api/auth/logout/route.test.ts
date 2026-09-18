import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: POST /api/auth/logout (ADR-04).              */
/* No auth/service dependencies — pure cookie-clearing handler.        */
/* ------------------------------------------------------------------ */

import { POST } from "./route"

describe("POST /api/auth/logout — X-Request-ID (فاز صفر §7)", () => {
    it("success response carries a server-generated X-Request-ID", async () => {
        const res = await POST()

        expect(res.status).toBe(200)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})

describe("POST /api/auth/logout", () => {
    it("returns 200 with { ok: true, message } and clears the token cookie", async () => {
        const res = await POST()

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, message: "خروج انجام شد" })

        const token = res.cookies.get("token")
        expect(token?.value).toBe("")
        expect(token?.maxAge).toBe(0)
        expect(token?.httpOnly).toBe(true)
        expect(token?.path).toBe("/")
    })
})