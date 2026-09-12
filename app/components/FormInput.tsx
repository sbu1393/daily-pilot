"use client"

import { useState } from "react"
import { FieldValues, Path, UseFormRegister, FieldErrors } from "react-hook-form"

export type FormItem<T extends FieldValues> = {
    name: Path<T>
    type: string
    label: string
    placeholder?: string
}

export type FormInputProps<T extends FieldValues> = {
    formItem: FormItem<T>
    register: UseFormRegister<T>
    errors: FieldErrors<T>
}

export default function FormInput<T extends FieldValues>({
    formItem,
    register,
    errors,
}: FormInputProps<T>) {
    const [showPassword, setShowPassword] = useState(false)
    const isPasswordField = formItem.type === "password"
    const hasError = Boolean(errors[formItem.name])

    // اگر نوع فیلد پسورد باشد و کاربر چشم را زده باشد، تایپ به text تغییر می‌کند
    const inputType = isPasswordField
        ? showPassword ? "text" : "password"
        : formItem.type

    return (
        <div className="dp-form-group">
            <label className="dp-label">{formItem.label}</label>

            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                <input
                    type={inputType}
                    placeholder={formItem.placeholder}
                    className={`dp-input ${hasError ? "dp-input-error" : ""}`}
                    style={isPasswordField ? { paddingLeft: "2.5rem" } : undefined}
                    {...register(formItem.name)}
                />

                {isPasswordField && (
                    <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        tabIndex={-1}
                        aria-label={showPassword ? "مخفی کردن رمز عبور" : "نمایش رمز عبور"}
                        style={{
                            position: "absolute",
                            left: "0.6rem",
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            padding: "4px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "var(--text-muted, #94a3b8)",
                        }}
                    >
                        {showPassword ? (
                            // آیکون چشم بسته (مخفی کردن)
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                <line x1="1" y1="1" x2="23" y2="23" />
                            </svg>
                        ) : (
                            // آیکون چشم باز (نمایش)
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                        )}
                    </button>
                )}
            </div>

            {hasError && (
                <p className="dp-error-text">
                    {errors[formItem.name]?.message ? String(errors[formItem.name]?.message) : ""}
                </p>
            )}
        </div>
    )
}
