"use client"

import { GoogleReCaptchaProvider } from "react-google-recaptcha-v3"

/**
 * مرز کلاینت برای reCAPTCHA v3.
 *
 * چرا این wrapper لازم است؟
 * پکیج `react-google-recaptcha-v3` دایرکتیو `"use client"` ندارد؛ بنابراین وقتی
 * مستقیماً داخل `app/layout.tsx` (که یک Server Component است) import می‌شد،
 * Next.js آن را کد سروری می‌دید و `createContext` روی سرور اجرا می‌شد →
 * خطای «createContext only works in Client Components» و 500 شدن همه‌ی صفحات.
 *
 * این فایل فقط نقش مرز کلاینت/سرور را دارد و هیچ منطق دیگری اضافه نمی‌کند.
 */
export default function RecaptchaWrapper({ children }: { children: React.ReactNode }) {
    return (
        <GoogleReCaptchaProvider
            reCaptchaKey={process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY ?? ""}
            scriptProps={{ async: true, defer: true, appendTo: "head" }}
        >
            {children}
        </GoogleReCaptchaProvider>
    )
}
