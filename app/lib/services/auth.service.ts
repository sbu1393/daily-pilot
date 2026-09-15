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
export async function authenticate(email: string, password: string): Promise<User> {
    const user = await getPrisma().user.findUnique({ where: { email } })
    if (!user) throw new InvalidCredentialsError()

    const passwordMatch = await bcrypt.compare(password, user.password)
    if (!passwordMatch) throw new InvalidCredentialsError()

    return user
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
}