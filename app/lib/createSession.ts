import { NextResponse } from "next/server"
import jwt from "jsonwebtoken"

// ساخت session مشترک بین login و register (G-14):
// JWT با payload {id, email} + کوکی httpOnly «token» با maxAge 7 روز
export function createSession(
    user: { id: number; email: string },
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
