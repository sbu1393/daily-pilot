import { NextRequest, NextResponse } from "next/server"
import { verifyOtp } from "@/lib/otp"
import { getPrisma } from "@/app/lib/getPrisma"
import { verifyRecaptcha } from "@/app/lib/recaptcha"

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { email?: string; code?: string; recaptchaToken?: string }
      | null

    // reCAPTCHA v3: fail-closed و قبل از هر کار حساس (خواندن رکورد در DB /
    // مقایسه‌ی brute-force پذیرِ کد). بدون توکن معتبر، هیچ تلاش تأییدی ثبت نمی‌شود.
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
    const code = body?.code?.trim()

    if (!email || !code) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION_ERROR", message: "ایمیل و کد الزامی هستند" } },
        { status: 400 },
      )
    }

    const record = await getPrisma().otpCode.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
    })

    if (!record) {
      return NextResponse.json(
        { ok: false, error: { code: "OTP_NOT_FOUND", message: "کدی برای این ایمیل یافت نشد" } },
        { status: 400 },
      )
    }

    if (record.expiresAt < new Date()) {
      return NextResponse.json(
        { ok: false, error: { code: "OTP_EXPIRED", message: "کد منقضی شده است" } },
        { status: 400 },
      )
    }

    const valid = await verifyOtp(code, record.codeHash)

    if (!valid) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_OTP", message: "کد وارد شده صحیح نیست" } },
        { status: 400 },
      )
    }

    await getPrisma().otpCode.delete({ where: { id: record.id } })

    return NextResponse.json({ ok: true, message: "کد با موفقیت تأیید شد" }, { status: 200 })
  } catch (error) {
    console.error("[verify-otp] failed:", error)
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "خطای سرور" } },
      { status: 500 },
    )
  }
}
