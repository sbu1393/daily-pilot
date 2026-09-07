"use client"

type CalendarDayProps = {

    value: string

    dayName: string

    dayNumber: string

    month: string

    active: boolean

    today?: boolean

    onClick: () => void

}

export default function CalendarDay({

    dayName,
    dayNumber,
    month,
    active,
    today,
    onClick

}: CalendarDayProps) {

    return (

        <button
            onClick={onClick}
            className={`
                calendar-day shadow
                ${active ? "active" : ""}
                ${today ? "today" : ""}
            `}
        >

            <span className="day-name">
                {dayName}
            </span>


            <span className="day-number">
                {dayNumber}
            </span>


            <span className="month-name">
                {month}
            </span>

        </button>

    )
}