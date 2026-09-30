"use client"

import { useState } from "react"
import { FieldValues, Path, UseFormRegister, FieldErrors } from "react-hook-form"

import PasswordVisibilityToggle from "./PasswordVisibilityToggle"

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
                    // `tabIndex={-1}` رفتار قبلی را حفظ می‌کند: دکمه با Tab در ردیف
                    // نیست ولی با کلیک و با صفحه‌خوان (`aria-label`) در دسترس است.
                    <PasswordVisibilityToggle
                        visible={showPassword}
                        onToggle={() => setShowPassword((prev) => !prev)}
                        tabIndex={-1}
                    />
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
