"use client"

type LogoProps = {
    size?: number
}

export default function Logo({ size = 44 }: LogoProps) {
    // پدینگ کپسول با اندازه لوگو مقیاس می‌شود تا شکل pill در همهجا حفظ شود
    const padY = Math.round(size * 0.09)
    const padX = Math.round(size * 0.36)

    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                background: "var(--primary-soft, #eef2ff)",
                borderRadius: 999,
                padding: `${padY}px ${padX}px`,
                lineHeight: 0,
            }}
        >
            <img
                src="/logo.png"
                alt="روزچین"
                style={{ height: size, width: "auto", display: "block" }}
            />
        </span>
    )
}
