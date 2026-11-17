import { describe, expect, it } from 'bun:test'
import { cacheControlForRequestPath, serveEmbeddedAsset } from './server'
import type { EmbeddedWebAsset } from './embeddedAssets'

function asset(path: string, mimeType: string): EmbeddedWebAsset {
    return { path, sourcePath: '/dev/null', mimeType } as EmbeddedWebAsset
}

describe('serveEmbeddedAsset cache policy', () => {
    it('caches content-hashed /assets/ bundles immutably for a year', () => {
        for (const [path, mimeType] of [
            ['/assets/index-RPnKyNwb.js', 'application/javascript; charset=utf-8'],
            ['/assets/index-B2c9x1qD.css', 'text/css; charset=utf-8'],
            ['/assets/architectureDiagram-Q4EWVU46-CQKiqRiS.js', 'application/javascript; charset=utf-8']
        ] as const) {
            const headers = serveEmbeddedAsset(asset(path, mimeType)).headers
            expect(headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
        }
    })

    it('bounds caching for the non-hashed KaTeX fonts under /assets/fonts/', () => {
        // copyKaTeXFonts emits original (non-content-hashed) names, so these
        // are the one /assets/ family that must never be immutable. Includes
        // the "BoldItalic" name that would defeat a naive hash-suffix regex.
        for (const path of [
            '/assets/fonts/KaTeX_Main-Regular.woff2',
            '/assets/fonts/KaTeX_Math-BoldItalic.woff2',
            '/assets/fonts/KaTeX_Typewriter-Regular.ttf'
        ]) {
            expect(cacheControlForRequestPath(path)).toBe('public, max-age=86400')
            const headers = serveEmbeddedAsset(asset(path, 'font/woff2')).headers
            expect(headers.get('Cache-Control')).toBe('public, max-age=86400')
        }
    })

    it('keeps the service worker strictly uncacheable', () => {
        const headers = serveEmbeddedAsset(asset('/sw.js', 'application/javascript; charset=utf-8')).headers
        expect(headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate')
        expect(headers.get('CDN-Cache-Control')).toBe('no-store')
        expect(headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store')
    })

    it('forces revalidation for the HTML shell so stale indexes cannot pin retired bundles', () => {
        for (const path of ['/', '/index.html', '/404.html']) {
            expect(cacheControlForRequestPath(path)).toBe('no-cache')
        }
        for (const path of ['/index.html', '/404.html']) {
            const headers = serveEmbeddedAsset(asset(path, 'text/html; charset=utf-8')).headers
            expect(headers.get('Cache-Control')).toBe('no-cache')
        }
    })

    it('leaves other root files without an explicit cache policy', () => {
        const headers = serveEmbeddedAsset(asset('/manifest.webmanifest', 'application/manifest+json')).headers
        expect(headers.get('Cache-Control')).toBeNull()
    })
})
