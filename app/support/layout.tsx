import AppShell from "../components/layout/AppShell"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { redirect } from "next/navigation"

// دروازهٔ نشست برای بخش پشتیبانی — **دقیقاً همان الگوی** `app/dashboard/layout.tsx`.
// هیچ دروازهٔ جدیدی ساخته نمی‌شود:
//   بدون نشست        → /auth/login
//   رمز موقت         → /auth/set-new-password
// و مرز امنیتی واقعی همچنان `requireVerifiedUser` روی /api/tickets است.
// این لایه فقط UX است.
export default async function SupportLayout({ children }: { children: React.ReactNode }) {
    const user = await getCurrentUser()
    if (!user) redirect("/auth/login")
    if (user.mustChangePassword) redirect("/auth/set-new-password")

    return <AppShell user={user}>{children}</AppShell>
}
