import { NextRequest, NextResponse } from "next/server"
import { getPrisma } from "@/app/lib/getPrisma"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import bcrypt from "bcrypt"
import { z } from "zod"

const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, "رمز عبور فعلی را وارد کنید"),
    newPassword: z
        .string()
        .min(8, "رمز عبور جدید حداقل ۸ کاراکتر باشد")
        .max(128, "رمز عبور جدید بسیار طولانی است"),
    newPasswordConfirm: z.string(),
}).refine(
    (data) => data.newPassword === data.newPasswordConfirm,
    { message: "رمز عبور جدید و تکرار آن یکسان نیست", path: ["newPasswordConfirm"] },
)

export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const body = await req.json()
        const parsed = changePasswordSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { message: "اطلاعات نامعتبر است", errors: parsed.error.flatten() },
                { status: 400 },
            )
        }

        const { currentPassword, newPassword } = parsed.data

        const prisma = getPrisma()
        const record = await prisma.user.findUnique({
            where: { id: user.id },
            select: { password: true },
        })
        if (!record) {
            return NextResponse.json({ message: "کاربری یافت نشد" }, { status: 404 })
        }

        const currentMatch = await bcrypt.compare(currentPassword, record.password)
        if (!currentMatch) {
            return NextResponse.json(
                { message: "رمز عبور فعلی اشتباه است" },
                { status: 401 },
            )
        }

        if (currentPassword === newPassword) {
            return NextResponse.json(
                { message: "رمز عبور جدید باید با رمز فعلی متفاوت باشد" },
                { status: 400 },
            )
        }

        const hashed = await bcrypt.hash(newPassword, 12)

        await prisma.user.update({
            where: { id: user.id },
            data: { password: hashed },
        })

        return NextResponse.json({ message: "رمز عبور با موفقیت تغییر یافت ✅" })
    } catch (error) {
        console.error("CHANGE PASSWORD ERROR:", error)
        return NextResponse.json({ message: "خطای سرور" }, { status: 500 })
    }
}
