import styles from "./avatar.module.css"

export type AvatarUser = {
    username: string
    firstName?: string | null
    lastName?: string | null
    image?: string | null
}

export default function Avatar({
    user,
    size = "md",
}: {
    user: AvatarUser
    size?: "sm" | "md" | "lg"
}) {
    const initials = [
        user.firstName?.trim(),
        user.lastName?.trim(),
    ].filter(Boolean).join(" ").slice(0, 2) || user.username.slice(0, 1).toUpperCase()

    if (user.image) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={user.image} alt={user.username} className={`${styles.avatar} ${styles[size]}`} />
    }

    return (
        <div className={`${styles.avatar} ${styles[size]} ${styles.initials}`} aria-label={user.username}>
            {initials}
        </div>
    )
}