package app.hapi.companion.feature.chat

import app.hapi.protocol.catalog.PermissionMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Display rule for the persistent permission-mode chip — mirrors the web
 * StatusBar predicate (StatusBar.tsx:253-261).
 */
class PermissionModeChipTest {

    @Test fun defaultHidesEverywhereExceptCopilot() {
        assertNull(PermissionModeChipRule.displayMode("default", "claude"))
        assertNull(PermissionModeChipRule.displayMode("default", "codex"))
        assertNull(PermissionModeChipRule.displayMode("default", null))
        assertEquals(PermissionMode.Default, PermissionModeChipRule.displayMode("default", "copilot"))
    }

    @Test fun nonDefaultModeShowsWhenTheFlavorOffersIt() {
        assertEquals(PermissionMode.AcceptEdits, PermissionModeChipRule.displayMode("acceptEdits", "claude"))
        assertEquals(PermissionMode.ReadOnly, PermissionModeChipRule.displayMode("read-only", "codex"))
        assertEquals(PermissionMode.Plan, PermissionModeChipRule.displayMode("plan", null))
        assertEquals(PermissionMode.AlwaysProceed, PermissionModeChipRule.displayMode("always-proceed", "agy"))
    }

    @Test fun modeOutsideTheFlavorListHides() {
        // acceptEdits is claude-only; a stale value on a codex session hides.
        assertNull(PermissionModeChipRule.displayMode("acceptEdits", "codex"))
        assertNull(PermissionModeChipRule.displayMode("read-only", "claude"))
    }

    @Test fun piAndDshOfferNoModesSoTheChipNeverShows() {
        assertNull(PermissionModeChipRule.displayMode("acceptEdits", "pi"))
        assertNull(PermissionModeChipRule.displayMode("default", "pi"))
        assertNull(PermissionModeChipRule.displayMode("yolo", "dsh"))
    }

    @Test fun unknownWireIdAndNullModeHide() {
        assertNull(PermissionModeChipRule.displayMode("future-mode", "claude"))
        assertNull(PermissionModeChipRule.displayMode(null, "claude"))
        assertNull(PermissionModeChipRule.displayMode("", "copilot"))
    }

    @Test fun safeYoloShowsOnTheChipEvenThoughTheSwitcherFiltersIt() {
        // The concurrent-clients carve-out (buildConfigUi) narrows the
        // switcher only; the chip consults the unfiltered flavor catalog,
        // like the web span.
        assertEquals(PermissionMode.SafeYolo, PermissionModeChipRule.displayMode("safe-yolo", "codex"))
    }
}
