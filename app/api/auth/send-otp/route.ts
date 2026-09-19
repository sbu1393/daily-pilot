import { NextRequest, NextResponse } from "next/server"
import { generateOtpCode, hashOtp } from "@/lib/otp"
import { getPrisma } from "@/app/lib/getPrisma"
import { verifyRecaptcha } from "@/app/lib/recaptcha"
import { Resend } from "resend"

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { email?: string; recaptchaToken?: string }
      | null

    // reCAPTCHA v3: fail-closed و قبل از هر کار حساس (ساخت کد در DB / ارسال ایمیل).
    // بدون توکن معتبر، حتی یک کد OTP ساخته و ارسال نمی‌شود (ضدِ OTP bombing).
    const recaptchaToken = typeof body?.recaptchaToken === "string" ? body.recaptchaToken : ""
    if (!(await verifyRecaptcha(recaptchaToken))) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "RECAPTCHA_FAILED",
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

    const code = generateOtpCode()
    const codeHash = await hashOtp(code)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

    await getPrisma().otpCode.create({
      data: { email, codeHash, expiresAt },
    })

    const resend = new Resend(process.env.RESEND_API_KEY)
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL ?? "DailyPilot <onboarding@resend.dev>",
      to: email,
      subject: "کد تأیید DailyPilot",
      html: `<p>کد یک‌بار مصرف شما: <strong>${code}</strong></p><p>این کد تا ۱۰ دقیقه معتبر است.</p>`,
    })

    return NextResponse.json({ ok: true, message: "کد با موفقیت ارسال شد" }, { status: 200 })
  } catch (error) {
    console.error("[send-otp] failed:", error)
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "خطای سرور" } },
      { status: 500 },
    )
  }
}
