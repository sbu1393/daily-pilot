"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { loginSchema } from "@/app/schema/formSchema"
import { z } from "zod"
import FormInput from "@/app/components/FormInput"
import AuthCard from "@/app/components/AuthCard"
import { useRouter } from "next/navigation"
import { toast } from "react-toastify"
import Link from "next/link"
import { motion, AnimatePresence } from "framer-motion"

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
    const [step, setStep] = useState<"credential" | "otp">("credential")
    const [otpLoading, setOtpLoading] = useState(false)
    const [otpSent, setOtpSent] = useState(false)

    const credentialForm = useForm<LoginInput>({
        resolver: zodResolver(loginSchema),
        defaultValues: { email: "", password: "" },
        mode: "onSubmit",
    })

    const otpForm = useForm({
        defaultValues: { code: "" },
        mode: "onChange",
    })

    const router = useRouter()

    const sendOtp = async (email: string) => {
        setOtpLoading(true)
        try {
            const res = await fetch("/api/auth/login/otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email }),
            })
            const json = await res.json()
            if (!res.ok) {
                toast.error(json.message || "ارسال کد ناموفق بود")
                return false
            }
            toast.success("کد تأیید برای ایمیل شما ارسال شد ✅")
            setOtpSent(true)
            return true
        } catch {
            toast.error("خطا در ارتباط با سرور")
            return false
        } finally {
            setOtpLoading(false)
        }
    }

    const verifyOtp = async () => {
        const code = otpForm.getValues("code").trim()
        if (code.length < 6) {
            otpForm.setError("code", { message: "کد را به‌درستی وارد کنید" })
            return
        }
        setOtpLoading(true)
        try {
            const res = await fetch("/api/auth/login/otp/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code }),
            })
            const json = await res.json()
            if (!res.ok) {
                otpForm.setError("code", { message: json.message || "کد اشتباه است" })
                return
            }
            toast.success(json.message || "ورود انجام شد")
            router.push("/dashboard")
            router.refresh()
        } catch {
            otpForm.setError("code", { message: "خطا در ارتباط با سرور" })
        } finally {
            setOtpLoading(false)
        }
    }

    const onCredentialSubmit = async (data: LoginInput) => {
        const ok = await sendOtp(data.email)
        if (ok) {
            setStep("otp")
            otpForm.reset()
        }
    }



    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: .28, ease: "easeOut" }}
        >
            <AuthCard
                title={step === "otp" ? "کد تأیید" : "ورود به Daily Pilot"}
                subtitle={
                    step === "otp"
                        ? "کد سه‌رقمی را که به ایمیلت فرستادی وارد کن تا وارد شوی"
                        : "روزت را با خلبان خودکار برنامهریزی کن"
                }
            >
                <AnimatePresence mode="wait" initial={false}>
                    {step === "credential" && (
                        <motion.div
                            key="credential"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            transition={{ duration: .24 }}
                        >
                            <form
                                onSubmit={credentialForm.handleSubmit(onCredentialSubmit)}
                                className="dp-form"
                            >
                                <FormInput
                                    formItem={{
                                        name: "email",
                                        type: "email",
                                        label: "ایمیل",
                                        placeholder: "example@email.com",
                                    }}
                                    register={credentialForm.register}
                                    errors={credentialForm.formState.errors}
                                />

                                <FormInput
                                    formItem={{
                                        name: "password",
                                        type: "password",
                                        label: "رمز عبور",
                                        placeholder: "رمز عبور را وارد کنید",
                                    }}
                                    register={credentialForm.register}
                                    errors={credentialForm.formState.errors}
                                />

                                <button
                                    type="submit"
                                    disabled={otpLoading || credentialForm.formState.isSubmitting}
                                    className="dp-btn dp-btn-primary dp-btn-block"
                                >
                                    {otpLoading || credentialForm.formState.isSubmitting
                                        ? "در حال ارسال کد…"
                                        : "ارسال کد تأیید"
                                    }
                                </button>
                            </form>

                            <div className="dp-auth-switch">
                                حساب کاربری نداری؟{" "}
                                <Link href="/auth/register">ثبت‌نام کن</Link>
                            </div>
                        </motion.div>
                    )}

                    {step === "otp" && (
                        <motion.div
                            key="otp"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            transition={{ duration: .24 }}
                        >
                            <p className="otpSub">
                                به {credentialForm.getValues("email")} کد ارسال شد.
                            </p>

                            <form
                                onSubmit={otpForm.handleSubmit(verifyOtp)}
                                className="dp-form"
                            >
                                <div className="dp-field">
                                    <label className="dp-field-label">کد تأیید ۶ رقمی</label>
                                    <input
                                        {...otpForm.register("code", {
                                            required: "کد را وارد کنید",
                                            minLength: {
                                                value: 6,
                                                message: "کد باید ۶ رقم باشد",
                                            },
                                        })}
                                        type="text"
                                        inputMode="numeric"
                                        maxLength={6}
                                        className={`dp-input ${otpForm.formState.errors.code ? "dp-input-error" : ""}`}
                                        placeholder="123456"
                                        autoFocus
                                    />
                                    {otpForm.formState.errors.code && (
                                        <p className="dp-error-text">{otpForm.formState.errors.code.message}</p>
                                    )}
                                </div>

                                <button
                                    type="submit"
                                    disabled={otpLoading}
                                    className="dp-btn dp-btn-primary dp-btn-block"
                                >
                                    {otpLoading ? "در حال بررسی…" : "تأیید و ورود"}
                                </button>

                                <button
                                    type="button"
                                    className="dp-btn dp-btn-ghost dp-btn-block"
                                    onClick={() => {
                                        setStep("credential")
                                        otpForm.reset()
                                    }}
                                >
                                    برگشت به ورود
                                </button>
                            </form>
                        </motion.div>
                    )}
                </AnimatePresence>
            </AuthCard>
        </motion.div>
    )
}
