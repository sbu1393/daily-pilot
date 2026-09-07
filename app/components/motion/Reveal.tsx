"use client"

import { useRef } from "react"
import { motion, useInView } from "framer-motion"

/**
 * ظاهر شدن نرم هنگام اسکرول — جایگزین سبک برای تکرار whileInView در همه‌جا.
 * یک‌بار با ورود به دید، انیمیت می‌شود و همان‌جا می‌ماند.
 */
export default function Reveal({
    children,
    delay = 0,
    y = 24,
}: {
    children: React.ReactNode
    delay?: number
    y?: number
}) {
    const ref = useRef<HTMLDivElement | null>(null)
    const inView = useInView(ref, { once: true, margin: "-60px" })

    return (
        <motion.div
            ref={ref}
            initial={{ opacity: 0, y }}
            animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y }}
            transition={{ duration: .55, ease: [0.22, 1, 0.36, 1], delay }}
        >
            {children}
        </motion.div>
    )
}
