/**
 * How a message just sent arrives in the thread.
 *
 * The window keeps a sent message out of the thread proper until the agent has it; until then it is
 * drawn after the thread, in the same list, by PendingUserMessages. That row is what animates.
 */
/** How long a sent message takes to settle into the thread, and how the row list is spaced around it. */
export const SEND_ENTRANCE_MS = 320
const ROW_GAP_PX = 12
const SEND_ENTRANCE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/**
 * Plays the entrance of a row that was just sent: the message rises out of the composer while the
 * conversation above makes room for it.
 *
 * With the thread pinned to its bottom the new row already sits in place and everything above it
 * has jumped up by one row. The whole list is moved back down by that one row for a frame and then
 * glides up, so the conversation glides instead of jumping and the new bubble rises out from under
 * the composer. A conversation too short to scroll has nowhere to glide: there the row itself
 * rises a little way and fades in.
 *
 * Returns whether anything was played. Nothing is where the page cannot animate or asks not to.
 */
export function playUserBubbleEntrance(options: {
    list: HTMLElement
    row: HTMLElement
    viewport: HTMLElement | null
    /** The viewport shows the newest row (it scrolls with the thread). */
    pinnedToBottom: boolean
    reduceMotion: boolean
}): boolean {
    const { list, row, viewport } = options
    if (options.reduceMotion || typeof list.animate !== 'function' || typeof row.animate !== 'function') return false
    const rowHeight = row.getBoundingClientRect().height
    if (rowHeight <= 0) return false
    const bubble = row.querySelector<HTMLElement>('.happy-user-bubble')
    const glide = ROW_GAP_PX + rowHeight
    const roomToGlide = viewport !== null
        && options.pinnedToBottom
        // Only when the list is long enough that moving it down shows no gap above.
        && viewport.scrollHeight - viewport.clientHeight > glide + ROW_GAP_PX
    if (roomToGlide) {
        list.animate(
            [{ transform: `translateY(${glide}px)` }, { transform: 'translateY(0)' }],
            { duration: SEND_ENTRANCE_MS, easing: SEND_ENTRANCE_EASING },
        )
    } else {
        const target = bubble ?? row
        target.animate(
            [
                { transform: 'translateY(20px) scale(0.97)', opacity: 0 },
                { transform: 'translateY(0) scale(1)', opacity: 1 },
            ],
            { duration: SEND_ENTRANCE_MS, easing: SEND_ENTRANCE_EASING },
        )
        return true
    }
    if (bubble) {
        bubble.animate(
            [{ transform: 'scale(0.96)' }, { transform: 'scale(1)' }],
            { duration: SEND_ENTRANCE_MS, easing: SEND_ENTRANCE_EASING },
        )
    }
    return true
}
