import { NextRequest, NextResponse } from "next/server"
import { getPrisma } from "@/app/lib/getPrisma"
import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"
import { loginSchema } from "@/app/schema/formSchema"
import { isRateLimited, clientIp } from "@/app/lib/rateLimit"

export async function POST(req: NextRequest) {
    try {
        // محدودیت نرخ: به ازای IP (قبل از خواندن بدنه) و به ازای ایمیل (بعد از اعتبارسنجی)
        if (isRateLimited(`login:ip:${clientIp(req)}`)) {
            return NextResponse.json(
                { message: "تلاش‌های زیادی انجام شده؛ کمی بعد دوباره تلاش کن" },
                { status: 429 },
            )
        }

        const body = await req.json()

        const validation = loginSchema.safeParse(body)

        if (!validation.success) {
            return NextResponse.json(
                {
                    message: "اطلاعات نامعتبر است",
                    errors: validation.error.flatten(),
                },
                { status: 400 },
            )
        }

        const { email, password } = validation.data

        if (isRateLimited(`login:email:${email}`, 5)) {
            return NextResponse.json(
                { message: "تلاش‌های زیادی برای این حساب انجام شده؛ کمی بعد دوباره تلاش کن" },
                { status: 429 },
            )
        }

        const user = await getPrisma().user.findUnique({
            where: { email },
        })

        if (!user) {
            return NextResponse.json(
                { message: "ایمیل یا رمز عبور اشتباه است" },
                { status: 401 },
            )
        }

        const passwordMatch = await bcrypt.compare(password, user.password)

        if (!passwordMatch) {
            return NextResponse.json(
                { message: "ایمیل یا رمز عبور اشتباه است" },
                { status: 401 },
            )
        }

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

        const response = NextResponse.json(
            {
                message: "ورود موفق بود",
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                },
            },
            { status: 200 },
        )

        response.cookies.set("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 60 * 60 * 24 * 7,
            path: "/",
        })

        return response
    } catch (error) {
        console.error("LOGIN ERROR:", error)
        return NextResponse.json({ message: "خطای سرور" }, { status: 500 })
    }
}