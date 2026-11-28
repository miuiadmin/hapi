import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { FloatingStatusPill } from './FloatingStatusPill'

const classesOf = (element: Element) => element.className.split(/\s+/)
// The spinner reads its label through the translation context, as it does in the app.
const show = (pill: ReactNode) => render(pill, { wrapper: I18nProvider })

afterEach(cleanup)

describe('FloatingStatusPill', () => {
    it('floats top centre over its area, moves nothing and takes no focus, and says what the view is doing', () => {
        show(<FloatingStatusPill testId="pill">Loading…</FloatingStatusPill>)
        const pill = screen.getByTestId('pill')
        expect(pill).toHaveAttribute('role', 'status')
        expect(pill).toHaveAttribute('aria-live', 'polite')
        for (const token of [
            'pointer-events-none', 'absolute', 'left-1/2', '-translate-x-1/2', 'top-3', 'rounded-full',
            'border-[var(--app-border)]', 'bg-[var(--app-bg)]/90', 'text-xs', 'text-[var(--app-hint)]', 'shadow-sm', 'backdrop-blur'
        ]) {
            expect(classesOf(pill)).toContain(token)
        }
        expect(pill.querySelector('.animate-spin')).not.toBeNull()
        expect(pill.textContent).toBe('Loading…')
    })

    it('can sit lower, when something such as a search bar is open above it', () => {
        show(<FloatingStatusPill top="top-12">Locating…</FloatingStatusPill>)
        const classes = classesOf(screen.getByRole('status'))
        expect(classes).toContain('top-12')
        expect(classes).not.toContain('top-3')
    })

    it('draws its spinner unless the state is a hint, or another icon stands in for it', () => {
        const { rerender } = show(<FloatingStatusPill spinner={false}>Pull to load older</FloatingStatusPill>)
        expect(screen.getByRole('status').querySelector('.animate-spin')).toBeNull()
        rerender(<FloatingStatusPill icon={<svg data-testid="arrow" />}>Release to load</FloatingStatusPill>)
        const pill = screen.getByRole('status')
        expect(pill.querySelector('.animate-spin')).toBeNull()
        expect(pill.querySelector('[data-testid="arrow"]')).not.toBeNull()
        expect(pill.textContent).toBe('Release to load')
    })

    // The point of the component: every floating status pill (the list loading, the thread pulling the
    // latest messages or older ones, the session being restored) is this one style and no other.
    it('is the only copy of its style: no other component carries the pill classes of its own', () => {
        const sourceRoot = resolve(__dirname, '..')
        const ownStyle = readFileSync(join(sourceRoot, 'components/FloatingStatusPill.tsx'), 'utf8')
            .match(/border-\[var\(--app-border\)\] bg-\[var\(--app-bg\)\]\/90 px-2\.5 py-1 text-xs text-\[var\(--app-hint\)\]/)?.[0]
        expect(ownStyle).toBeTruthy()
        const offenders: string[] = []
        const walk = (folder: string) => {
            for (const name of readdirSync(folder)) {
                const path = join(folder, name)
                if (statSync(path).isDirectory()) {
                    walk(path)
                    continue
                }
                if (!/\.tsx$/.test(name) || /\.test\./.test(name) || path.endsWith('/FloatingStatusPill.tsx')) continue
                if (readFileSync(path, 'utf8').includes(ownStyle!)) offenders.push(path.slice(sourceRoot.length))
            }
        }
        walk(sourceRoot)
        expect(offenders).toEqual([])
    })
})
