"use client"

type LogoProps = {
    size?: number
}

export default function Logo({ size = 26 }: LogoProps) {
    const calculatedWidth = Math.round(size * 4.2)

    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 999,
                lineHeight: 0,
                padding: "3px 12px",
                boxSizing: "border-box",
                flexShrink: 0,
            }}
        >
            <span
                style={{
                    height: size,
                    width: calculatedWidth,
                    maxWidth: "100%",
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    position: "relative",
                }}
            >
                <img
                    src="/logo.png"
                    alt="روزچین"
                    style={{
                        height: "135%",
                        width: "115%",
                        objectFit: "contain",
                        objectPosition: "center center",
                        display: "block",
                        pointerEvents: "none",
                        userSelect: "none",
                    }}
                    draggable={false}
                />
            </span>
        </span>
    )
}
