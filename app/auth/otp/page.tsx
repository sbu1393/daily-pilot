"use client"

import { Suspense, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import CaptchaWidget, { type CaptchaWidgetHandle } from "@/app/components/CaptchaWidget"
import { CAPTCHA_ACTIONS } from "@/app/lib/captchaActions"

/**
 * صفحهٔ تأیید کد یک‌بار مصرف — دو حالت مصرف:
 *
 * 1) **`?mode=login&challengeId=…&email=…`** — مرحلهٔ دوم ورود (2FA). چالش از قبل
 *    توسط `/api/auth/login` ساخته و ایمیل شده است، پس از مرحلهٔ ایمیل عبور می‌کنیم و
 *    مستقیماً فیلد کد را نشان می‌دهیم. بعد از تأیید، سشن توسط سرور صادر می‌شود و
 *    کاربر به `/dashboard` می‌رود.
 * 2) **بدون پارامتر** — تأیید سادهٔ ایمیل: ابتدا ایمیل می‌گیریم، کد می‌فرستیم
 *    (`/api/auth/send-otp`) و سپس تأیید می‌کنیم. در این حالت سشن صادر نمی‌شود.
 *
 * `useSearchParams` در یک Suspense boundary قرار دارد (الزام Next برای پریرندر).
 */
function OtpPageInner() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const challengeId = (searchParams.get("challengeId") ?? "").trim()
  // ورود دو مرحله‌ای فقط وقتی معتبر است که شناسهٔ چالش سرور هم همراه باشد
  const isTwoFactor = searchParams.get("mode") === "login" && challengeId !== ""

  const [email, setEmail] = useState(searchParams.get("email") ?? "")
  const [code, setCode] = useState("")
  const [step, setStep] = useState<"email" | "code">(isTwoFactor ? "code" : "email")
  const [loading, setLoading] = useState(false)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const captchaRef = useRef<CaptchaWidgetHandle | null>(null)

  const handleSendOtp = async () => {
    if (!email.trim()) {
      alert("لطفاً ایمیل را وارد کنید")
      return
    }
    // تا دریافت توکن معتبر Turnstile، ارسال مسدود است (ضدِ OTP bombing)
    const token = captchaRef.current?.getToken() ?? captchaToken
    if (!token) {
      alert("لطفاً تأیید امنیتی را کامل کن و دوباره تلاش کن")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), turnstileToken: token }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data?.error?.message ?? "ارسال کد ناموفق بود")
        return
      }
      setStep("code")
    } catch {
      alert("خطا در ارتباط با سرور")
    } finally {
      setLoading(false)
      // توکن Turnstile یک‌بارمصرف است: برای درخواست بعدی توکن تازه لازم است
      captchaRef.current?.reset()
    }
  }

  const handleVerifyOtp = async () => {
    if (!code.trim()) {
      alert("لطفاً کد را وارد کنید")
      return
    }
    const token = captchaRef.current?.getToken() ?? captchaToken
    if (!token) {
      alert("لطفاً تأیید امنیتی را کامل کن و دوباره تلاش کن")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // در حالت 2FA شناسهٔ چالش می‌رود؛ در حالت ساده ایمیل کافی است
          ...(isTwoFactor ? { challengeId } : { email: email.trim() }),
          code: code.trim(),
          turnstileToken: token,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data?.error?.message ?? "تأیید کد ناموفق بود")
        return
      }
      if (isTwoFactor) {
        // سشن نهایی همین حالا توسط سرور صادر شده است
        router.push("/dashboard")
        router.refresh()
        return
      }
      alert("کد با موفقیت تأیید شد")
    } catch {
      alert("خطا در ارتباط با سرور")
    } finally {
      setLoading(false)
      captchaRef.current?.reset()
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "40px auto", padding: 24 }}>
      <h1>{isTwoFactor ? "تأیید ورود با کد ایمیل" : "تأیید ایمیل با کد یک‌بار مصرف"}</h1>

      {isTwoFactor && (
        <p style={{ marginTop: 8, opacity: 0.8 }}>
          کد ۶ رقمی به ایمیل زیر فرستاده شد:
          <br />
          <strong dir="ltr">{email}</strong>
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 24 }}>
        <label>
          ایمیل
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={step === "code" || loading}
            placeholder="example@email.com"
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>

        <CaptchaWidget
          ref={captchaRef}
          action={step === "email" ? CAPTCHA_ACTIONS.sendOtp : CAPTCHA_ACTIONS.verifyOtp}
          onTokenChange={setCaptchaToken}
        />

        {step === "email" && (
          <button
            onClick={handleSendOtp}
            disabled={loading || !captchaToken}
            style={{ padding: 10 }}
          >
            {loading ? "در حال ارسال..." : !captchaToken ? "منتظر تأیید امنیتی…" : "ارسال کد"}
          </button>
        )}

        {step === "code" && (
          <>
            <label>
              کد تأیید
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={loading}
                placeholder="کد ۶ رقمی"
                maxLength={6}
                style={{ width: "100%", padding: 8, marginTop: 4 }}
              />
            </label>
            <button
              onClick={handleVerifyOtp}
              disabled={loading || !captchaToken}
              style={{ padding: 10 }}
            >
              {loading ? "در حال تأیید..." : !captchaToken ? "منتظر تأیید امنیتی…" : "تأیید"}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function OtpPage() {
  return (
    <Suspense fallback={null}>
      <OtpPageInner />
    </Suspense>
  )
}
