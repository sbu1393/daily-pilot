"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useGoogleReCaptcha } from "react-google-recaptcha-v3"
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

    const router = useRouter()
    const { executeRecaptcha } = useGoogleReCaptcha()

    const onCredentialSubmit = async (data: LoginInput) => {
        if (!executeRecaptcha) {
            toast.error("کپچا هنوز بارگذاری نشده؛ کمی صبر کن و دوباره تلاش کن")
            return
        }
        const recaptchaToken = await executeRecaptcha("login")
        if (!recaptchaToken) {
            toast.error("تأیید کپچا ناموفق بود؛ دوباره تلاش کن")
            return
        }
        try {
            await api("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...data, recaptchaToken }),
            })

            toast.success("ورود موفق بود")
            router.push("/dashboard")
            router.refresh()
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "خطا در ارتباط با سرور")
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

                    <button
                        type="submit"
                        disabled={isSubmitting}
                        className="dp-btn dp-btn-primary dp-btn-block"
                    >
                        {isSubmitting ? "در حال ورود…" : "ورود"}
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
