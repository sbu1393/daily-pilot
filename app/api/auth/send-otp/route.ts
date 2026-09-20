import { NextRequest, NextResponse } from "next/server"
import { generateOtpCode, hashOtp } from "@/lib/otp"
import { getPrisma } from "@/app/lib/getPrisma"
import { verifyTurnstile } from "@/app/lib/turnstile"
import { CAPTCHA_ACTIONS } from "@/app/lib/captchaActions"
import { Resend } from "resend"

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
