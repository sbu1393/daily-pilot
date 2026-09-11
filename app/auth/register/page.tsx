"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useState } from "react"
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
    const router = useRouter()

    const onSubmit = async (data: RegisterInput) => {
        try {
            setLoading(true)

            await api("/api/auth/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data)
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

                    <button
                        disabled={loading}
                        className="dp-btn dp-btn-primary dp-btn-block"
                    >
                        {loading ? "در حال ثبت..." : "ثبت‌نام رایگان"}
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
