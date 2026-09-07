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

    return <AppShell user={user}>{children}</AppShell>
}