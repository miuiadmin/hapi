import { useCallback, useSyncExternalStore } from 'react'
import { getSessionOpenTrace, subscribeSessionOpenTrace, type SessionOpenTrace, type SessionOpenTraceLeg } from '@/lib/sessionOpenTrace'
import { telemetryClient } from '@/lib/telemetryClient'
import { useTranslation } from '@/lib/use-translation'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/**
 * Whether the hub reports with developer-mode detail, which is also what records how a session
 * open went. Only then is there anything to show for the open.
 */
export function isDeveloperModeOn(): boolean {
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
    manifest: 'openTrace.kind.manifest',
    refresh: 'openTrace.kind.refresh',
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

type OpenTraceState = 'none' | 'loading' | 'left' | 'settled'

function getOpenTraceState(trace: SessionOpenTrace | null): OpenTraceState {
    if (!trace) return 'none'
    if (!trace.done) return 'loading'
    return trace.left ? 'left' : 'settled'
}

/** The open as it stands now, live while the dialog is open. */
export function useSessionOpenTrace(sessionId: string): SessionOpenTrace | null {
    const subscribe = useCallback((listener: () => void) => subscribeSessionOpenTrace(listener), [])
    const getSnapshot = useCallback(() => getSessionOpenTrace(sessionId), [sessionId])
    return useSyncExternalStore(subscribe, getSnapshot, () => null)
}

/**
 * Developer-mode readout of how this session's open went: when the first message row was on
 * screen, when the tail was current, and which requests it took (with bytes and rows).
 *
 * It opens from the session's "more" menu and takes nothing from the thread while closed. It used
 * to be a bar of its own above the messages, which cost every developer-mode session a strip of
 * the conversation for a number nobody needs between messages.
 */
export function SessionOpenTraceDialog(props: { isOpen: boolean; onClose: () => void; sessionId: string }) {
    const { t } = useTranslation()
    const trace = useSessionOpenTrace(props.sessionId)

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
    const state = getOpenTraceState(trace)

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogContent aria-describedby={undefined} className="flex max-h-[85vh] max-w-2xl flex-col gap-3">
                <DialogHeader>
                    <DialogTitle>{t('openTrace.title')}</DialogTitle>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto text-xs" data-testid="session-open-trace" data-state={state}>
                    <p className="text-[11px] tabular-nums text-[var(--app-hint)]">
                        {trace?.fromCache ? `${t('openTrace.cached')} · ` : ''}{summary}
                    </p>
                    {trace ? (
                        <>
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                <span className="font-medium text-[var(--app-fg)]">
                                    {t(ENTRY_KEY[trace.entry] ?? 'openTrace.entry.open')}
                                    {' · '}
                                    <span className="tabular-nums">{formatOpenTraceClock(trace.openedAt)}</span>
                                </span>
                                <span className="text-[var(--app-hint)]">
                                    {t('openTrace.first')}: <span className="tabular-nums text-[var(--app-fg)]">{first ?? '—'}</span>
                                    {' · '}{t('openTrace.settled')}: <span className="tabular-nums text-[var(--app-fg)]">{trace.settledMs === null ? (trace.done ? t('openTrace.notSettled') : '…') : formatOpenTraceMs(trace.settledMs)}</span>
                                    {' · '}{t('openTrace.rows')}: <span className="tabular-nums text-[var(--app-fg)]">{trace.done ? trace.rowCount : '…'}</span>
                                </span>
                            </div>
                            {trace.legs.length === 0 ? (
                                <p className="mt-2 text-[var(--app-hint)]">{t('openTrace.noLegs')}</p>
                            ) : (
                                <table className="mt-2 w-full border-collapse">
                                    <thead>
                                        <tr className="text-left text-[var(--app-hint)]">
                                            <th className="py-1 pr-2 font-normal">{t('openTrace.col.request')}</th>
                                            <th className="py-1 pr-2 text-right font-normal">{t('openTrace.col.start')}</th>
                                            <th className="py-1 pr-2 text-right font-normal">{t('openTrace.col.ttfb')}</th>
                                            <th className="py-1 pr-2 text-right font-normal">{t('openTrace.col.total')}</th>
                                            <th className="py-1 pr-2 text-right font-normal">{t('openTrace.col.wire')}</th>
                                            <th className="py-1 text-right font-normal">{t('openTrace.col.rows')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {trace.legs.map((leg, index) => (
                                            <tr key={`${leg.kind}-${leg.startMs}-${index}`} className="tabular-nums text-[var(--app-fg)]">
                                                <td className="py-1 pr-2 whitespace-nowrap">
                                                    {t(LEG_KIND_KEY[leg.kind])}
                                                    {leg.status === 0 ? ` (${t('openTrace.failed')})` : ''}
                                                </td>
                                                <td className="py-1 pr-2 text-right">+{leg.startMs}ms</td>
                                                <td className="py-1 pr-2 text-right">{leg.ttfbMs === undefined ? '—' : formatOpenTraceMs(leg.ttfbMs)}</td>
                                                <td className="py-1 pr-2 text-right">{formatOpenTraceMs(leg.totalMs)}</td>
                                                <td className="py-1 pr-2 text-right">{legSize(leg, t('openTrace.cached'))}</td>
                                                <td className="py-1 text-right">{leg.rows === undefined ? '' : leg.rows}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                            <p className="mt-2 text-[var(--app-hint)]">{t('openTrace.note')}</p>
                        </>
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    )
}
