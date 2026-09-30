import { describe, it, expect } from "vitest"

import {
    generateTemporaryPassword,
    isTemporaryPasswordShape,
    TEMPORARY_PASSWORD_LENGTH,
} from "@/lib/temporaryPassword"

/* رمز موقت — الفبا-عددیِ خوانا، بدون نویسهٔ سمبول و بدون نویسهٔ مبهم. */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
const SPECIAL = " !@#$%^&*()_+-=[]{}|;:',.<>/?`~\"'\\"

describe("generateTemporaryPassword", () => {
    it("طول ثابت ۱۲ کاراکتر دارد (کوتاه نشده تا آنتروپی حفظ شود)", () => {
        for (let i = 0; i < 50; i++) {
            expect(generateTemporaryPassword()).toHaveLength(TEMPORARY_PASSWORD_LENGTH)
        }
        expect(TEMPORARY_PASSWORD_LENGTH).toBe(12)
    })

    it("هیچ نویسهٔ special تولید نمی‌کند", () => {
        for (let i = 0; i < 500; i++) {
            const password = generateTemporaryPassword()
            for (const char of password) {
                expect(SPECIAL).not.toContain(char)
            }
            expect(password).toMatch(/^[A-Za-z0-9]+$/)
        }
    })

    it("هیچ نویسهٔ مبهمی ندارد (0/O/o و 1/l/I/i حذف شده‌اند)", () => {
        for (let i = 0; i < 500; i++) {
            const password = generateTemporaryPassword()
            expect(password).not.toMatch(/[01OIli o]/)
            for (const char of password) {
                expect(ALPHABET).toContain(char)
            }
        }
    })

    it("فقط از الفبای مجاز الفبا-عددی استفاده می‌کند", () => {
        for (let i = 0; i < 200; i++) {
            for (const char of generateTemporaryPassword()) {
                expect(ALPHABET.includes(char)).toBe(true)
            }
        }
    })

    it("الفبا به‌اندازهٔ کافی بزرگ است تا آنتروپی از نسخهٔ نمادمحور قبلی کمتر نشود", () => {
        // ۱۲ کاراکتر از ۵۵ نماد ⇒ 12 × log2(55) ≈ ۶۹٫۴ بیت
        // نسخهٔ قبلی: ۱۰ از ۵۴ نماد + ۲ سمبول از ۸ گزینه ⇒ ≈ ۶۳٫۶ بیت
        expect(ALPHABET.length).toBe(55)
        expect(new Set(ALPHABET).size).toBe(55)

        const bits = TEMPORARY_PASSWORD_LENGTH * Math.log2(ALPHABET.length)
        const previousBits = 10 * Math.log2(54) + 2 * Math.log2(8)
        expect(bits).toBeGreaterThan(previousBits)
        expect(bits).toBeGreaterThan(69)
    })

    it("تصادفی است — رمزهای پشت‌سرهم یکی نمی‌شوند", () => {
        const seen = new Set<string>()
        for (let i = 0; i < 500; i++) seen.add(generateTemporaryPassword())
        expect(seen.size).toBe(500)
    })

    it("توزیع نمادها یکنواخت است — هر ۵۵ نماد در طول زمان ظاهر می‌شود", () => {
        const counts = new Map<string, number>()
        const rounds = 2000
        for (let i = 0; i < rounds; i++) {
            for (const char of generateTemporaryPassword()) {
                counts.set(char, (counts.get(char) ?? 0) + 1)
            }
        }
        expect(counts.size).toBe(ALPHABET.length)

        const total = rounds * TEMPORARY_PASSWORD_LENGTH
        const expected = total / ALPHABET.length
        for (const [char, count] of counts) {
            // آستانهٔ سخاوتمندانه: با این حجم نمونه، انحراف چند برابری خطا نیست،
            // ولی یک نمادِ حذف‌شده یا یک نمادِ بسیار کم‌تعداد لو می‌رود.
            expect(count, `نماد ${char} بیش از حد کم‌تعداد است`).toBeGreaterThan(expected * 0.5)
            expect(count, `نماد ${char} بیش از حد پرتعداد است`).toBeLessThan(expected * 1.6)
        }
    })
})

describe("isTemporaryPasswordShape", () => {
    it("رمز تولیدشده همیشه شکل معتبر دارد", () => {
        for (let i = 0; i < 50; i++) {
            expect(isTemporaryPasswordShape(generateTemporaryPassword())).toBe(true)
        }
    })

    it("طول اشتباه را رد می‌کند", () => {
        expect(isTemporaryPasswordShape("short")).toBe(false)
        expect(isTemporaryPasswordShape("A".repeat(11))).toBe(false)
        expect(isTemporaryPasswordShape("A".repeat(13))).toBe(false)
    })

    it("نویسهٔ خارج از الفبا (از جمله سمبول) را رد می‌کند", () => {
        expect(isTemporaryPasswordShape("ABCDEFGHJKL!")).toBe(false)
        expect(isTemporaryPasswordShape("ABCDEFGHJKL0")).toBe(false)
        expect(isTemporaryPasswordShape("ABCDEFGHJKLO")).toBe(false)
    })
})
