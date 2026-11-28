import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playUserBubbleEntrance } from './userBubbleEntrance'

type Played = { element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions }
let played: Played[]
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')

/** An element with a box: jsdom lays nothing out. */
function box(height: number): HTMLElement {
    const element = document.createElement('div')
    element.getBoundingClientRect = () => ({ height, top: 0, bottom: height, left: 0, right: 300, width: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    return element
}

function thread(listHeight: number, viewportHeight: number) {
    const viewport = document.createElement('div') as HTMLElement
    Object.defineProperties(viewport, {
        scrollHeight: { configurable: true, value: listHeight },
        clientHeight: { configurable: true, value: viewportHeight },
    })
    const list = box(listHeight)
    const row = box(60)
    const bubble = box(60)
    bubble.className = 'happy-user-bubble'
    row.append(bubble)
    list.append(row)
    viewport.append(list)
    document.body.append(viewport)
    return { viewport, list, row, bubble }
}

describe('playUserBubbleEntrance', () => {
    beforeEach(() => {
        played = []
        Object.defineProperty(Element.prototype, 'animate', {
            configurable: true,
            writable: true,
            value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
                played.push({ element: this, keyframes, options })
                return { finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation
            },
        })
    })
    afterEach(() => {
        document.body.innerHTML = ''
        if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
        else Reflect.deleteProperty(Element.prototype, 'animate')
    })

    it('with the thread pinned to its bottom, the whole conversation glides up by one row and the bubble settles', () => {
        const { list, row, bubble, viewport } = thread(2_000, 530)
        expect(playUserBubbleEntrance({ list, row, viewport, pinnedToBottom: true, reduceMotion: false })).toBe(true)
        // The row is 60 tall and the list leaves 12 between rows.
        expect(played.map((entry) => entry.element)).toEqual([list, bubble])
        expect(played[0]!.keyframes).toEqual([{ transform: 'translateY(72px)' }, { transform: 'translateY(0)' }])
        expect(played[1]!.keyframes).toEqual([{ transform: 'scale(0.96)' }, { transform: 'scale(1)' }])
    })

    it('with the reader scrolled up, nothing glides: the new row is out of sight, so only the bubble settles', () => {
        const { list, row, bubble, viewport } = thread(2_000, 530)
        playUserBubbleEntrance({ list, row, viewport, pinnedToBottom: false, reduceMotion: false })
        expect(played.map((entry) => entry.element)).toEqual([bubble])
    })

    it('with a conversation too short to scroll, the row itself rises a little way and fades in', () => {
        const { list, row, bubble, viewport } = thread(300, 530)
        playUserBubbleEntrance({ list, row, viewport, pinnedToBottom: true, reduceMotion: false })
        expect(played.map((entry) => entry.element)).toEqual([bubble])
        const from = played[0]!.keyframes[0] as Keyframe & { opacity?: number }
        expect(from.transform).toBe('translateY(20px) scale(0.97)')
        expect(from.opacity).toBe(0)
    })

    it('plays nothing where the page asks not to, or cannot, animate', () => {
        const { list, row, viewport } = thread(2_000, 530)
        expect(playUserBubbleEntrance({ list, row, viewport, pinnedToBottom: true, reduceMotion: true })).toBe(false)
        expect(played).toHaveLength(0)

        Reflect.deleteProperty(Element.prototype, 'animate')
        expect(playUserBubbleEntrance({ list, row, viewport, pinnedToBottom: true, reduceMotion: false })).toBe(false)
    })
})
