import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { profileSchema } from "@/app/schema/formSchema"

// GET: اطلاعات حساب کاربری جاری
export async function GET() {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
        return NextResponse.json({ data: user })
    } catch (error) {
        console.error("PROFILE GET ERROR:", error)
        return NextResponse.json({ message: "خطای سرور" }, { status: 500 })
    }
}

// PATCH: ویرایش اطلاعات حساب کاربری
export async function PATCH(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const body = await req.json()
        const parsed = profileSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { message: "اطلاعات نامعتبر است", errors: parsed.error.flatten() },
                { status: 400 },
            )
        }

        const { username, firstName, lastName, phone, birthDate } = parsed.data

        const prisma = getPrisma()

        // بررسی تکراری نبودن نام کاربری (اگر تغییر کرده باشد)
        if (username !== user.username) {
            const exists = await prisma.user.findFirst({
                where: { username, id: { not: user.id } },
                select: { id: true },
            })
            if (exists) {
                return NextResponse.json(
                    { message: "این نام کاربری قبلاً استفاده شده است" },
                    { status: 409 },
                )
            }
        }

        const updated = await prisma.user.update({
            where: { id: user.id },
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
            },
        })

        return NextResponse.json({ data: updated, message: "اطلاعات حساب با موفقیت ذخیره شد" })
    } catch (error) {
        console.error("PROFILE PATCH ERROR:", error)
        return NextResponse.json({ message: "خطای سرور" }, { status: 500 })
    }
}