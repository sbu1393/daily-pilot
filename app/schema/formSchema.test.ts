import { describe, expect, it } from "vitest"

import { profileSchema, registerSchema, usernameSchema, timezoneSchema } from "./formSchema"

/* قرارداد مشترک نام کاربری بین ثبت‌نام و پروفایل (۳ تا ۳۰ + الگوی امن). */

const registerBody = (username: string) => ({
    username,
    email: "user@example.com",
    password: "secret123",
    confirmPassword: "secret123",
})

describe("usernameSchema — قرارداد مشترک", () => {
    it("طول‌های مرزی ۳ و ۳۰ را می‌پذیرد", () => {
        expect(usernameSchema.safeParse("abc").success).toBe(true)
        expect(usernameSchema.safeParse("a".repeat(30)).success).toBe(true)
    })

    it("کوتاه‌تر از ۳ و بلندتر از ۳۰ را رد می‌کند", () => {
        expect(usernameSchema.safeParse("ab").success).toBe(false)
        expect(usernameSchema.safeParse("a".repeat(31)).success).toBe(false)
    })

    it("حروف فارسی/عربی، عدد، نقطه، خط تیره و زیرخط را می‌پذیرد", () => {
        expect(usernameSchema.safeParse("مهدی_رضایی").success).toBe(true)
        expect(usernameSchema.safeParse("ali.rz-01").success).toBe(true)
    })

    it("فاصله، اسلش و کاراکترهای کنترلی را رد می‌کند", () => {
        expect(usernameSchema.safeParse("ali rz").success).toBe(false)
        expect(usernameSchema.safeParse("ali/rz").success).toBe(false)
        expect(usernameSchema.safeParse("ali\nrz").success).toBe(false)
    })

    it("فاصلهٔ ابتدا/انتها را trim می‌کند", () => {
        expect(usernameSchema.parse("  ali  ")).toBe("ali")
    })
})

describe("registerSchema / profileSchema — هم‌راستایی", () => {
    it("هر دو نام کاربری ۳۱ کاراکتری را رد می‌کنند", () => {
        expect(registerSchema.safeParse(registerBody("a".repeat(31))).success).toBe(false)
        expect(profileSchema.safeParse({ username: "a".repeat(31) }).success).toBe(false)
    })

    it("هر دو نام کاربری با فاصله را رد می‌کنند", () => {
        expect(registerSchema.safeParse(registerBody("ali rz")).success).toBe(false)
        expect(profileSchema.safeParse({ username: "ali rz" }).success).toBe(false)
    })

    it("profileSchema یک PATCH جزئی را می‌پذیرد (نام کاربری اختیاری است)", () => {
        expect(profileSchema.safeParse({}).success).toBe(true)
        expect(profileSchema.safeParse({ phone: "09121234567" }).success).toBe(true)
    })
})

describe("timezoneSchema — اعتبارسنجی IANA", () => {
    it("Asia/Tehran و نام‌های رایج را می‌پذیرد", () => {
        expect(timezoneSchema.safeParse("Asia/Tehran").success).toBe(true)
        expect(timezoneSchema.safeParse("Europe/London").success).toBe(true)
        expect(timezoneSchema.safeParse("UTC").success).toBe(true)
    })

    it("نام نامعتبر، خالی و خیلی بلند را رد می‌کند", () => {
        expect(timezoneSchema.safeParse("Mars/Olympus").success).toBe(false)
        expect(timezoneSchema.safeParse("").success).toBe(false)
        expect(timezoneSchema.safeParse("A".repeat(65)).success).toBe(false)
    })

    it("profileSchema منطقه زمانی معتبر را می‌پذیرد و نامعتبر را رد می‌کند", () => {
        expect(profileSchema.safeParse({ timezone: "Asia/Tehran" }).success).toBe(true)
        expect(profileSchema.safeParse({ timezone: "Not/AZone" }).success).toBe(false)
    })

    it("نبودن timezone یعنی «دست نزن» و معتبر است", () => {
        expect(profileSchema.safeParse({ firstName: "علی" }).success).toBe(true)
    })

    it("فاصلهٔ اطراف را trim می‌کند", () => {
        expect(timezoneSchema.parse("  Asia/Tehran  ")).toBe("Asia/Tehran")
    })
})
