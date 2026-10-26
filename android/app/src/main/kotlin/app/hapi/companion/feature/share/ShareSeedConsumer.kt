package app.hapi.companion.feature.share

import android.net.Uri
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import app.hapi.companion.R
import app.hapi.companion.di.LocalAppGraph
import app.hapi.companion.feature.chat.ChatViewModel
import app.hapi.companion.feature.chat.attachments.AttachmentPreparer
import app.hapi.companion.feature.chat.attachments.PrepareResult

/**
 * Consumes the AppGraph's armed [ArmedShareSeed] inside its target chat
 * (slice A) — the native twin of the web ShareSeedConsumer: once the session
 * is active, seed the composer with the share text, push each file through
 * the existing attachment pipeline, and drop the seed.
 *
 * Gating differs from web deliberately: web waits for `sessionActive`; here
 * the seed also waits for the async draft restore to settle, so a restored
 * draft can never clobber a seeded paragraph.
 */
@Composable
internal fun ShareSeedConsumer(viewModel: ChatViewModel, snackbar: SnackbarHostState) {
    val appGraph = LocalAppGraph.current
    val context = LocalContext.current
    val preparer = remember { AttachmentPreparer(context.applicationContext) }

    val draftsRestored by viewModel.draftsRestored.collectAsState()
    val uiState by viewModel.uiState.collectAsState()
    val sessionActive = uiState.header.active
    val armed by appGraph.pendingShareSeed.collectAsState()

    LaunchedEffect(armed, draftsRestored, sessionActive) {
        val seed = armed ?: return@LaunchedEffect
        if (seed.sessionId != viewModel.sessionId) return@LaunchedEffect
        if (!draftsRestored || !sessionActive) return@LaunchedEffect
        // Consume first: a failure below must not retry forever (the web
        // deletes its transfer after one ingest pass, unreadable files and all).
        appGraph.pendingShareSeed.value = null

        val seedText = seed.share.seedText()
        if (seedText.isNotEmpty()) viewModel.appendComposerParagraph(seedText)
        for (uriString in seed.share.streamUris) {
            when (val result = preparer.prepare(Uri.parse(uriString))) {
                is PrepareResult.Ready -> viewModel.attachments.add(result.attachment)
                is PrepareResult.TooLarge -> snackbar.showSnackbar(
                    context.getString(R.string.chat_notice_attachment_too_large, result.filename),
                )
                is PrepareResult.Unreadable -> snackbar.showSnackbar(
                    context.getString(R.string.chat_notice_attachment_unreadable, result.filename),
                )
            }
        }
    }
}
