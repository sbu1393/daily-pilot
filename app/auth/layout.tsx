import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { redirect } from "next/navigation"

export default async function AuthLayout({
    children,
}: {
    children: React.ReactNode
}) {
    // کاربری که از قبل وارد شده نباید دوباره وارد صفحه ورود/ثبت‌نام شود
    const user = await getCurrentUser()
    if (user) redirect("/dashboard")

    return (
  <div className="dp-shell">
    <style>{`
      .dp-auth-card * { box-sizing: border-box; }
    `}</style>
    {children}
  </div>
)
}