import { NextRequest, NextResponse } from "next/server"
import { verifyTurnstile } from "@/app/lib/turnstile"
import { CAPTCHA_ACTIONS } from "@/app/lib/captchaActions"
import { createOtpChallenge, sendOtpEmail } from "@/app/lib/services/otp.service"

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { email?: string; turnstileToken?: string }
      | null

    // Turnstile: fail-closed و قبل از هر کار حساس (ساخت کد در DB / ارسال ایمیل).
    // بدون توکن معتبر، حتی یک کد OTP ساخته و ارسال نمی‌شود (ضدِ OTP bombing).
    // توجه: هر درخواست باید توکن تازه داشته باشد؛ توکن مصرف‌شده/منقضی رد می‌شود.
    const turnstileToken = typeof body?.turnstileToken === "string" ? body.turnstileToken : ""
    if (!(await verifyTurnstile(turnstileToken, { expectedAction: CAPTCHA_ACTIONS.sendOtp }))) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "CAPTCHA_FAILED",
            message: "تأیید انسان بودن ناموفق بود؛ دوباره تلاش کن",
          },
        },
        { status: 400 },
      )
    }

    const email = body?.email?.trim().toLowerCase()

    if (!email) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION_ERROR", message: "ایمیل الزامی است" } },
        { status: 400 },
      )
    }

    const challenge = await createOtpChallenge(email)
    const delivery = await sendOtpEmail(email, challenge.code)

    // شکست ارسال هرگز بی‌صدا رد نمی‌شود: کد در DB هست ولی به کاربر نرسیده، پس
    // پاسخ موفقیت دروغین نمی‌دهیم (همان قرارداد مسیر login).
    if (!delivery.sent) {
      console.error("[send-otp] email delivery failed:", delivery.error)
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "EMAIL_DELIVERY_FAILED",
            message: "ارسال کد ناموفق بود؛ دوباره تلاش کن",
          },
        },
        { status: 503 },
      )
    }

    return NextResponse.json({ ok: true, message: "کد با موفقیت ارسال شد" }, { status: 200 })
  } catch (error) {
    console.error("[send-otp] failed:", error)
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "خطای سرور" } },
      { status: 500 },
    )
  }
}
