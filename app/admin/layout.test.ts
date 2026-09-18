// تست مرز دسترسی صفحات /admin (فاز ۴ + سخت‌سازی امنیتی):
//   بدون نشست        → /auth/login
//   نشست non-admin   → /dashboard (پوسته‌ی admin هرگز render نمی‌شود)
//   admin            → پوسته render می‌شود، بدون هیچ redirect
//
// محیط node بدون DOM: خودِ تابع layout صدا زده می‌شود و AppShell mock می‌شود
// (الگوی repo برای تست منطق بدون jsdom).

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    redirect: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }))
vi.mock("@/app/components/layout/AppShell", () => ({ default: () => null }))

import AdminLayout from "./layout"

const ADMIN = { id: 1, username: "admin", role: "ADMIN" }
const REGULAR = { id: 2, username: "user", role: "USER" }

const REDIRECT_SENTINEL = "NEXT_REDIRECT"

// این پکیج با transform کلاسیک JSX (React global) تست می‌شود؛ برای مسیر موفق که واقعاً JSX
// می‌سازد، همان runtime سبک stub می‌شود (بدون DOM/jsdom و بدون وابستگی جدید).
const createElement = vi.fn(() => null)
beforeAll(() => {
    ;(globalThis as { React?: unknown }).React = { createElement }
})

describe("app/admin/layout — access gate (server-side)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        createElement.mockClear()
        // رفتار واقعی Next: redirect() هرگز return نمی‌کند
        mocks.redirect.mockImplementation(() => {
            throw new Error(REDIRECT_SENTINEL)
        })
    })

    it("unauthenticated caller is sent to /auth/login", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        await expect(AdminLayout({ children: null })).rejects.toThrow(REDIRECT_SENTINEL)
        expect(mocks.redirect).toHaveBeenCalledWith("/auth/login")
    })

    it("authenticated non-admin is sent to /dashboard — the admin shell is never rendered", async () => {
        mocks.getCurrentUser.mockResolvedValue(REGULAR)

        await expect(AdminLayout({ children: null })).rejects.toThrow(REDIRECT_SENTINEL)
        expect(mocks.redirect).toHaveBeenCalledWith("/dashboard")
        expect(mocks.redirect).toHaveBeenCalledTimes(1)
    })

    it("admin passes the gate and renders the shell without any redirect", async () => {
        mocks.getCurrentUser.mockResolvedValue(ADMIN)

        await AdminLayout({ children: null })

        expect(mocks.redirect).not.toHaveBeenCalled()
        // پوسته واقعاً ساخته شده است (نه یک مقدار جعلی) — همان AppShell با کاربر نشست
        expect(createElement).toHaveBeenCalledTimes(1)
        expect((createElement.mock.calls[0] as unknown[])[1]).toEqual({ user: ADMIN })
    })
})
