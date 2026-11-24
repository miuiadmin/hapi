import { useCallback, useState, useSyncExternalStore } from 'react'
import { getSessionOpenTrace, subscribeSessionOpenTrace, type SessionOpenTrace, type SessionOpenTraceLeg } from '@/lib/sessionOpenTrace'
import { telemetryClient } from '@/lib/telemetryClient'
import { useTranslation } from '@/lib/use-translation'

function developerModeOn(): boolean {
    try {
        return (telemetryClient.getLevel?.() ?? 0) > 0
    } catch {
        return false
    }
}

export function formatOpenTraceMs(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function formatOpenTraceBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 10 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function formatOpenTraceClock(ms: number): string {
    try {
        return new Date(ms).toLocaleTimeString([], { hour12: false })
    } catch {
        return ''
    }
}

const LEG_KIND_KEY: Record<SessionOpenTraceLeg['kind'], string> = {
    latest: 'openTrace.kind.latest',
    context: 'openTrace.kind.context',
    'catch-up': 'openTrace.kind.catch-up',
    detail: 'openTrace.kind.detail'
}

const ENTRY_KEY: Record<string, string> = {
    'list-click': 'openTrace.entry.list-click',
    'search-hit': 'openTrace.entry.search-hit',
    'permission-jump': 'openTrace.entry.permission-jump',
    'deep-link': 'openTrace.entry.deep-link',
    'url-direct': 'openTrace.entry.url-direct',
    open: 'openTrace.entry.open'
}

function legSize(leg: SessionOpenTraceLeg, cachedLabel: string): string {
    if (leg.wireBytes === undefined) return '—'
    return leg.wireBytes === 0 ? `0B (${cachedLabel})` : formatOpenTraceBytes(leg.wireBytes)
}

/**
 * Developer-mode readout of the session open: when the first message row was
 * on screen, when the tail was current, and which requests it took (with bytes
 * and rows). A bar of its own above the thread, so it never covers a message;
 * tap for the request list.
 */
export function SessionOpenTraceChip(props: { sessionId: string }) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)
    const subscribe = useCallback((listener: () => void) => subscribeSessionOpenTrace(listener), [])
    const getSnapshot = useCallback(() => getSessionOpenTrace(props.sessionId), [props.sessionId])
    const trace: SessionOpenTrace | null = useSyncExternalStore(subscribe, getSnapshot, () => null)

    if (!developerModeOn()) return null

    const first = !trace || trace.firstRowMs === null ? null : formatOpenTraceMs(trace.firstRowMs)
    let summary: string
    if (!trace) {
        summary = t('openTrace.none')
    } else {
        if (!trace.done) {
            summary = first === null ? t('openTrace.loading') : t('openTrace.loadingFirst', { first })
        } else if (trace.left) {
            summary = t('openTrace.leftSummary', { first: first ?? '—' })
        } else {
            summary = t('openTrace.summary', {
                first: first ?? '—',
                settled: formatOpenTraceMs(trace.settledMs ?? 0),
                requests: String(trace.requestCount),
                size: formatOpenTraceBytes(trace.wireBytes),
                rows: String(trace.rowCount)
            })
        }
    }
    const state = !trace ? 'none' : !trace.done ? 'loading' : trace.left ? 'left' : 'settled'

    return (
        <div className="relative z-20 flex min-h-6 w-full shrink-0 items-center border-b border-[var(--app-border)] bg-[var(--app-bg)] text-xs" data-testid="session-open-trace" data-state={state}>
            <button
                type="button"
                aria-expanded={expanded}
                title={t('openTrace.title')}
                onClick={() => setExpanded((value) => !value)}
                className="flex min-w-0 items-center px-2 py-0.5 text-left text-[11px] text-[var(--app-hint)] tabular-nums"
            >
                {trace?.fromCache ? `${t('openTrace.cached')} · ` : ''}{summary}
            </button>
            {expanded && trace ? (
                <div className="absolute left-0 top-full w-[min(30rem,calc(100vw-2rem))] rounded-b-lg border border-t-0 border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-[11px] text-[var(--app-fg)] shadow-lg">
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="font-medium">
                            {t('openTrace.title')}
                            {' · '}
                            {t(ENTRY_KEY[trace.entry] ?? 'openTrace.entry.open')}
                            {' · '}
                            <span className="tabular-nums">{formatOpenTraceClock(trace.openedAt)}</span>
                        </span>
                        <button type="button" onClick={() => setExpanded(false)} aria-label={t('openTrace.close')} className="rounded px-1 text-[var(--app-hint)]">×</button>
                    </div>
                    <div className="mb-1 text-[var(--app-hint)]">
                        {t('openTrace.first')}: <span className="tabular-nums">{first ?? '—'}</span>
                        {' · '}{t('openTrace.settled')}: <span className="tabular-nums">{trace.settledMs === null ? (trace.done ? t('openTrace.notSettled') : '…') : formatOpenTraceMs(trace.settledMs)}</span>
                        {' · '}{t('openTrace.rows')}: <span className="tabular-nums">{trace.done ? trace.rowCount : '…'}</span>
                    </div>
                    {trace.legs.length === 0 ? (
                        <p className="text-[var(--app-hint)]">{t('openTrace.noLegs')}</p>
                    ) : (
                        <table className="w-full border-collapse">
                            <thead>
                                <tr className="text-left text-[var(--app-hint)]">
                                    <th className="py-0.5 pr-2 font-normal">{t('openTrace.col.request')}</th>
                                    <th className="py-0.5 pr-2 text-right font-normal">{t('openTrace.col.start')}</th>
                                    <th className="py-0.5 pr-2 text-right font-normal">{t('openTrace.col.ttfb')}</th>
                                    <th className="py-0.5 pr-2 text-right font-normal">{t('openTrace.col.total')}</th>
                                    <th className="py-0.5 pr-2 text-right font-normal">{t('openTrace.col.wire')}</th>
                                    <th className="py-0.5 text-right font-normal">{t('openTrace.col.rows')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {trace.legs.map((leg, index) => (
                                    <tr key={`${leg.kind}-${leg.startMs}-${index}`} className="tabular-nums">
                                        <td className="py-0.5 pr-2 whitespace-nowrap">
                                            {t(LEG_KIND_KEY[leg.kind])}
                                            {leg.status === 0 ? ` (${t('openTrace.failed')})` : ''}
                                        </td>
                                        <td className="py-0.5 pr-2 text-right">+{leg.startMs}ms</td>
                                        <td className="py-0.5 pr-2 text-right">{leg.ttfbMs === undefined ? '—' : formatOpenTraceMs(leg.ttfbMs)}</td>
                                        <td className="py-0.5 pr-2 text-right">{formatOpenTraceMs(leg.totalMs)}</td>
                                        <td className="py-0.5 pr-2 text-right">{legSize(leg, t('openTrace.cached'))}</td>
                                        <td className="py-0.5 text-right">{leg.rows === undefined ? '' : leg.rows}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    <p className="mt-1 text-[var(--app-hint)]">{t('openTrace.note')}</p>
                </div>
            ) : null}
        </div>
    )
}
