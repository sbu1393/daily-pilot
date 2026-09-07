import { NextResponse } from "next/server"

// POST /api/auth/logout → حذف کوکی سشن
export async function POST() {
    const response = NextResponse.json({ message: "خروج انجام شد" }, { status: 200 })

    response.cookies.set("token", "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 0,
        path: "/",
    })

    return response
}