"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRef, useState } from "react"
import CaptchaWidget, { type CaptchaWidgetHandle } from "@/app/components/CaptchaWidget"
import { CAPTCHA_ACTIONS } from "@/app/lib/captchaActions"
import { registerSchema } from "@/app/schema/formSchema"
import { z } from "zod"
import FormInput from "@/app/components/FormInput"
import { motion } from "framer-motion"
import AuthCard from "@/app/components/AuthCard"
import { useRouter } from "next/navigation"
import { toast } from "react-toastify"
import Link from "next/link"
import { api } from "@/app/lib/api/client"

export type RegisterInput = z.infer<typeof registerSchema>

const registerFields = [
    {
        name: "username",
        type: "text",
        label: "نام کاربری",
        placeholder: "نام کاربری خود را وارد کنید"
    },
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
    },
    {
        name: "confirmPassword",
        type: "password",
        label: "تکرار رمز عبور",
        placeholder: "رمز عبور را دوباره وارد کنید"
    }
] satisfies Array<{
    name: keyof RegisterInput
    type: string
    label: string
    placeholder: string
}>

export default function RegisterForm() {
    const { register, handleSubmit, formState: { errors } } = useForm<RegisterInput>({
        resolver: zodResolver(registerSchema)
    })

    const [loading, setLoading] = useState(false)
    const [captchaToken, setCaptchaToken] = useState<string | null>(null)
    const captchaRef = useRef<CaptchaWidgetHandle | null>(null)
    const router = useRouter()

    const onSubmit = async (data: RegisterInput) => {
        // تا دریافت توکن معتبر Turnstile ارسال مسدود است (دکمه هم غیرفعال می‌شود).
        const token = captchaRef.current?.getToken() ?? captchaToken
        if (!token) {
            toast.error("لطفاً تأیید امنیتی را کامل کن و دوباره تلاش کن")
            return
        }
        try {
            setLoading(true)

            await api("/api/auth/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...data, turnstileToken: token })
            })

            toast.success("ثبت نام با موفقیت انجام شد")
            router.push("/dashboard")
            router.refresh()
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "ثبت نام با شکست مواجه شد")
        }
        finally {
            setLoading(false)
            // توکن Turnstile یک‌بارمصرف است: پس از هر درخواست پاک و ویجت دوباره چالش می‌گیرد
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
                title="ساخت حساب کاربری"
                subtitle="چند ثانیه تا شروع برنامه ریزی هوشمند روزانه"
            >
                <form
                    onSubmit={handleSubmit(onSubmit)}
                    className="dp-form"
                >
                    {registerFields.map((item) => (
                        <FormInput
                            key={item.name}
                            formItem={item}
                            register={register}
                            errors={errors}
                        />
                    ))}

                    <CaptchaWidget
                        ref={captchaRef}
                        action={CAPTCHA_ACTIONS.register}
                        onTokenChange={setCaptchaToken}
                    />

                    <button
                        disabled={loading || !captchaToken}
                        className="dp-btn dp-btn-primary dp-btn-block"
                    >
                        {loading ? "در حال ثبت..." : !captchaToken ? "منتظر تأیید امنیتی…" : "ثبت‌نام رایگان"}
                    </button>
                </form>

                <div className="dp-auth-switch">
                    قبلاً ثبت‌نام کردهای؟{" "}
                    <Link href="/auth/login">وارد شو</Link>
                </div>
            </AuthCard>
        </motion.div>
    )
}
