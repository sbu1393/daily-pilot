import AppShell from "../components/layout/AppShell"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { redirect } from "next/navigation"

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode
}) {
    // محافظت سمت سرور: بدون نشست معتبر، کاربر به صفحه ورود هدایت می‌شود
    const user = await getCurrentUser()
    if (!user) redirect("/auth/login")

    // رمز موقت: کاربر با رمز موقت لاگین کرده ولی هنوز رمز دائمی تعیین نکرده.
    // اینجا فقط UX است — مرز امنیتی واقعی، گارد مرکزی `requireVerifiedUser`
    // روی همهٔ /api/* است، تا با فراخوانی مستقیم API هم نتوان دور زد.
    if (user.mustChangePassword) redirect("/auth/set-new-password")

    return <AppShell user={user}>{children}</AppShell>
}