"use client"

import {
    FieldValues,
    Path,
    UseFormRegister,
    FieldErrors
} from "react-hook-form"


type FormItem<T extends FieldValues> = {
    name: Path<T>
    type: string
    label: string
    placeholder?: string
}


type FormInputProps<T extends FieldValues> = {
    formItem: FormItem<T>
    register: UseFormRegister<T>
    errors: FieldErrors<T>
}



export default function FormInput<T extends FieldValues>({ formItem, register, errors }: FormInputProps<T>) {

    const hasError = Boolean(errors[formItem.name])

    return (
        <div className="dp-field">
            <label className="dp-field-label">
                {formItem.label}
            </label>
            <input
                type={formItem.type}
                placeholder={formItem.placeholder}
                className={`dp-input ${hasError ? "dp-input-error" : ""}`}
                {...register(formItem.name)}
            />
            {
                hasError &&
                <p className="dp-error-text">
                    {
                        String(
                            errors[formItem.name]?.message
                        )
                    }
                </p>
            }
        </div>

    )
}