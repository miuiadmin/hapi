package app.hapi.companion.feature.settings

import android.os.Build
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import app.hapi.companion.BuildConfig
import app.hapi.companion.R
import app.hapi.protocol.wire.SUPPORTED_PROTOCOL_VERSION
import app.hapi.protocol.wire.TranscriptionProviderInfo
import app.hapi.protocol.wire.UpdateHubSettingsRequest

/**
 * General subpage of the settings hub (P2 IA): the catch-all category for
 * everything without a dedicated category on this branch — Appearance (theme
 * mode + Material You), Language, Dictation (provider + language when the hub
 * offers standard transcription), the Machines entry, the owner-only hub
 * switches (web Settings → General parity: session summaries, per-turn title
 * rewrite and peer-session tools where the hub speaks the fork extension),
 * and About (app/protocol versions + hub health). The former owner-only
 * Usage/Storage rows moved hub-level (see [SettingsHubCatalog]); their owner
 * gate is unchanged.
 */
@Composable
fun SettingsGeneralScreen(
    viewModel: SettingsViewModel,
    dictation: DictationSettingsViewModel,
    onOpenMachines: () -> Unit,
    onBack: () -> Unit,
) {
    val theme by viewModel.themeSettings.collectAsState()
    val language by viewModel.language.collectAsState()
    val isOwner by viewModel.isOwner.collectAsState()
    val hubInfo by viewModel.hubInfo.collectAsState()
    val hubSettings by viewModel.hubSettings.collectAsState()
    val hubSettingsSaveError by viewModel.hubSettingsSaveError.collectAsState()
    val dictationState by dictation.state.collectAsState()

    LaunchedEffect(dictation) { dictation.start() }

    SettingsGeneralContent(
        theme = theme,
        language = language,
        hubUrl = viewModel.hubUrl,
        hubInfo = hubInfo,
        isOwner = isOwner,
        hubSettings = hubSettings,
        hubSettingsSaveError = hubSettingsSaveError,
        onUpdateHubSettings = viewModel::updateHubSettings,
        dictationState = dictationState,
        onSetDictationProvider = dictation::setProvider,
        onSetDictationLanguage = dictation::setLanguage,
        onOpenMachines = onOpenMachines,
        onSetThemeMode = viewModel::setThemeMode,
        onSetDynamicColor = viewModel::setDynamicColor,
        onSetLanguage = viewModel::setLanguage,
        onRetryHubInfo = viewModel::retryHubInfo,
        onBack = onBack,
    )
}

/** State-injected body of [SettingsGeneralScreen] — previewable without a VM. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsGeneralContent(
    theme: ThemeSettings,
    language: AppLanguage,
    hubUrl: String,
    hubInfo: HubInfoState,
    isOwner: Boolean,
    hubSettings: HubSettingsState?,
    hubSettingsSaveError: String?,
    onUpdateHubSettings: (UpdateHubSettingsRequest) -> Unit,
    dictationState: DictationSettingsUiState,
    onSetDictationProvider: (String) -> Unit,
    onSetDictationLanguage: (String?) -> Unit,
    onOpenMachines: () -> Unit,
    onSetThemeMode: (ThemeMode) -> Unit,
    onSetDynamicColor: (Boolean) -> Unit,
    onSetLanguage: (AppLanguage) -> Unit,
    onRetryHubInfo: () -> Unit,
    onBack: () -> Unit,
) {
    var showThemeDialog by rememberSaveable { mutableStateOf(false) }
    var showLanguageDialog by rememberSaveable { mutableStateOf(false) }
    var showDictationProviderDialog by rememberSaveable { mutableStateOf(false) }
    var showDictationLanguageDialog by rememberSaveable { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_category_general)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.settings_back),
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SettingsSection(title = stringResource(R.string.settings_section_appearance)) {
                SettingsRow(
                    label = stringResource(R.string.settings_theme),
                    value = stringResource(themeModeLabelRes(theme.mode)),
                    onClick = { showThemeDialog = true },
                )
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    SettingsDivider()
                    SwitchRow(
                        label = stringResource(R.string.settings_dynamic_color),
                        description = stringResource(
                            if (theme.mode == ThemeMode.OLED) R.string.settings_dynamic_color_oled_note
                            else R.string.settings_dynamic_color_description
                        ),
                        checked = theme.dynamicColor && theme.mode != ThemeMode.OLED,
                        enabled = theme.mode != ThemeMode.OLED,
                        onCheckedChange = onSetDynamicColor,
                    )
                }
            }

            SettingsSection(title = stringResource(R.string.settings_section_language)) {
                SettingsRow(
                    label = stringResource(R.string.settings_language),
                    value = languageLabel(language),
                    onClick = { showLanguageDialog = true },
                )
            }

            if (isOwner && hubSettings is HubSettingsState.Loaded) {
                val settings = (hubSettings as HubSettingsState.Loaded).settings

                // Web twin: settings/general.tsx — sections render only when
                // the query has data; the fork's extra fields are absent on
                // upstream hubs (null ⇒ hide, matching upstream web).
                SettingsSection(title = stringResource(R.string.settings_section_summaries)) {
                    SwitchRow(
                        label = stringResource(R.string.settings_summary_contract),
                        description = stringResource(R.string.settings_summary_contract_desc),
                        checked = settings.sessionSummaryContract,
                        enabled = true,
                        onCheckedChange = { checked ->
                            onUpdateHubSettings(
                                UpdateHubSettingsRequest(sessionSummaryContract = checked),
                            )
                        },
                    )
                    SettingsDivider()
                    SwitchRow(
                        label = stringResource(R.string.settings_summary_in_chat),
                        description = stringResource(R.string.settings_summary_in_chat_desc),
                        checked = settings.sessionSummaryInChat,
                        enabled = true,
                        onCheckedChange = { checked ->
                            onUpdateHubSettings(
                                UpdateHubSettingsRequest(sessionSummaryInChat = checked),
                            )
                        },
                    )
                }

                settings.autoTitlePerTurn?.let { autoTitle ->
                    SettingsSection(title = stringResource(R.string.settings_section_titles)) {
                        SwitchRow(
                            label = stringResource(R.string.settings_auto_title_per_turn),
                            description = stringResource(R.string.settings_auto_title_per_turn_desc),
                            checked = autoTitle,
                            enabled = true,
                            onCheckedChange = { checked ->
                                onUpdateHubSettings(
                                    UpdateHubSettingsRequest(autoTitlePerTurn = checked),
                                )
                            },
                        )
                    }
                }

                settings.disablePeerTools?.let { disablePeerTools ->
                    SettingsSection(title = stringResource(R.string.settings_section_peer_tools)) {
                        SwitchRow(
                            label = stringResource(R.string.settings_disable_peer_tools),
                            description = stringResource(R.string.settings_disable_peer_tools_desc),
                            checked = disablePeerTools,
                            enabled = true,
                            onCheckedChange = { checked ->
                                onUpdateHubSettings(
                                    UpdateHubSettingsRequest(disablePeerTools = checked),
                                )
                            },
                        )
                    }
                }

                if (hubSettingsSaveError != null) {
                    Text(
                        text = stringResource(R.string.settings_hub_save_failed, hubSettingsSaveError!!),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(start = 4.dp),
                    )
                }
            }

            // Hidden until the hub confirms a standard-capable provider — the
            // chat mic button follows the same availability rule.
            if (dictationState.loaded && dictationState.providers.isNotEmpty()) {
                SettingsSection(title = stringResource(R.string.settings_section_dictation)) {
                    SettingsRow(
                        label = stringResource(R.string.settings_dictation_provider),
                        value = dictationState.providers
                            .firstOrNull { it.id == dictationState.resolvedProviderId }
                            ?.label,
                        onClick = { showDictationProviderDialog = true },
                    )
                    SettingsDivider()
                    SettingsRow(
                        label = stringResource(R.string.settings_dictation_language),
                        value = dictationLanguageValue(dictationState.language),
                        onClick = { showDictationLanguageDialog = true },
                    )
                }
            }

            SettingsSection(title = stringResource(R.string.settings_machines)) {
                SettingsRow(
                    label = stringResource(R.string.settings_machines),
                    description = stringResource(R.string.settings_machines_summary),
                    onClick = onOpenMachines,
                )
            }

            SettingsSection(title = stringResource(R.string.settings_section_about)) {
                SettingsRow(
                    label = stringResource(R.string.settings_app_version),
                    value = BuildConfig.VERSION_NAME,
                )
                SettingsDivider()
                SettingsRow(
                    label = stringResource(R.string.settings_protocol_version),
                    value = SUPPORTED_PROTOCOL_VERSION.toString(),
                )
                SettingsDivider()
                SettingsRow(
                    label = stringResource(R.string.settings_hub),
                    value = hubUrl,
                    description = when (val info = hubInfo) {
                        is HubInfoState.Loading -> stringResource(R.string.settings_hub_checking)
                        is HubInfoState.Loaded -> stringResource(
                            R.string.settings_hub_health,
                            info.health.status,
                            info.health.protocolVersion,
                        )
                        is HubInfoState.Failed -> stringResource(R.string.settings_hub_unreachable)
                    },
                    onClick = if (hubInfo is HubInfoState.Failed) onRetryHubInfo else null,
                )
                SettingsDivider()
                app.hapi.companion.ui.components.PrivacyPolicyLink()
            }
        }
    }

    if (showThemeDialog) {
        ThemeModeDialog(
            selected = theme.mode,
            onSelect = { mode ->
                showThemeDialog = false
                onSetThemeMode(mode)
            },
            onDismiss = { showThemeDialog = false },
        )
    }

    if (showLanguageDialog) {
        LanguageDialog(
            selected = language,
            onSelect = { choice ->
                showLanguageDialog = false
                onSetLanguage(choice)
                // Apply immediately (B-M5a): appcompat recreates the activity
                // with the new locale and, thanks to autoStoreLocales in the
                // manifest, re-applies it on every cold start. The DataStore
                // write above keeps the settings row in sync.
                AppCompatDelegate.setApplicationLocales(
                    LocaleListCompat.forLanguageTags(choice.localeTags),
                )
            },
            onDismiss = { showLanguageDialog = false },
        )
    }

    if (showDictationProviderDialog) {
        DictationProviderDialog(
            providers = dictationState.providers,
            selectedId = dictationState.resolvedProviderId,
            onSelect = { providerId ->
                showDictationProviderDialog = false
                onSetDictationProvider(providerId)
            },
            onDismiss = { showDictationProviderDialog = false },
        )
    }

    if (showDictationLanguageDialog) {
        DictationLanguageDialog(
            selectedCode = dictationState.language,
            onSelect = { code ->
                showDictationLanguageDialog = false
                onSetDictationLanguage(code)
            },
            onDismiss = { showDictationLanguageDialog = false },
        )
    }
}

// ------------------------------------------------------------- primitives --

@Composable
private fun SettingsSection(title: String, content: @Composable () -> Unit) {
    Column {
        Text(
            text = title,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(start = 4.dp, bottom = 6.dp),
        )
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column { content() }
        }
    }
}

@Composable
private fun SettingsDivider() {
    HorizontalDivider(
        color = MaterialTheme.colorScheme.outlineVariant,
        modifier = Modifier.padding(horizontal = 16.dp),
    )
}

@Composable
private fun SettingsRow(
    label: String,
    value: String? = null,
    description: String? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, style = MaterialTheme.typography.bodyLarge)
            if (description != null) {
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        if (value != null) {
            Text(
                text = value,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 12.dp),
            )
        }
    }
}

@Composable
private fun SwitchRow(
    label: String,
    description: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, style = MaterialTheme.typography.bodyLarge)
            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        Spacer(modifier = Modifier.padding(start = 12.dp))
        Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

// ---------------------------------------------------------------- dialogs --

@Composable
private fun ThemeModeDialog(
    selected: ThemeMode,
    onSelect: (ThemeMode) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_theme)) },
        text = {
            Column {
                ThemeMode.entries.forEach { mode ->
                    RadioRow(
                        label = stringResource(themeModeLabelRes(mode)),
                        selected = mode == selected,
                        onClick = { onSelect(mode) },
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.settings_cancel)) }
        },
    )
}

@Composable
private fun LanguageDialog(
    selected: AppLanguage,
    onSelect: (AppLanguage) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_language)) },
        text = {
            Column {
                AppLanguage.entries.forEach { language ->
                    RadioRow(
                        label = languageLabel(language),
                        selected = language == selected,
                        onClick = { onSelect(language) },
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.settings_cancel)) }
        },
    )
}

@Composable
private fun RadioRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(start = 4.dp),
        )
    }
}

/** Transcription provider picker — the hub's standard-capable entries only. */
@Composable
private fun DictationProviderDialog(
    providers: List<TranscriptionProviderInfo>,
    selectedId: String?,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_dictation_provider)) },
        text = {
            Column {
                providers.forEach { provider ->
                    RadioRow(
                        label = provider.label,
                        selected = provider.id == selectedId,
                        onClick = { onSelect(provider.id) },
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.settings_cancel)) }
        },
    )
}

/** Dictation language picker: localized Auto-detect row + native-name rows. */
@Composable
private fun DictationLanguageDialog(
    selectedCode: String?,
    onSelect: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_dictation_language)) },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                RadioRow(
                    label = stringResource(R.string.settings_dictation_language_auto),
                    selected = selectedCode == null,
                    onClick = { onSelect(null) },
                )
                DICTATION_LANGUAGES.forEach { language ->
                    RadioRow(
                        label = language.label,
                        selected = language.code == selectedCode,
                        onClick = { onSelect(language.code) },
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.settings_cancel)) }
        },
    )
}

/** Language row value: catalog label, or Auto-detect for null. */
@Composable
private fun dictationLanguageValue(code: String?): String =
    findDictationLanguage(code)?.label ?: stringResource(R.string.settings_dictation_language_auto)

private fun themeModeLabelRes(mode: ThemeMode): Int = when (mode) {
    ThemeMode.SYSTEM -> R.string.settings_theme_system
    ThemeMode.LIGHT -> R.string.settings_theme_light
    ThemeMode.DARK -> R.string.settings_theme_dark
    ThemeMode.OLED -> R.string.settings_theme_oled
}

/**
 * Language names are shown in their own language (standard picker
 * convention), so they are string literals, not resources; only the
 * follow-system row translates with the app language.
 */
@Composable
private fun languageLabel(language: AppLanguage): String = when (language) {
    AppLanguage.SYSTEM -> stringResource(R.string.settings_language_system)
    AppLanguage.ENGLISH -> "English"
    AppLanguage.SIMPLIFIED_CHINESE -> "简体中文"
    AppLanguage.RUSSIAN -> "Русский"
}
