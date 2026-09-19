"use client"

type LogoProps = {
    size?: number        // ارتفاع لوگو به پیکسل
    className?: string
    pill?: boolean       // آیا فرم کپسولی داشته باشد؟ (پیش‌فرض: بله)
}

export default function Logo({ size = 32, className = "", pill = true }: LogoProps) {
    return (
        <span
            className={className}
            style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                height: pill ? size + 14 : size, // کمی فضا برای پدینگ کپسول
                padding: pill ? "6px 14px" : "0",
                borderRadius: pill ? 9999 : 0,   // شکل کاملاً کپسولی (Pill)
                // استایل متناسب با تم روشن و تاریک
                backgroundColor: pill ? "rgba(255, 255, 255, 0.92)" : "transparent",
                backdropFilter: pill ? "blur(8px)" : "none",
                // مرز بسیار ظریف و سایه ملایم که روی دارک‌مود جلوه لوکس و تمیزی بده
                border: pill ? "1px solid rgba(255, 255, 255, 0.2)" : "none",
                boxShadow: pill 
                    ? "0 2px 10px -2px rgba(0, 0, 0, 0.15), 0 1px 3px rgba(0, 0, 0, 0.1)" 
                    : "none",
                boxSizing: "border-box",
                lineHeight: 0,
                flexShrink: 0,
                transition: "all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
        >
            <img
                src="/logo.webp"
                alt="روزساز"
                style={{
                    height: `${size}px`,
                    width: "auto",
                    objectFit: "contain",
                    display: "block",
                    pointerEvents: "none",
                    userSelect: "none",
                    imageRendering: "-webkit-optimize-contrast",
                }}
                draggable={false}
            />
        </span>
    )
}
