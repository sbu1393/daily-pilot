import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import AppShell from "@/app/components/layout/AppShell"

// فاز ۴ — Step 7 (+ سخت‌سازی دسترسی): layout صفحات /admin
//
// سه لایه:
// 1) server-side: بدون نشست → redirect به /auth/login (الگوی dashboard/layout.tsx —
//    هیچ middleware یا routing جدیدی ساخته نمی‌شود).
// 2) server-side role gate: کاربر احراز‌شده‌ی non-admin هرگز پوسته‌ی /admin را نمی‌بیند و
//    در همان لایه‌ی سرور به /dashboard هدایت می‌شود. نقش فقط از DB می‌آید (getCurrentUser
//    در هر request از DB می‌خواند) و هیچ نقش/plan/emailی از JWT یا کلاینت خوانده نمی‌شود.
// 3) مرز امنیتی نهایی همچنان `requireAdmin` روی همه‌ی /api/admin/* است (401/403).
//    این گارد defense-in-depth است: اگر نقشِ یک نشستِ باز بین دو request پس گرفته شود،
//    API همان ۴۰۳ را می‌دهد و UI فقط پیام «بدون دسترسی» را نشان می‌دهد (AdminAccessGate).
export const metadata: Metadata = {
    title: "مدیریت | روزچین",
    robots: { index: false, follow: false },
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const user = await getCurrentUser()
    if (!user) redirect("/auth/login")
    if (user.role !== "ADMIN") redirect("/dashboard")

    return <AppShell user={user}>{children}</AppShell>
}
