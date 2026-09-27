import { NextRequest, NextResponse } from "next/server"
import { verifyOtp } from "@/lib/otp"
import { getPrisma } from "@/app/lib/getPrisma"
import { verifyTurnstile } from "@/app/lib/turnstile"
import { CAPTCHA_ACTIONS } from "@/app/lib/captchaActions"
import { createSession } from "@/app/lib/createSession"
import { isRateLimited, clientIp } from "@/app/lib/rateLimit"
import { OTP_MAX_ATTEMPTS } from "@/app/lib/services/otp.service"
import {
  errorResponse,
  okResponse,
  validationErrorResponse,
} from "@/app/lib/apiResponse"

/**
 * POST /api/auth/verify-otp
 *
 * دو حالت مصرف:
 * 1) **مرحلهٔ دوم ورود (2FA)** — کلاینت `challengeId` را می‌فرستد (همان مقداری که
 *    `/api/auth/login` برگردانده). فقط در این حالت **سشن نهایی** ساخته می‌شود.
 * 2) **تأیید سادهٔ ایمیل** — کلاینت فقط `email` می‌فرستد (مسیر صفحهٔ /auth/otp بدون
 *    mode=login). کد تأیید و مصرف می‌شود ولی **سشن صادر نمی‌شود**.
 *
 * چرا این تفکیک امنیتی است؟ اگر تأیید کد به‌تنهایی سشن می‌ساخت، هر کسی می‌توانست با
 * `/api/auth/send-otp` (که هیچ بررسی رمز عبور ندارد) برای ایمیل هر کاربر موجود کد
 * بگیرد و همان مسیر، تبدیل به **ورود بدون رمز** شود. صدور سشن فقط با `challengeId`
 * انجام می‌شود که تنها مسیر ورود آن را به کلاینت می‌دهد.
 *
 * کد یک‌بارمصرف است: رکورد **قبل از** هر کار موفق (صدور سشن) حذف می‌شود.
 * Turnstile fail-closed و قبل از هر کار دیتابیسی است.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { email?: string; code?: string; challengeId?: string; turnstileToken?: string }
      | null

    // Turnstile: fail-closed و قبل از هر کار حساس (خواندن رکورد در DB /
    // مقایسه‌ی brute-force پذیرِ کد). بدون توکن معتبر، هیچ تلاش تأییدی ثبت نمی‌شود.
    // توجه: توکن Turnstile یک‌بارمصرف است — توکن قبلی برای این درخواست قابل استفاده نیست.
    const turnstileToken = typeof body?.turnstileToken === "string" ? body.turnstileToken : ""
    if (!(await verifyTurnstile(turnstileToken, { expectedAction: CAPTCHA_ACTIONS.verifyOtp }))) {
      return errorResponse(
        400,
        "CAPTCHA_FAILED",
        "تأیید انسان بودن ناموفق بود؛ دوباره تلاش کن",
      )
    }

    const challengeId = typeof body?.challengeId === "string" ? body.challengeId.trim() : ""
    const email = body?.email?.trim().toLowerCase()
    const code = body?.code?.trim()

    // یا challengeId (مسیر 2FA) یا email (مسیر تأیید سادهٔ ایمیل) — کد همیشه الزامی است
    if (!code || (!challengeId && !email)) {
      return validationErrorResponse(undefined, "ایمیل/شناسهٔ چالش و کد الزامی هستند")
    }

    // سقف تلاش (max attempts): یک سبد روی خود چالش/ایمیل و یک سبد روی IP.
    // قبل از هر خواندن/نوشتن دیتابیس و بعد از کپچا (همان ترتیب login route).
    const challengeKey = challengeId || (email as string)
    if (
      isRateLimited(`otp:verify:ip:${clientIp(req)}`, OTP_MAX_ATTEMPTS) ||
      isRateLimited(`otp:verify:challenge:${challengeKey}`, OTP_MAX_ATTEMPTS)
    ) {
      return errorResponse(
        429,
        "RATE_LIMITED",
        "تلاش‌های زیادی برای این کد انجام شده؛ کد تازه بگیر",
      )
    }

    const prisma = getPrisma()

    // lookup قطعی با challengeId؛ در نبود آن، جدیدترین کد همان ایمیل
    const record = challengeId
      ? await prisma.otpCode.findUnique({ where: { id: challengeId } })
      : await prisma.otpCode.findFirst({
          where: { email: email as string },
          orderBy: { createdAt: "desc" },
        })

    if (!record) {
      return errorResponse(400, "OTP_NOT_FOUND", "کدی برای این درخواست یافت نشد")
    }

    if (record.expiresAt < new Date()) {
      return errorResponse(400, "OTP_EXPIRED", "کد منقضی شده است")
    }

    const valid = await verifyOtp(code, record.codeHash)

    if (!valid) {
      // رکورد باقی می‌ماند تا کاربر بتواند کد درست را وارد کند؛ سقف تلاش بالا
      // جلوی brute force را می‌گیرد.
      return errorResponse(400, "INVALID_OTP", "کد وارد شده صحیح نیست")
    }

    // یک‌بارمصرف: مصرف/باطل کردن رکورد **قبل از** صدور سشن.
    // delete اتمیک است؛ دو درخواست هم‌زمان با همان کد، در دومی OTP_NOT_FOUND می‌گیرند.
    await prisma.otpCode.delete({ where: { id: record.id } })

    // سشن فقط برای چالشی که مرحلهٔ ورود صادر کرده است (challengeId).
    // ایمیل از خود **رکورد** خوانده می‌شود، نه از ورودی کلاینت.
    const user = challengeId
      ? await prisma.user.findUnique({
          where: { email: record.email },
          select: { id: true, username: true, email: true },
        })
      : null

    if (!user) {
      // مسیر تأیید سادهٔ ایمیل: موفق، ولی بدون سشن (رفتار قبلی حفظ می‌شود)
      return okResponse({ nextStep: "DONE" })
    }

    const response = okResponse({
      nextStep: "DONE",
      user: { id: user.id, username: user.username, email: user.email },
    })

    return createSession(user, response)
  } catch (error) {
    console.error("[verify-otp] failed:", error)
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "خطای سرور" } },
      { status: 500 },
    )
  }
}
