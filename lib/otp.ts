import { randomInt } from "crypto"
import bcrypt from "bcryptjs"

const BCRYPT_COST = 10

/**
 * تولید یک کد ۶ رقمی تصادفی (به صورت رشته با صفرهای پیشوندی).
 * از crypto.randomInt برای اعداد امن استفاده می‌کند.
 */
export function generateOtpCode(): string {
  const n = randomInt(0, 1_000_000)
  return String(n).padStart(6, "0")
}

/**
 * هش کردن کد OTP جهت ذخیره امن در دیتابیس.
 * از bcrypt استفاده می‌کند (salt خودکار).
 */
export async function hashOtp(code: string): Promise<string> {
  return bcrypt.hash(code, BCRYPT_COST)
}

/**
 * مقایسه کد وارد شده توسط کاربر با هش ذخیره‌شده.
 * true اگر مطابقت داشته باشد.
 */
export async function verifyOtp(inputCode: string, storedHash: string): Promise<boolean> {
  if (!inputCode || !storedHash) return false
  return bcrypt.compare(inputCode, storedHash)
}
