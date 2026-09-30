import { describe, it, expect } from "vitest"

import {
    generateTemporaryPassword,
    isTemporaryPasswordShape,
    TEMPORARY_PASSWORD_LENGTH,
} from "@/lib/temporaryPassword"

describe("generateTemporaryPassword", () => {
    it("طول ثابت ۱۲ کاراکتر دارد", () => {
        for (let i = 0; i < 50; i++) {
            expect(generateTemporaryPassword()).toHaveLength(TEMPORARY_PASSWORD_LENGTH)
        }
        expect(TEMPORARY_PASSWORD_LENGTH).toBe(12)
    })

    it("دو نویسهٔ سمبول تضمین‌شده دارد", () => {
        for (let i = 0; i < 50; i++) {
            const symbols = generateTemporaryPassword().split("").filter((c) => "!@#$%^&*?".includes(c))
            expect(symbols).toHaveLength(2)
        }
    })

    it("هیچ نویسهٔ مبهمی ندارد (0/O و 1/l/I حذف شده‌اند)", () => {
        for (let i = 0; i < 200; i++) {
            const password = generateTemporaryPassword()
            expect(password).not.toMatch(/[01OIli]/)
        }
    })

    it("تصادفی است — دو رمز پشت‌سرهم یکی نمی‌شوند", () => {
        const seen = new Set<string>()
        for (let i = 0; i < 200; i++) seen.add(generateTemporaryPassword())
        expect(seen.size).toBe(200)
    })

    it("همیشه شکل معتبر دارد", () => {
        expect(isTemporaryPasswordShape(generateTemporaryPassword())).toBe(true)
        expect(isTemporaryPasswordShape("short")).toBe(false)
    })
})
