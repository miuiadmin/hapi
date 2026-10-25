// Root build file: declares plugin versions (mirrors ../android, single :app module).
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
}
