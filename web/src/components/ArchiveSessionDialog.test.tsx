import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider, useToast } from '@/lib/toast-context'
import { ArchiveSessionDialog } from './ArchiveSessionDialog'

afterEach(cleanup)

function pendingArchive() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

function Harness(props: { active: boolean; confirm: () => Promise<void>; unmountOnClose?: boolean }) {
    const [open, setOpen] = useState(true)
    const [pending, setPending] = useState(false)
    const { toasts } = useToast()
    return <>
        {open || !props.unmountOnClose ? <ArchiveSessionDialog
            isOpen={open} onClose={() => setOpen(false)}
            sessionId="session-1" sessionName="My session" active={props.active}
            isPending={pending} onConfirm={async () => {
                setPending(true)
                try { await props.confirm() } finally { setPending(false) }
            }}
        /> : null}
        {toasts.map(toast => <div key={toast.id} role="alert">{toast.title}: {toast.body}</div>)}
    </>
}

function view(active: boolean, confirm: () => Promise<void>, unmountOnClose = false) {
    return <StrictMode><I18nProvider><ToastProvider>
        <Harness active={active} confirm={confirm} unmountOnClose={unmountOnClose} />
    </ToastProvider></I18nProvider></StrictMode>
}

describe('ArchiveSessionDialog', () => {
    it('shows cleanup progress after inactive SSE and still waits for HTTP success', async () => {
        const archive = pendingArchive()
        const confirm = vi.fn(() => archive.promise)
        const rendered = render(view(true, confirm))
        fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
        expect(screen.getByRole('button', { name: 'Archiving…' })).toBeDisabled()
        expect(screen.getByText(/Archiving this session\. You can close this window/)).toBeVisible()
        expect(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })).toHaveLength(2)
        rendered.rerender(view(false, confirm))
        expect(screen.getByText(/Session disconnected\. Confirming archive/)).toBeVisible()
        expect(screen.getByRole('button', { name: 'Confirming cleanup…' })).toBeDisabled()
        expect(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]).toBeEnabled()
        expect(confirm).toHaveBeenCalledTimes(1)
        await act(async () => archive.resolve())
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it.each([
        { active: true, unmountOnClose: false },
        { active: true, unmountOnClose: true },
        { active: false, unmountOnClose: false },
        { active: false, unmountOnClose: true },
    ])('leaves a failure after dismissal to the app dialog, never a toast (active=$active, unmount=$unmountOnClose)', async ({ active, unmountOnClose }) => {
        const archive = pendingArchive()
        const confirm = vi.fn(() => archive.promise)
        const rendered = render(view(true, confirm, unmountOnClose))
        fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
        rendered.rerender(view(active, confirm, unmountOnClose))
        expect(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })).toHaveLength(2)
        fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]!)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        await act(async () => archive.reject(new Error('Session process is still running')))
        expect(confirm).toHaveBeenCalledTimes(1)
        // The row looked archived from the click on; the mutation reports the failure to the app's dialog host.
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it.each([true, false])('keeps the archive running after closing (active=%s)', async active => {
        const archive = pendingArchive()
        const confirm = vi.fn(() => archive.promise)
        render(view(active, confirm))
        fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
        const dialog = screen.getByRole('dialog')
        const closeButtons = within(dialog).getAllByRole('button', { name: 'Close' })
        expect(closeButtons).toHaveLength(2)
        fireEvent.click(closeButtons[0]!)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(confirm).toHaveBeenCalledTimes(1)
        await act(async () => archive.resolve())
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('closes on a failed archive without showing the error itself: the app dialog reports it', async () => {
        const archive = pendingArchive()
        const confirm = vi.fn(() => archive.promise)
        render(view(false, confirm))
        fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
        await act(async () => archive.reject(new Error('Stop not confirmed')))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
})
