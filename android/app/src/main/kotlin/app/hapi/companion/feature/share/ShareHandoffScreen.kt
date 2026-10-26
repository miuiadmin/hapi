package app.hapi.companion.feature.share

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.di.AppGraph
import app.hapi.companion.di.HubGraph
import app.hapi.companion.di.LocalAppGraph
import app.hapi.companion.feature.sessions.SessionListViewModel
import app.hapi.companion.feature.settings.UsageMath
import app.hapi.protocol.wire.SessionSummary
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Hand-off picker for a system share (slice A), the native twin of the web
 * `/share` route: content preview on top, session search + recent active
 * list below, "New session" at the end. Picking arms the AppGraph's
 * [ArmedShareSeed] and navigation opens that chat, where ShareSeedConsumer
 * seeds the composer once the session is live.
 */
internal class ShareHandoffViewModel(
    private val appGraph: AppGraph,
    private val hubGraph: HubGraph,
    appContext: Context,
    private val scope: CoroutineScope,
) {
    /** Provider metadata for one previewed file (best-effort; nulls allowed). */
    data class ShareFileHint(val uri: String, val name: String?, val sizeBytes: Long?, val mime: String?)

    data class UiState(
        val payload: ShareHandoff? = null,
        val loading: Boolean = false,
        val query: String = "",
        val sessions: List<SessionSummary> = emptyList(),
        val machineLabels: Map<String, String> = emptyMap(),
        val fileHints: List<ShareFileHint> = emptyList(),
    )

    private val resolver = appContext.contentResolver
    private val state = MutableStateFlow(UiState())
    val uiState = state.asStateFlow()

    init {
        adoptPendingShare()
        refresh()
    }

    /** Take whatever MainActivity stashed; null means no hand-off (dead slot). */
    private fun adoptPendingShare() {
        val share = appGraph.pendingShare.value ?: return
        appGraph.pendingShare.value = null
        state.update { it.copy(payload = share) }
        loadFileHints(share)
    }

    /**
     * A second share arrived while this picker was already open: replace the
     * payload in place (web reloads /share with the new id).
     */
    fun adoptReplacement() {
        val share = appGraph.pendingShare.value ?: return
        appGraph.pendingShare.value = null
        if (share == state.value.payload) return
        state.update { it.copy(payload = share, fileHints = emptyList()) }
        loadFileHints(share)
    }

    /** One-shot live snapshot (web mounts onto the live store; we refresh on open). */
    fun refresh() {
        state.update { it.copy(loading = true) }
        scope.launch {
            runCatching { hubGraph.sessionStore.refresh() }
            // Machine labels must be live too: a cold start straight into the
            // share flow would otherwise label rows with raw machine ids (the
            // web picker fetches machines live: useMachines(api, true)).
            runCatching { hubGraph.machineStore.refresh() }
            val snapshot = sharePickerSnapshot(hubGraph.sessionStore.sessions.value)
            val labels = hubGraph.machineStore.machines.value.mapNotNull { machine ->
                val metadata = machine.metadata ?: return@mapNotNull null
                val name = metadata.displayName?.trim()?.takeIf { it.isNotEmpty() }
                    ?: metadata.host.trim().takeIf { it.isNotEmpty() }
                name?.let { machine.id to it }
            }.toMap()
            state.update { it.copy(loading = false, sessions = snapshot, machineLabels = labels) }
        }
    }

    fun setQuery(query: String) {
        state.update { it.copy(query = query) }
    }

    /** Arm the seed for an existing session; the screen then navigates. */
    fun pick(sessionId: String) {
        val payload = state.value.payload ?: return
        appGraph.pendingShareSeed.value = ArmedShareSeed(sessionId, payload)
        // Hygiene: any payload parked for the new-session form is superseded
        // by this direct pick (can only happen across two share rounds).
        appGraph.pendingNewSessionShare.value = null
    }

    /** Hand the payload to the new-session form; the screen then navigates. */
    fun beginNewSession() {
        val payload = state.value.payload ?: return
        appGraph.pendingNewSessionShare.value = payload
    }

    /** Drop the hand-off entirely (web: delete transfer, back). */
    fun discard() {
        appGraph.pendingShare.value = null
        appGraph.pendingNewSessionShare.value = null
        state.update { it.copy(payload = null) }
    }

    private fun loadFileHints(share: ShareHandoff) {
        if (share.streamUris.isEmpty()) return
        scope.launch(Dispatchers.IO) {
            val hints = share.streamUris.map(::queryFileHint)
            // A replacement may have landed while we queried.
            if (state.value.payload == share) state.update { it.copy(fileHints = hints) }
        }
    }

    private fun queryFileHint(uriString: String): ShareFileHint {
        val uri = Uri.parse(uriString)
        var name: String? = null
        var size: Long? = null
        runCatching {
            resolver.query(uri, null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
                }
            }
        }
        return ShareFileHint(
            uri = uriString,
            name = name ?: uri.lastPathSegment,
            sizeBytes = size,
            mime = runCatching { resolver.getType(uri) }.getOrNull(),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ShareHandoffScreen(
    viewModel: ShareHandoffViewModel,
    onBack: () -> Unit,
    onPick: (String) -> Unit,
    onNewSession: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val appGraph = LocalAppGraph.current

    // A second share while the picker is open swaps the payload in place.
    val pendingShare by appGraph.pendingShare.collectAsState()
    LaunchedEffect(pendingShare) {
        if (pendingShare != null) viewModel.adoptReplacement()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.share_title)) },
                navigationIcon = {
                    // Back and Discard are the same act (web discards on
                    // back); the arrow is the affordance.
                    IconButton(onClick = { viewModel.discard(); onBack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.share_back))
                    }
                },
            )
        },
    ) { padding ->
        val payload = state.payload
        if (payload == null) {
            MissingHandoff(onBack)
            return@Scaffold
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.share_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            SharePreviewCard(payload, state.fileHints)
            OutlinedTextField(
                value = state.query,
                onValueChange = viewModel::setQuery,
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text(stringResource(R.string.sessions_search_hint)) },
                trailingIcon = {
                    if (state.query.isNotEmpty()) {
                        IconButton(onClick = { viewModel.setQuery("") }) {
                            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.sessions_search_clear))
                        }
                    }
                },
                singleLine = true,
            )
            SessionPickerList(
                state = state,
                onPick = { sessionId ->
                    viewModel.pick(sessionId)
                    onPick(sessionId)
                },
                onNewSession = {
                    viewModel.beginNewSession()
                    onNewSession()
                },
            )
        }
    }
}

@Composable
private fun MissingHandoff(onBack: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(stringResource(R.string.share_not_found_title), style = MaterialTheme.typography.titleMedium)
        Text(
            stringResource(R.string.share_not_found_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(onClick = onBack) { Text(stringResource(R.string.share_back_to_sessions)) }
    }
}

/** Content summary: text snippet and/or file list (web SharePreview). */
@Composable
private fun SharePreviewCard(payload: ShareHandoff, fileHints: List<ShareHandoffViewModel.ShareFileHint>) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val seed = payload.seedText()
            if (seed.isNotEmpty()) {
                Text(
                    stringResource(R.string.share_preview_text),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    seed,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            } else if (payload.streamUris.isEmpty()) {
                Text(
                    stringResource(R.string.share_preview_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (payload.streamUris.isNotEmpty()) {
                val count = payload.streamUris.size
                val countLabel = if (count == 1) stringResource(R.string.share_preview_files_one)
                else stringResource(R.string.share_preview_files_many, count)
                Text(
                    countLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                // First three names, each with size when the provider states it.
                fileHints.take(3).forEach { hint ->
                    val label = hint.name ?: hint.uri
                    val detail = listOfNotNull(
                        hint.sizeBytes?.let { UsageMath.formatBytes(it) },
                        hint.mime,
                    ).joinToString(" · ").ifEmpty { null }
                    Text(
                        if (detail == null) label else "$label — $detail",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun SessionPickerList(
    state: ShareHandoffViewModel.UiState,
    onPick: (String) -> Unit,
    onNewSession: () -> Unit,
) {
    val unknownMachine = stringResource(R.string.sessions_filter_unknown_machine)
    val machineLabelOf = remember(state.machineLabels, unknownMachine) {
        { machineId: String? ->
            state.machineLabels[machineId] ?: machineId?.take(8) ?: unknownMachine
        }
    }
    val visible = remember(state.sessions, state.query, machineLabelOf) {
        SharePickerSessions.filterSessions(state.sessions, state.query, machineLabelOf = machineLabelOf)
    }

    if (state.loading && state.sessions.isEmpty()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(modifier = Modifier.padding(start = 4.dp))
            Text(
                stringResource(R.string.share_loading),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    val searching = state.query.isNotBlank()
    Text(
        stringResource(if (searching) R.string.share_search_results else R.string.share_recent_sessions),
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
    )

    if (visible.isEmpty()) {
        Text(
            stringResource(
                if (searching) R.string.share_no_search_results else R.string.share_no_active_sessions,
            ),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    } else {
        visible.forEach { summary ->
            SessionPickRow(
                title = SessionListViewModel.sessionTitle(summary),
                secondary = listOfNotNull(
                    SessionListViewModel.projectLabel(summary),
                    machineLabelOf(summary.metadata?.machineId).takeIf { summary.metadata?.machineId != null },
                ).joinToString(" · ").ifEmpty { null },
                onClick = { onPick(summary.id) },
            )
        }
        if (!searching) {
            SharePickerSessions.countHiddenActiveSessions(state.sessions, state.query).takeIf { it > 0 }?.let { hidden ->
                Text(
                    if (hidden == 1) stringResource(R.string.share_search_for_more_one)
                    else stringResource(R.string.share_search_for_more_many, hidden),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    SessionPickRow(
        title = stringResource(R.string.share_new_session),
        secondary = null,
        leading = { Icon(Icons.Default.Add, contentDescription = null) },
        onClick = onNewSession,
    )
}

@Composable
private fun SessionPickRow(
    title: String,
    secondary: String?,
    onClick: () -> Unit,
    leading: (@Composable () -> Unit)? = null,
) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            leading?.invoke()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (secondary != null) {
                    Text(
                        secondary,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}
