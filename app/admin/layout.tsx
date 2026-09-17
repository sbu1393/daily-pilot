import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import AppShell from "@/app/components/layout/AppShell"

// فاز ۴ — Step 7: layout صفحات /admin
//
// دو لایه:
// 1) server-side: بدون نشست → redirect به /auth/login (الگوی dashboard/layout.tsx —
//    هیچ middleware یا routing جدیدی ساخته نمی‌شود).
// 2) authorization خودِ admin همچنان فقط سمت سرور و در requireAdmin (مرز API) است؛
//    این گارد فقط UX است: non-admin صفحه را می‌بیند اما هیچ داده‌ای از API نمی‌گیرد
//    (403 ADMIN_FORBIDDEN → پیام UX). هیچ role-check client-side جدید اضافه نمی‌شود.
export const metadata: Metadata = {
    title: "مدیریت | روزچین",
    robots: { index: false, follow: false },
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const user = await getCurrentUser()
    if (!user) redirect("/auth/login")

    return <AppShell user={user}>{children}</AppShell>
}
