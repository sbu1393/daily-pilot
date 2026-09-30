import { NextResponse } from "next/server"
import jwt from "jsonwebtoken"

// ساخت session مشترک بین login و register (G-14):
// JWT با payload {id, email} + کوکی httpOnly «token» با maxAge 7 روز
//
// `mustChangePassword` هم در JWT حمل می‌شود ولی **مرجع حقیقت نیست**: enforcement
// از DB می‌خواند (getCurrentUser → requireVerifiedUser). دلیل حمل‌کردن: پرچم در
// لحظهٔ صدور سشن قطعاً درست است، پس اگر همان لحظه reset شد، کاربر با همان
// کوکی قدیمی ۷ روزه قفل نمی‌ماند — جایی که فلگ را صفر می‌کند، سشن تازه صادر
// می‌کند تا claim هم هماهنگ شود.
export function createSession(
    user: { id: number; email: string; mustChangePassword?: boolean },
    response: NextResponse,
) {
    const secret = process.env.JWT_SECRET

    if (!secret) {
        throw new Error("JWT_SECRET missing")
    }

    const token = jwt.sign(
        {
            id: user.id,
            email: user.email,
            mustChangePassword: user.mustChangePassword === true,
        },
        secret,
        { expiresIn: "7d" },
    )

    response.cookies.set("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 7,
        path: "/",
    })

    return response
}
