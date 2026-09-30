"use client"

// تعیین رمز عبور جدید — صفحهٔ اجباریِ بعد از ورود با رمز موقت.
//
// این صفحه عمداً **هیچ راه فراری ندارد**:
//   • مودال غیرقابل dismiss است (نه Escape، نه کلیک بیرون، نه دکمهٔ بستن).
//   • بعد از موفقیت `router.replace` (نه `push`) استفاده می‌شود تا این صفحه در
//     history نماند و Back کاربر را به یک صفحهٔ مرده برنگرداند.
//   • سرور هم مستقلاً همه‌چیز را می‌بندد: گارد مرکزی `requireVerifiedUser` روی
//     تمام /api/* و redirect در `dashboard/layout.tsx`. پس حتی اگر کاربر URL را
//     دستی تایپ کند، داشبورد باز نمی‌شود.
//
// لینک «خروج» عمداً هست: کاربر باید بتواند نشست را ببندد (وگرنه در وضعیتی می‌ماند
// که نه می‌تواند کار کند و نه می‌تواند خارج شود). خروج enforcement را دور نمی‌زند.

import { useRouter } from "next/navigation"

import ForcedPasswordModal from "@/app/components/motion/ForcedPasswordModal"
import { api } from "@/app/lib/api/client"

export default function SetNewPasswordPage() {
    const router = useRouter()

    // عمداً هیچ «آیا نشست دارم؟» پروبه‌ای این‌جا نمی‌زنیم: در این وضعیت تمام
    // endpointهای محافظت‌شده ۴۰۳ می‌دهند، پس یک بررسی سلامت نشست در این صفحه همیشه
    // شکست می‌خورد و کاربر را اشتباهاً به صفحهٔ ورود می‌فرستد. مرجع، خودِ فرم است:
    // اگر نشستی نباشد، سرور ۴۰۱ می‌دهد و پیام خطا در مودال دیده می‌شود.

    const logout = async () => {
        try {
            await api("/api/auth/logout", { method: "POST" })
        } catch {
            // حتی اگر logout شکست بخورد، کاربر را به ورود می‌فرستیم.
        }
        router.replace("/auth/login")
    }

    return (
        <div className="container" style={{ paddingTop: 24 }}>
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <button type="button" className="dp-btn dp-btn-ghost" onClick={logout}>
                    خروج از حساب
                </button>
            </div>

            <ForcedPasswordModal
                open
                onSuccess={() => {
                    // نشست همان نشست معتبر می‌ماند؛ فقط فلگ DB صفر شده و مسیر
                    // داشبورد دوباره باز است. `replace` تا این صفحه در history نماند.
                    router.replace("/dashboard")
                    router.refresh()
                }}
            />
        </div>
    )
}
