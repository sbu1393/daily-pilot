"use client"

// فراموشی رمز عبور — ایمیل را می‌گیرد و رمز موقت می‌فرستد.
//
// نکتهٔ UX که عمداً رعایت شده: پیام موفقیت **برای ایمیل موجود و ناموجود یکسان**
// است، دقیقاً همان متنی که سرور برمی‌گرداند. این صفحه عمداً هیچ نشانه‌ای نمی‌دهد
// که آیا حسابی با این ایمیل وجود دارد یا نه — وگرنه صفحه تبدیل به ابزار
// enumeration می‌شد. پس «بازگشت به ورود» برای هر دو حالت یکی است.

import { useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { motion } from "framer-motion"

import CaptchaWidget, { type CaptchaWidgetHandle } from "@/app/components/CaptchaWidget"
import AuthCard from "@/app/components/AuthCard"
import { CAPTCHA_ACTIONS } from "@/app/lib/captchaActions"
import { api } from "@/app/lib/api/client"

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export default function ForgotPasswordPage() {
    const [email, setEmail] = useState("")
    const [busy, setBusy] = useState(false)
    const [sent, setSent] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [captchaToken, setCaptchaToken] = useState<string | null>(null)
    const captchaRef = useRef<CaptchaWidgetHandle | null>(null)
    const router = useRouter()

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (busy) return

        const trimmed = email.trim().toLowerCase()
        if (!EMAIL_RE.test(trimmed)) {
            setError("ایمیل معتبر نیست")
            return
        }

        const token = captchaRef.current?.getToken() ?? captchaToken
        if (!token) {
            setError("لطفاً تأیید امنیتی را کامل کن و دوباره تلاش کن")
            return
        }

        setBusy(true)
        setError(null)
        try {
            await api("/api/auth/forgot-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: trimmed, turnstileToken: token }),
            })
            // پاسخ برای ایمیل ناموجود هم ۲۰۰ است، پس این پیام عمداً عمومی است.
            setSent(true)
        } catch (err) {
            setError(err instanceof Error ? err.message : "ارسال رمز موقت ناموفق بود")
            captchaRef.current?.reset()
        } finally {
            setBusy(false)
        }
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
        >
            <AuthCard
                title="رمز عبور را فراموش کرده‌اید؟"
                subtitle="ایمیل‌تان را وارد کنید تا یک رمز موقت برایتان بفرستیم"
            >
                {sent ? (
                    <>
                        <p className="dp-card-hint">
                            اگر این ایمیل در سامانه باشد، رمز موقت برای آن ارسال شد.
                        </p>
                        <p className="dp-card-hint">
                            رمز موقت را در صفحهٔ ورود وارد کنید؛ بعد از ورود، از شما
                            خواسته می‌شود رمز عبور دائمی جدیدی تعیین کنید.
                        </p>
                        <button
                            type="button"
                            className="dp-btn dp-btn-primary dp-btn-block"
                            onClick={() => router.push("/auth/login")}
                        >
                            بازگشت به ورود
                        </button>
                    </>
                ) : (
                    <form onSubmit={submit} className="dp-form">
                        <div className="dp-field">
                            <label className="dp-field-label" htmlFor="forgot-email">
                                ایمیل
                            </label>
                            <input
                                id="forgot-email"
                                type="email"
                                className="dp-input"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="example@email.com"
                                dir="ltr"
                                autoComplete="email"
                            />
                        </div>

                        <CaptchaWidget
                            ref={captchaRef}
                            action={CAPTCHA_ACTIONS.forgotPassword}
                            onTokenChange={setCaptchaToken}
                        />

                        {error !== null && (
                            <p className="dp-error-text" role="alert">
                                {error}
                            </p>
                        )}

                        <button
                            type="submit"
                            className="dp-btn dp-btn-primary dp-btn-block"
                            disabled={busy || !captchaToken}
                        >
                            {busy ? "در حال ارسال…" : !captchaToken ? "منتظر تأیید امنیتی…" : "ارسال رمز موقت"}
                        </button>
                    </form>
                )}

                <div className="dp-auth-switch">
                    <Link href="/auth/login">بازگشت به ورود</Link>
                </div>
            </AuthCard>
        </motion.div>
    )
}
