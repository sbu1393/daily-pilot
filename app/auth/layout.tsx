import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { redirect } from "next/navigation"

export default async function AuthLayout({
    children,
}: {
    children: React.ReactNode
}) {
    // کاربری که از قبل وارد شده نباید دوباره وارد صفحه ورود/ثبت‌نام شود.
    //
    // استثنای رمز موقت: کاربری که با رمز موقت لاگین کرده **باید** بتواند به
    // `/auth/set-new-password` برسد. بدون این شرط، این layout او را به
    // `/dashboard` می‌فرستاد، `dashboard/layout.tsx` دوباره به
    // `/auth/set-new-password` برمی‌گرداند و یک لوپ redirect بی‌پایان می‌ساخت.
    const user = await getCurrentUser()
    if (user && !user.mustChangePassword) redirect("/dashboard")

    return (
  <div className="dp-shell">
    <style>{`
      .dp-auth-card * { box-sizing: border-box; }
    `}</style>
    {children}
  </div>
)
}