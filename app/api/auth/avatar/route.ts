import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getPrisma } from "@/app/lib/getPrisma"

const MAX_BYTES = 800 * 1024 // حداکثر حجم payload کدشده (~۶۰۰KB عکس اصلی)

// POST: ذخیره عکس پروفایل — عکس سمت کلاینت به data-URL فشرده تبدیل می‌شود
export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const body = (await req.json().catch(() => null)) as { image?: unknown } | null
        const image = typeof body?.image === "string" ? body.image : null

        if (!image) {
            return NextResponse.json({ message: "عکسی ارسال نشده است" }, { status: 400 })
        }

        if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(image)) {
            return NextResponse.json({ message: "فرمت عکس معتبر نیست (PNG، JPG یا WebP)" }, { status: 400 })
        }

        if (image.length > MAX_BYTES) {
            return NextResponse.json({ message: "حجم عکس زیاد است؛ عکس کوچک‌تری انتخاب کنید" }, { status: 413 })
        }

        const prisma = getPrisma()
        const updated = await prisma.user.update({
            where: { id: user.id },
            data: { image },
            select: { id: true, image: true },
        })

        return NextResponse.json({ data: updated, message: "عکس پروفایل به‌روزرسانی شد ✅" })
    } catch (error) {
        console.error("AVATAR POST ERROR:", error)
        return NextResponse.json({ message: "خطای سرور" }, { status: 500 })
    }
}

// DELETE: بازگشت به آواتار پیش‌فرض (حروف اول نام)
export async function DELETE() {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const prisma = getPrisma()
        await prisma.user.update({ where: { id: user.id }, data: { image: null } })

        return NextResponse.json({ message: "عکس پروفایل حذف شد" })
    } catch (error) {
        console.error("AVATAR DELETE ERROR:", error)
        return NextResponse.json({ message: "خطای سرور" }, { status: 500 })
    }
}
