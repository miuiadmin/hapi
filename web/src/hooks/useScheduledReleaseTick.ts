import { useEffect, useState } from 'react'
import type { DecryptedMessage } from '@/types/api'
import { isQueuedForInvocation } from '@/lib/messages'

/**
 * A clock for "is this scheduled message due yet", advanced only when one comes due.
 *
 * Rows are compared against a number rather than Date.now() so a render stays pure and memoizable.
 * The number moves when the earliest row still ahead reaches its time (the row then leaves the
 * scheduled list for the thread), and when a row arrives that is already due by the wall clock but
 * not by this one.
 */
export function useScheduledReleaseTick(messages: readonly DecryptedMessage[]): number {
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        const clock = Date.now()
        let next: number | null = null
        for (const message of messages) {
            if (!isQueuedForInvocation(message) || message.scheduledAt == null) continue
            if (message.scheduledAt <= clock) {
                if (message.scheduledAt > now) setNow(clock)
            } else if (next === null || message.scheduledAt < next) {
                next = message.scheduledAt
            }
        }
        if (next === null) return
        const timer = setTimeout(() => setNow(Date.now()), next - clock + 50)
        return () => clearTimeout(timer)
    }, [messages, now])

    return now
}
