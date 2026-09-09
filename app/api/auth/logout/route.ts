import { NextResponse } from "next/server"
import { okMessageResponse } from "@/app/lib/apiResponse"

// POST /api/auth/logout → حذف کوکی سشن
export async function POST() {
    const response = okMessageResponse("خروج انجام شد")

    response.cookies.set("token", "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 0,
        path: "/",
    })

    return response
}