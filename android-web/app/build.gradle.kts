import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "run.hapi.web"
    // Toolchain mirrors ../android/app (compileSdk 36 / minSdk 26 / JVM 17).
    compileSdk = 36

    defaultConfig {
        applicationId = "run.hapi.web"
        minSdk = 26
        targetSdk = 36
        // CI injects these via -PhapiVersionCode/-PhapiVersionName (same
        // convention as ../android/app); local defaults keep the shell buildable.
        versionCode = providers.gradleProperty("hapiVersionCode").map { value ->
            value.toInt().also { require(it > 0) { "hapiVersionCode must be positive" } }
        }.orElse(1).get()
        versionName = providers.gradleProperty("hapiVersionName").orElse("0.30.7").get()
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Unsigned without a keystore — fine, releases are CI-signed.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.androidx.webkit)

    // JVM unit tests: pairing validation / URL normalization / boot URL assembly.
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
}
