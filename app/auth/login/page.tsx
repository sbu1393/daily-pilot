"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRef, useState } from "react"
import CaptchaWidget, { type CaptchaWidgetHandle } from "@/app/components/CaptchaWidget"
import { CAPTCHA_ACTIONS } from "@/app/lib/captchaActions"
import { loginSchema } from "@/app/schema/formSchema"
import { z } from "zod"
import FormInput from "@/app/components/FormInput"
import AuthCard from "@/app/components/AuthCard"
import { useRouter } from "next/navigation"
import { toast } from "react-toastify"
import Link from "next/link"
import { motion } from "framer-motion"
import { api } from "@/app/lib/api/client"

export type LoginInput = z.infer<typeof loginSchema>

/** بخش data پاسخ موفقیت‌آمیز /api/auth/login — قرارداد ورود دو مرحله‌ای. */
type LoginResult = {
    nextStep?: string
    challengeId?: string
    email?: string
}

const loginFields = [
    {
        name: "email",
        type: "email",
        label: "ایمیل",
        placeholder: "example@email.com"
    },
    {
        name: "password",
        type: "password",
        label: "رمز عبور",
        placeholder: "رمز عبور را وارد کنید"
    }
] satisfies {
    name: keyof LoginInput
    type: string
    label: string
    placeholder: string
}[]

export default function LoginForm() {
    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginInput>({
        resolver: zodResolver(loginSchema),
        defaultValues: { email: "", password: "" },
        mode: "onSubmit",
    })

    const [captchaToken, setCaptchaToken] = useState<string | null>(null)
    const captchaRef = useRef<CaptchaWidgetHandle | null>(null)
    const router = useRouter()

    const onCredentialSubmit = async (data: LoginInput) => {
        // تا دریافت توکن معتبر Turnstile ارسال مسدود است (دکمه هم غیرفعال می‌شود).
        const token = captchaRef.current?.getToken() ?? captchaToken
        if (!token) {
            toast.error("لطفاً تأیید امنیتی را کامل کن و دوباره تلاش کن")
            return
        }
        try {
            const result = await api<LoginResult>("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...data, turnstileToken: token }),
            })

            // ورود دو مرحله‌ای: سرور هنوز سشنی نساخته و منتظر تأیید کد ایمیل است.
            // اینجا reset نمی‌کنیم: توکن مصرف شده و صفحه در حال ترک است.
            if (result?.nextStep === "OTP" && result.challengeId) {
                const params = new URLSearchParams({
                    mode: "login",
                    challengeId: result.challengeId,
                    email: result.email ?? data.email,
                })
                router.push(`/auth/otp?${params.toString()}`)
                return
            }

            // مسیر جایگزین (سازگاری): اگر پاسخ، مرحلهٔ OTP را اعلام نکند
            toast.success("ورود موفق بود")
            router.push("/dashboard")
            router.refresh()
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "خطا در ارتباط با سرور")
            // توکن Turnstile یک‌بارمصرف است و در درخواست ناموفق هم مصرف شده؛
            // فقط در مسیر خطا چالش تازه می‌گیریم تا دکمه دوباره فعال شود.
            captchaRef.current?.reset()
        }
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: .28, ease: "easeOut" }}
        >
            <AuthCard
                title="ورود به روزساز"
                subtitle="روزت را با خلبان خودکار برنامه ریزی کن"
            >
                <form
                    onSubmit={handleSubmit(onCredentialSubmit)}
                    className="dp-form"
                >
                    {loginFields.map((item) => (
                        <FormInput
                            key={item.name}
                            formItem={item}
                            register={register}
                            errors={errors}
                        />
                    ))}

                    <CaptchaWidget
                        ref={captchaRef}
                        action={CAPTCHA_ACTIONS.login}
                        onTokenChange={setCaptchaToken}
                    />

                    <button
                        type="submit"
                        disabled={isSubmitting || !captchaToken}
                        className="dp-btn dp-btn-primary dp-btn-block"
                    >
                        {isSubmitting ? "در حال ورود…" : !captchaToken ? "منتظر تأیید امنیتی…" : "ورود"}
                    </button>
                </form>

                <div className="dp-auth-switch">
                    حساب کاربری نداری؟{" "}
                    <Link href="/auth/register">ثبت‌نام کن</Link>
                </div>
            </AuthCard>
        </motion.div>
    )
}
