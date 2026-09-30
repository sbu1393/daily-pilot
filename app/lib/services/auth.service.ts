import { getPrisma } from "@/app/lib/getPrisma"
import bcrypt from "bcryptjs"
import type { User } from "@prisma/client"
import {
    EmailTakenError,
    InvalidCredentialsError,
    SamePasswordError,
    toServiceErrorFromInfrastructure,
    UserNotFoundError,
    UsernameTakenError,
    WrongPasswordError,
} from "./errors"
import {
    consumeTokenForLogin,
    invalidateActiveTokensForUser,
    type PasswordResetClient,
} from "./passwordReset.service"

const BCRYPT_COST = 12

// ---------- ثبت‌نام ----------
export async function registerUser(input: {
    username: string
    email: string
    password: string
}): Promise<User> {
    const { username, email, password } = input
    const prisma = getPrisma()

    const exist = await prisma.user.findUnique({ where: { email } })
    if (exist) throw new EmailTakenError()

    const usernameExists = await prisma.user.findUnique({
        where: { username },
        select: { id: true },
    })
    if (usernameExists) throw new UsernameTakenError()

    const hashedPassword = await bcrypt.hash(password, BCRYPT_COST)

    try {
        return await prisma.user.create({
            data: {
                username,
                email,
                password: hashedPassword,
            },
        })
    } catch (error) {
        // E1 — §9.11: race دو ثبت‌نام همزمان روی email @unique → Prisma P2002.
        // تشخیص کد Prisma فقط در مرز خطا انجام می‌شود (toServiceErrorFromInfrastructure)
        // تا Domain وابسته به کد Prisma نشود. نتیجه: همان 409 CONFLICT که مسیر همیشگی هم می‌دهد.
        const infra = toServiceErrorFromInfrastructure(error)
        if (infra) throw infra
        throw error
    }
}

// ---------- ورود (خطای یکسان برای جلوگیری از User Enumeration) ----------

/**
 * نتیجهٔ authenticate — چرا `User` برنمی‌گرداند؟
 *
 * مسیر لاگین باید بداند ورود با **رمز دائمی** بوده یا **رمز موقت**، تا پرچم
 * `mustChangePassword` را تا `/auth/otp` و سشن نهایی حمل کند. برگرداندن خودِ
 * `User` این اطلاعات را ندارد، و اضافه‌کردن پرچم به `User` هم آن را آلوده می‌کند.
 * پس یک discriminated union برمی‌گردد — تغییری که هر دو حالت را صریح می‌کند.
 */
export type AuthenticationResult =
    | { kind: "NORMAL"; user: User }
    | { kind: "TEMPORARY"; user: User }

/**
 * authenticate — ایمیل + رمز را بررسی می‌کند.
 *
 * ترتیب بررسی **رمز دائمی اول، رمز موقت دوم** است، و دلیلش صرفاً کارایی نیست:
 * اگر اول توکن موقت بررسی شود، هر تلاش ناموفق یک increment روی `attempts`
 * می‌خورد و کاربری که رمز عبورش را اشتباه تایپ کرده، ممکن است بی‌دلیل سقف
 * تلاشِ توکنش را بسوزاند و ناچار شود دوباره رمز موقت بگیرد.
 *
 * خطا در **همهٔ** حالت‌ها یکسان است (`InvalidCredentialsError`): نه کاربر وجود
 * ندارد، نه رمز غلط است، نه توکن منقضی/مصرف‌شده/بی‌اثر. هیچ تفکیکی وجود ندارد
 * تا این مسیر قابلیت enumeration نداشته باشد.
 *
 * توجه: بازگشت `TEMPORARY` فقط **نوع ورود** را مشخص می‌کند. OTP همچنان اجباری
 * است — سشن فقط در `verify-otp` صادر می‌شود، نه اینجا.
 */
export async function authenticate(
    email: string,
    password: string,
    prisma: PrismaAuthClient = getPrisma() as unknown as PrismaAuthClient,
): Promise<AuthenticationResult> {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) throw new InvalidCredentialsError()

    const passwordMatch = await bcrypt.compare(password, user.password)
    if (passwordMatch) return { kind: "NORMAL", user }

    // رمز دائمی رد شد → شاید رمز موقت باشد. بررسی فقط وقتی لازم است که کاربر
    // قبلاً با رمز موقت لاگین کرده باشد؛ در آن صورت توکن فعال وجود دارد.
    // همان کلاینتِ تزریق‌شده جلو می‌رود تا تست بتواند مسیر را کنترل کند.
    const reset = await consumeTokenForLogin(prisma, {
        userId: user.id,
        candidate: password,
    })
    if (!reset.ok) throw new InvalidCredentialsError()

    return { kind: "TEMPORARY", user }
}

/**
 * کلاینت حداقلی موردنیاز `authenticate` — تزریق‌پذیر برای تست.
 * عملاً همان سطح دسترسی `PasswordResetClient` است (هر دو به `user` و
 * `passwordResetToken` نیاز دارند)؛ این interface فقط برای خواناییِ امضای
 * `authenticate` و تایپِ دقیق `User` تعریف شده.
 */
export interface PrismaAuthClient extends PasswordResetClient {
    user: PasswordResetClient["user"] & {
        findUnique: (args: unknown) => Promise<User | null>
    }
}

export type ProfileUpdateInput = {
    username: string
    firstName?: string | null
    lastName?: string | null
    phone?: string | null
    birthDate?: string | null
}

// ---------- ویرایش پروفایل ----------
export async function updateProfile(userId: number, currentUsername: string, input: ProfileUpdateInput) {
    const { username, firstName, lastName, phone, birthDate } = input
    const prisma = getPrisma()

    // بررسی تکراری نبودن نام کاربری (اگر تغییر کرده باشد)
    if (username !== currentUsername) {
        const exists = await prisma.user.findFirst({
            where: { username, id: { not: userId } },
            select: { id: true },
        })
        if (exists) throw new UsernameTakenError()
    }

    return prisma.user.update({
        where: { id: userId },
        data: {
            username,
            firstName: firstName?.trim() || null,
            lastName: lastName?.trim() || null,
            phone: phone?.trim() || null,
            birthDate: birthDate ? new Date(birthDate) : null,
        },
        select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
            image: true,
            birthDate: true,
            phone: true,
            timezone: true,
        },
    })
}

// ---------- آواتار ----------
export async function setAvatar(userId: number, image: string): Promise<{ id: number; image: string | null }> {
    return getPrisma().user.update({
        where: { id: userId },
        data: { image },
        select: { id: true, image: true },
    })
}

export async function removeAvatar(userId: number): Promise<void> {
    await getPrisma().user.update({ where: { id: userId }, data: { image: null } })
}

// ---------- تغییر رمز عبور ----------
/**
 * changePassword — مسیر عادی تغییر رمز (تنظیمات، یا هنگام داشتن رمز موقت).
 *
 * نکتهٔ امنیتی: هر تغییرِ موفقِ رمز، **توکن‌های رمز موقتِ باز را باطل می‌کند**.
 * بدون این، این سناریو ممکن بود: کاربر با رمز موقت لاگین می‌کند، بعد با همان
 * رمز موقت `change-password` را صدا می‌زند و یک رمز دائمی تازه می‌گذارد — ولی
 * خودِ توکن تا ۱۵ دقیقه معتبر می‌ماند و هر کسی که رمز موقت را از ایمیل دیده،
 * هنوز می‌تواند با آن وارد شود. یعنی «بعد از تغییر رمز، رمز موقت دیگر کار
 * نمی‌کند» فقط روی مسیر `set-new-password` درست می‌بود، نه روی این یکی.
 *
 * `invalidateActiveTokensForUser` عمداً fail-open است (best-effort) تا یک خطای
 * ثبت‌نظافتی، تغییر موفق رمز را شکست ندهد.
 */
export async function changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
): Promise<void> {
    const prisma = getPrisma()
    const record = await prisma.user.findUnique({
        where: { id: userId },
        select: { password: true },
    })
    if (!record) throw new UserNotFoundError()

    const currentMatch = await bcrypt.compare(currentPassword, record.password)
    if (!currentMatch) throw new WrongPasswordError()

    if (currentPassword === newPassword) throw new SamePasswordError()

    const hashed = await bcrypt.hash(newPassword, BCRYPT_COST)

    await prisma.user.update({
        where: { id: userId },
        data: { password: hashed },
    })

    // رمز تازه تعیین شد ⇒ هر رمز موقتِ در جریان بی‌اثر است.
    await invalidateActiveTokensForUser(prisma as unknown as PasswordResetClient, userId)
}