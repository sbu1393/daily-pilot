"use client"

import { useState } from "react"
import { useGoogleReCaptcha } from "react-google-recaptcha-v3"

export default function OtpPage() {
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [step, setStep] = useState<"email" | "code">("email")
  const [loading, setLoading] = useState(false)
  const { executeRecaptcha } = useGoogleReCaptcha()

  const handleSendOtp = async () => {
    if (!email.trim()) {
      alert("لطفاً ایمیل را وارد کنید")
      return
    }
    if (!executeRecaptcha) {
      alert("کپچا هنوز بارگذاری نشده؛ کمی صبر کن و دوباره تلاش کن")
      return
    }
    const recaptchaToken = await executeRecaptcha("send_otp")
    if (!recaptchaToken) {
      alert("تأیید کپچا ناموفق بود؛ دوباره تلاش کن")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), recaptchaToken }),
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
    }
  }

  const handleVerifyOtp = async () => {
    if (!code.trim()) {
      alert("لطفاً کد را وارد کنید")
      return
    }
    if (!executeRecaptcha) {
      alert("کپچا هنوز بارگذاری نشده؛ کمی صبر کن و دوباره تلاش کن")
      return
    }
    const recaptchaToken = await executeRecaptcha("verify_otp")
    if (!recaptchaToken) {
      alert("تأیید کپچا ناموفق بود؛ دوباره تلاش کن")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code: code.trim(), recaptchaToken }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data?.error?.message ?? "تأیید کد ناموفق بود")
        return
      }
      alert("کد با موفقیت تأیید شد")
      console.log("OTP verified successfully")
    } catch {
      alert("خطا در ارتباط با سرور")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "40px auto", padding: 24 }}>
      <h1>تأیید ایمیل با کد یک‌بار مصرف</h1>

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

        {step === "email" && (
          <button onClick={handleSendOtp} disabled={loading} style={{ padding: 10 }}>
            {loading ? "در حال ارسال..." : "ارسال کد"}
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
            <button onClick={handleVerifyOtp} disabled={loading} style={{ padding: 10 }}>
              {loading ? "در حال تأیید..." : "تأیید"}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
