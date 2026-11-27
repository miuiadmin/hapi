import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Outlet, useLocation, useMatchRoute, useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { getTelegramWebApp, isTelegramApp } from '@/hooks/useTelegram'
import { initializeChatSurfaceColors } from '@/hooks/useChatSurfaceColors'
import { initializeTheme } from '@/hooks/useTheme'
import { initializeThemeColors } from '@/hooks/useThemeColors'
import { useAuth } from '@/hooks/useAuth'
import { useAuthSource } from '@/hooks/useAuthSource'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useSSE, type SseConnectInfo } from '@/hooks/useSSE'
import { useDelayedFlag } from '@/hooks/useDelayedFlag'
import { useSessions } from '@/hooks/queries/useSessions'
import { useReconnectingState } from '@/hooks/useReconnectingState'
import { reportSseConnected, reportSseDisconnected } from '@/lib/sseHealth'
import { noteSseDisconnected } from '@/lib/sseTelemetryObserver'
import { collectWindowInventory } from '@/lib/message-window-store'
import { recordSessionEntry } from '@/chat/sessionVisitTelemetry'
import { telemetryClient } from '@/lib/telemetryClient'
import { useSyncingState } from '@/hooks/useSyncingState'
import { pushNotificationsDisabled, usePushNotifications } from '@/hooks/usePushNotifications'
import { useViewportHeight } from '@/hooks/useViewportHeight'
import { useVisibilityReporter } from '@/hooks/useVisibilityReporter'
import { getAppSseResyncQueryKeys } from '@/lib/sseResync'
import { refreshAllAgyCatalogs } from '@/lib/agyCatalogAnnouncement'
import { AppContextProvider } from '@/lib/app-context'
import { activateMessageWindow, clearMessageWindow, recoverWindowAfterGapResume, rewindMessageWindow, syncTailMessages, windowNeedsReconcile } from '@/lib/message-window-store'
import { sessionHandshakeAction } from '@/lib/sessionStreamHandshake'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useSessionTailFallback } from '@/hooks/useSessionTailFallback'
import { useTranslation } from '@/lib/use-translation'
import { translateIncomingToast } from '@/lib/incoming-toast'
import { VoiceProvider } from '@/lib/voice-context'
import { requireHubUrlForLogin } from '@/lib/runtime-config'
import { getAppGlobalSseSubscription, getAppSessionSseSubscription } from '@/lib/appSseSubscriptions'
import { canUseAppBadging, useAppBadge } from '@/hooks/useAppBadge'
import { useAppBadgePreference } from '@/hooks/useAppBadgePreference'
import { reconcileQueuedStateAfterConnect } from '@/lib/queued-state-reconciliation'
import { LoginPrompt } from '@/components/LoginPrompt'
import { SessionActionErrorDialog } from '@/components/SessionActionErrorDialog'
import { InstallPrompt } from '@/components/InstallPrompt'
import { OfflineBanner } from '@/components/OfflineBanner'
import { PwaUpdateBanner, PwaUpdateBannerWithStatusOffset } from '@/components/PwaUpdateBanner'
import { SyncingBanner } from '@/components/SyncingBanner'
import { ReconnectingBanner } from '@/components/ReconnectingBanner'
import { VoiceErrorBanner } from '@/components/VoiceErrorBanner'
import { RunnerVersionSkewBanner } from '@/components/RunnerVersionSkewBanner'
import { LoadingState } from '@/components/LoadingState'
import { ToastContainer } from '@/components/ToastContainer'
import { PwaUpdateProvider } from '@/lib/pwa-update-context'
import { ToastProvider, useAddToast } from '@/lib/toast-context'
import { getNotificationClickHref, NOTIFICATION_CLICK_ACK_TYPE } from '@/lib/notificationClick'
import type { SyncEvent } from '@/types/api'

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>

const REQUIRE_SERVER_URL = requireHubUrlForLogin()
/** Matches the native apps: transient connection states show after 2s. */
const CONNECTION_STATUS_DELAY_MS = 2_000

function withPwaBanner(content: ReactNode) {
    return (
        <>
            <PwaUpdateBanner />
            {content}
        </>
    )
}

export function App() {
    return (
        <ToastProvider>
            <PwaUpdateProvider>
                <AppInner />
            </PwaUpdateProvider>
        </ToastProvider>
    )
}

function AppInner() {
    const { t } = useTranslation()
    const { serverUrl, baseUrl, setServerUrl, clearServerUrl } = useServerUrl()
    const { authSource, isLoading: isAuthSourceLoading, setAccessToken, setPasskeySession } = useAuthSource(baseUrl)
    const { token, api, isLoading: isAuthLoading, error: authError, needsBinding, bind, handleSseClosed } = useAuth(authSource, baseUrl)
    const [titleSuggestionAvailable, setTitleSuggestionAvailable] = useState(false)
    const goBack = useAppGoBack()
    const pathname = useLocation({ select: (location) => location.pathname })
    const matchRoute = useMatchRoute()
    const router = useRouter()
    const addToast = useAddToast()

    useEffect(() => {
        let cancelled = false
        setTitleSuggestionAvailable(false)
        if (!api) return () => { cancelled = true }

        void api.getHealth()
            .then((health) => {
                if (!cancelled) {
                    setTitleSuggestionAvailable(health.capabilities?.titleSuggestion === true)
                }
            })
            .catch(() => {
                if (!cancelled) setTitleSuggestionAvailable(false)
            })

        return () => {
            cancelled = true
        }
    }, [api])

    useEffect(() => {
        const tg = getTelegramWebApp()
        tg?.ready()
        tg?.expand()
        initializeTheme()
        initializeThemeColors()
        initializeChatSurfaceColors()
    }, [])

    useEffect(() => {
        if (!('serviceWorker' in navigator)) {
            return
        }

        const handleServiceWorkerMessage = (event: MessageEvent<unknown>) => {
            const href = getNotificationClickHref(event.data, window.location.origin)
            if (!href) return
            // Observation only (session_open entry): a SW notification click
            // that lands on a session page classifies the open as deep-link.
            try {
                const match = new URL(href, window.location.origin).pathname.match(/^\/(?:[^/]+\/)?sessions\/([^/?#]+)/)
                const targetSessionId = match?.[1]
                if (targetSessionId) {
                    recordSessionEntry(decodeURIComponent(targetSessionId), 'deep-link')
                }
            } catch {
                // fail-silent
            }
            const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`
            if (currentHref !== href) {
                router.history.push(href)
            }
            event.ports[0]?.postMessage({ type: NOTIFICATION_CLICK_ACK_TYPE })
        }

        navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage)
        return () => {
            navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage)
        }
    }, [router])

    // Track visual viewport height for mobile keyboard avoidance (see useViewportHeight.ts)
    useViewportHeight()

    useEffect(() => {
        const preventDefault = (event: Event) => {
            event.preventDefault()
        }

        const onWheel = (event: WheelEvent) => {
            if (event.ctrlKey) {
                event.preventDefault()
            }
        }

        const onKeyDown = (event: KeyboardEvent) => {
            const modifier = event.ctrlKey || event.metaKey
            if (!modifier) return
            if (event.key === '+' || event.key === '-' || event.key === '=' || event.key === '0') {
                event.preventDefault()
            }
        }

        document.addEventListener('gesturestart', preventDefault as EventListener, { passive: false })
        document.addEventListener('gesturechange', preventDefault as EventListener, { passive: false })
        document.addEventListener('gestureend', preventDefault as EventListener, { passive: false })

        window.addEventListener('wheel', onWheel, { passive: false })
        window.addEventListener('keydown', onKeyDown)

        return () => {
            document.removeEventListener('gesturestart', preventDefault as EventListener)
            document.removeEventListener('gesturechange', preventDefault as EventListener)
            document.removeEventListener('gestureend', preventDefault as EventListener)

            window.removeEventListener('wheel', onWheel)
            window.removeEventListener('keydown', onKeyDown)
        }
    }, [])

    useEffect(() => {
        const tg = getTelegramWebApp()
        const backButton = tg?.BackButton
        if (!backButton) return

        if (pathname === '/' || pathname === '/sessions') {
            backButton.offClick(goBack)
            backButton.hide()
            return
        }

        backButton.show()
        backButton.onClick(goBack)
        return () => {
            backButton.offClick(goBack)
            backButton.hide()
        }
    }, [goBack, pathname])
    const queryClient = useQueryClient()
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId' })
    const selectedSessionId = sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const { isSyncing, startSync, endSync } = useSyncingState()
    const {
        isReconnecting: sseDisconnected,
        reason: sseDisconnectReason,
        reportConnect: reportSseConnect,
        reportDisconnect: reportSseDisconnect
    } = useReconnectingState()
    const syncTokenRef = useRef(0)
    const isFirstConnectRef = useRef(true)
    const baseUrlRef = useRef(baseUrl)
    const pushPromptedRef = useRef(false)
    const { appBadgeEnabled: appBadgePreferenceEnabled } = useAppBadgePreference()
    const appBadgeEnabled = Boolean(api && token && appBadgePreferenceEnabled && canUseAppBadging())
    const {
        sessions: appBadgeSessions,
        isLoading: appBadgeSessionsLoading,
        error: appBadgeSessionsError,
    } = useSessions(api, { enabled: appBadgeEnabled })
    useAppBadge({
        enabled: appBadgeEnabled,
        scope: baseUrl,
        sessions: appBadgeSessions,
        isLoading: appBadgeSessionsLoading,
        hasError: Boolean(appBadgeSessionsError),
    })
    const { isSupported: isPushSupported, permission: pushPermission, subscribe } = usePushNotifications(api)

    useEffect(() => {
        if (baseUrlRef.current === baseUrl) {
            return
        }
        baseUrlRef.current = baseUrl
        isFirstConnectRef.current = true
        syncTokenRef.current = 0
        queryClient.clear()
    }, [baseUrl, queryClient])

    // Cold-start consolidator: one GET /api/bootstrap seeds the three
    // first-paint query caches (sessions slim list, machines, features) so
    // their mounted queries resolve from cache with zero extra round trips.
    // Each seed uses the exact payload shape of its standalone endpoint;
    // the queries' own fetches still run per their staleness rules and
    // simply find warm data instead of a cold network leg.
    const bootstrappedBaseUrlRef = useRef<string | null>(null)
    useEffect(() => {
        if (!api || !token || bootstrappedBaseUrlRef.current === baseUrlRef.current) return
        bootstrappedBaseUrlRef.current = baseUrlRef.current
        let cancelled = false
        void api.getBootstrap().then((payload) => {
            if (cancelled) return
            // Seed only into EMPTY caches: bootstrap is a large cold payload
            // that can land after the standalone GETs or live SSE patches
            // already resolved — a full replace would roll the cache back
            // and flash away applied patches/read states until the next
            // refetch. An empty-only seed keeps the warm-write direction
            // one-way (network/SSE always wins over the snapshot).
            queryClient.setQueryData(['sessions'], (prev: unknown) => prev ?? { sessions: payload.sessions })
            queryClient.setQueryData(['machines'], (prev: unknown) => prev ?? { machines: payload.machines })
            queryClient.setQueryData(['features'], (prev: unknown) => prev ?? payload.features)
        }).catch(() => {
            // A failed bootstrap leg is not fatal: the per-key queries fall
            // back to their own network fetches exactly as before.
            bootstrappedBaseUrlRef.current = null
        })
        return () => {
            cancelled = true
        }
    }, [api, token, queryClient])

    // Clean up URL params after successful auth (for direct access links)
    useEffect(() => {
        if (!token || !api) return
        const { pathname, search, hash, state } = router.history.location
        const searchParams = new URLSearchParams(search)
        if (!searchParams.has('server') && !searchParams.has('hub') && !searchParams.has('token')) {
            return
        }
        searchParams.delete('server')
        searchParams.delete('hub')
        searchParams.delete('token')
        const nextSearch = searchParams.toString()
        const nextHref = `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`
        router.history.replace(nextHref, state)
    }, [token, api, router])

    useEffect(() => {
        if (!api || !token) {
            pushPromptedRef.current = false
            return
        }
        if (isTelegramApp() || !isPushSupported) {
            return
        }
        if (pushPromptedRef.current) {
            return
        }
        pushPromptedRef.current = true

        const run = async () => {
            if (pushPermission === 'granted' && !pushNotificationsDisabled()) {
                await subscribe()
            }
        }

        void run()
    }, [api, isPushSupported, pushPermission, subscribe, token])

    const handleSseConnect = useCallback((info: SseConnectInfo) => {
        // Clear disconnected state on successful connection
        reportSseConnect()
        reportSseConnected()

        const isFirstConnect = isFirstConnectRef.current
        const invalidationKeys = getAppSseResyncQueryKeys(info, isFirstConnect)

        // The hub replayed every event missed during the gap, so the caches
        // are already consistent - the full refetch below would only re-download
        // what the replay just delivered. First connects and long gaps arrive
        // with resumed=false and take the resync path.
        if (invalidationKeys.length === 0) {
            return
        }

        // Increment token to track this specific connection
        const token = ++syncTokenRef.current

        // Only force show banner on first connect (page load)
        // Subsequent connects (session switches) use non-forced mode
        // which only shows banner when returning from background
        if (isFirstConnect) {
            isFirstConnectRef.current = false
            startSync({ force: true })
        } else {
            startSync()
        }
        const invalidations = [
            ...invalidationKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
            refreshAllAgyCatalogs(queryClient)
        ]
        const refreshMessages = (selectedSessionId && api)
            ? recoverWindowAfterGapResume(api, selectedSessionId)
            : Promise.resolve()
        Promise.all([...invalidations, refreshMessages])
            .catch((error) => {
                console.error('Failed to invalidate queries on SSE connect:', error)
            })
            .finally(() => {
                // Only end sync if this is still the latest connection
                if (syncTokenRef.current === token) {
                    endSync()
                }
            })
    }, [api, queryClient, selectedSessionId, startSync, endSync, reportSseConnect])

    const handleSseDisconnect = useCallback((reason: string) => {
        reportSseDisconnected()
        // Observation only (sse_anomaly disconnect + storm window, diag).
        try {
            noteSseDisconnected('global', reason, document.hidden)
        } catch {
            // fail-silent
        }
        // Only show reconnecting banner if we've already connected once
        if (!isFirstConnectRef.current) {
            reportSseDisconnect(reason)
        }
        if (reason === 'closed') {
            handleSseClosed()
        }
    }, [handleSseClosed, reportSseDisconnect])

    const handleSseEvent = useCallback((event: SyncEvent) => {
        if (event.type !== 'messages-invalidated') {
            return
        }
        if (!api || event.sessionId !== selectedSessionId) {
            return
        }
        if (event.reason === 'rewind' && event.truncateFromLocalId) {
            rewindMessageWindow(event.sessionId, event.truncateFromLocalId)
        } else {
            clearMessageWindow(event.sessionId)
            // Rebuilt from its first page's twenty rows with the stream already
            // connected: nothing would ask for the page behind them otherwise.
            activateMessageWindow(event.sessionId, { reconcileAfterFirstPage: true })
        }
        void syncTailMessages(api, event.sessionId)
    }, [api, selectedSessionId])

    const handleSessionSseConnect = useCallback((info: SseConnectInfo) => {
        if (!api || !selectedSessionId) {
            return
        }
        const action = sessionHandshakeAction(info, selectedSessionId, windowNeedsReconcile(selectedSessionId))
        if (action === 'ignore' || action === 'nothing') {
            return
        }
        if (action === 'queued-state') {
            // The stream's first connection, the open having reconciled by
            // itself (or doing so): only the queued-state snapshot is still
            // this connection's to check, and it needs no tail sync first.
            void reconcileQueuedStateAfterConnect(api, selectedSessionId, { sync: false }).catch((error) => {
                console.error('Failed to reconcile queued state after SSE connect:', error)
            })
            return
        }
        recoverWindowAfterGapResume(api, selectedSessionId).catch((error) => {
            console.error('Failed to recover the message window after an SSE gap:', error)
        })
        void reconcileQueuedStateAfterConnect(api, selectedSessionId).catch((error) => {
            console.error('Failed to reconcile queued state after SSE connect:', error)
        })
    }, [api, selectedSessionId])

    // Observation only (sse_anomaly disconnect + storm for the session-scoped
    // connection): telemetry has no banner/error side effects, so unlike the
    // global handler above it does not participate in reconnecting state.
    const handleSessionSseDisconnect = useCallback((reason: string) => {
        try {
            noteSseDisconnected('full', reason, document.hidden)
        } catch {
            // fail-silent
        }
    }, [])

    const handleToast = useCallback((event: ToastEvent) => {
        const localized = translateIncomingToast(event.data.title, event.data.body, t)
        addToast({
            title: localized.title,
            body: localized.body,
            sessionId: event.data.sessionId,
            url: event.data.url
        })
    }, [addToast, t])

    const globalEventSubscription = useMemo(() => getAppGlobalSseSubscription(), [])
    const sessionEventSubscription = useMemo(
        () => getAppSessionSseSubscription(selectedSessionId),
        [selectedSessionId]
    )
    // Ingest the selected session's messages from the global stream and keep
    // its tail converging while the session-scoped EventSource is down
    // (reconnect backoff, hidden tab, mobile backgrounding).
    const handleGlobalSessionEvent = useSessionTailFallback({ api, sessionId: selectedSessionId, queryClient })
    const sseEnabled = Boolean(api && token)
    const showReconnectingBanner = sseDisconnected && !isSyncing
    // Transient states wait before showing; quick reconnects never flash.
    const revealReconnecting = useDelayedFlag(showReconnectingBanner, CONNECTION_STATUS_DELAY_MS)
    const revealSyncing = useDelayedFlag(isSyncing, CONNECTION_STATUS_DELAY_MS)

    const { subscriptionId: globalSubscriptionId, subscriptionVisibility: globalSubscriptionVisibility } = useSSE({
        enabled: sseEnabled,
        token: token ?? '',
        baseUrl,
        subscription: globalEventSubscription,
        scope: 'global',
        onConnect: handleSseConnect,
        onDisconnect: handleSseDisconnect,
        onEvent: handleGlobalSessionEvent,
        onToast: handleToast
    })

    const { subscriptionId: sessionSubscriptionId, subscriptionVisibility: sessionSubscriptionVisibility } = useSSE({
        enabled: sseEnabled && Boolean(sessionEventSubscription),
        token: token ?? '',
        baseUrl,
        subscription: sessionEventSubscription ?? undefined,
        scope: 'full',
        onConnect: handleSessionSseConnect,
        onDisconnect: handleSessionSseDisconnect,
        onEvent: handleSseEvent
    })

    useVisibilityReporter({
        api,
        subscriptionId: globalSubscriptionId,
        declaredVisibility: globalSubscriptionVisibility,
        enabled: sseEnabled
    })

    useVisibilityReporter({
        api,
        subscriptionId: sessionSubscriptionId,
        declaredVisibility: sessionSubscriptionVisibility,
        enabled: sseEnabled && Boolean(sessionEventSubscription)
    })

    // Observation only (client_window_inventory, ux): snapshot the
    // message-window cache on a 30-minute cadence plus each local-midnight
    // rollover, so day buckets line up with server-side daily rollups.
    // Windows are capped at the schema's 128 entries inside the collector.
    useEffect(() => {
        const emit = () => {
            try {
                telemetryClient.capture('ux', 'client_window_inventory', collectWindowInventory())
            } catch {
                // fail-silent
            }
        }
        const msUntilNextMidnight = () => {
            const now = new Date()
            const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
            return Math.max(1_000, next.getTime() - now.getTime())
        }
        const interval = window.setInterval(emit, 30 * 60 * 1000)
        let midnightTimer: number | null = null
        const scheduleMidnight = () => {
            midnightTimer = window.setTimeout(() => {
                midnightTimer = null
                emit()
                scheduleMidnight()
            }, msUntilNextMidnight())
        }
        scheduleMidnight()
        return () => {
            window.clearInterval(interval)
            if (midnightTimer !== null) {
                window.clearTimeout(midnightTimer)
            }
        }
    }, [])

    // Loading auth source
    if (isAuthSourceLoading) {
        return withPwaBanner(
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label={t('loading')} className="text-sm" />
            </div>,
        )
    }

    // No auth source (browser environment, not logged in)
    if (!authSource) {
        return withPwaBanner(
            <LoginPrompt
                onLogin={setAccessToken}
                onPasskeyLogin={setPasskeySession}
                baseUrl={baseUrl}
                serverUrl={serverUrl}
                setServerUrl={setServerUrl}
                clearServerUrl={clearServerUrl}
                requireServerUrl={REQUIRE_SERVER_URL}
            />,
        )
    }

    if (needsBinding) {
        return withPwaBanner(
            <LoginPrompt
                mode="bind"
                onBind={bind}
                baseUrl={baseUrl}
                serverUrl={serverUrl}
                setServerUrl={setServerUrl}
                clearServerUrl={clearServerUrl}
                requireServerUrl={REQUIRE_SERVER_URL}
                error={authError ?? undefined}
            />,
        )
    }

    // Authenticating (also covers the gap before useAuth effect starts)
    if (isAuthLoading || (authSource && !token && !authError)) {
        return withPwaBanner(
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label={t('authorizing')} className="text-sm" />
            </div>,
        )
    }

    // Auth error
    if (authError || !token || !api) {
        // If using an access token or passkey and auth failed, show login again
        if (authSource.type === 'accessToken' || authSource.type === 'passkey') {
            return withPwaBanner(
                <LoginPrompt
                    onLogin={setAccessToken}
                    onPasskeyLogin={setPasskeySession}
                    baseUrl={baseUrl}
                    serverUrl={serverUrl}
                    setServerUrl={setServerUrl}
                    clearServerUrl={clearServerUrl}
                    requireServerUrl={REQUIRE_SERVER_URL}
                    error={authError ?? t('login.error.authFailed')}
                />,
            )
        }

        // Telegram auth failed
        return withPwaBanner(
            <div className="p-4 space-y-3">
                <div className="text-base font-semibold">{t('login.title')}</div>
                <div className="text-sm text-red-600">
                    {authError ?? t('login.error.authFailed')}
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    Open this page from Telegram using the bot's "Open App" button (not "Open in browser").
                </div>
            </div>,
        )
    }

    return (
        <AppContextProvider value={{ api, token, baseUrl, titleSuggestionAvailable }}>
            <VoiceProvider>
                <PwaUpdateBannerWithStatusOffset
                    isSyncing={revealSyncing}
                    isReconnecting={revealReconnecting}
                />
                <SyncingBanner isSyncing={revealSyncing} />
                <ReconnectingBanner
                    isReconnecting={revealReconnecting}
                    reason={sseDisconnectReason}
                />
                <VoiceErrorBanner />
                <OfflineBanner
                    isHubConnected={globalSubscriptionId !== null}
                    isReconnecting={showReconnectingBanner}
                />
                <RunnerVersionSkewBanner />
                <div className="h-full min-h-0 flex flex-col">
                    <Outlet />
                </div>
                <ToastContainer />
                <SessionActionErrorDialog />
                <InstallPrompt />
            </VoiceProvider>
        </AppContextProvider>
    )
}
