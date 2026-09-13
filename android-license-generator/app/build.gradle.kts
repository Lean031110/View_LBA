plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.viewlba.licensegen"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.viewlba.licensegen"
        minSdk = 26
        targetSdk = 35
        // ── Versión: ÚNICA FUENTE DE VERDAD = <repo>/VERSION ──────────────
        // versionName se lee del archivo VERSION de la raíz del repositorio
        // (nunca hardcoded aquí). Override para builds de release candidate:
        //   ./gradlew assembleRelease -PandroidVersionName=3.0.0-rc.1
        versionName = (providers.gradleProperty("androidVersionName").orNull)
            ?: File(rootDir.parentFile, "VERSION").readText().trim()
        // versionCode MONÓTONO (gradle.properties VERSION_CODE — subir en
        // cada release publicada). Override análogo para variantes de CI.
        versionCode = (providers.gradleProperty("androidVersionCode").orNull
            ?: providers.gradleProperty("VERSION_CODE").orNull
            ?: "1").toInt()

        // Solicitudes DEMO (VLDEMO-…): SOLO para el smoke del emulador en CI
        // (./gradlew assembleRelease -PdemoRequests=true). El release de
        // producción NO pasa la propiedad → false, y el prefijo VLDEMO- se
        // rechaza como código inválido.
        buildConfigField("boolean", "DEMO_REQUESTS", providers.gradleProperty("demoRequests").orElse("false").get())
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // FIRMA: Gradle NUNCA firma. El APK sale SIN firmar y la firma es
            // un paso explícito y auditable de CI (zipalign → apksigner sign
            // → apksigner verify) con el keystore de GitHub Secrets. Flujo
            // único: no existe ruta alternativa de publicación.
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "/META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        disable += "AndroidGradlePluginVersion"
    }
}

dependencies {
    // Runtime mínimo — sin frameworks UI: views clásicas (predecibles).
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")

    // (v3.2) SIN androidx.biometric: desbloqueo simple por PIN pedido por
    // el usuario; el Keystore con setUserAuthenticationRequired dejaba la
    // app atascada en la primera pantalla en dispositivos reales.

    // Criptografía Ed25519/X25519 (BouncyCastle — uso directo de clases,
    // sin registrar Provider para no chocar con el de Android)
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    // DB local CIFRADA en reposo (SQLCipher Community)
    implementation("net.zetetic:sqlcipher-android:4.6.1")
    implementation("androidx.sqlite:sqlite:2.4.0")

    // Tests JVM (lógica pura — sin emulador)
    testImplementation("junit:junit:4.13.2")
    // org.json real para JVM (el android.jar de los unit tests es un stub)
    testImplementation("org.json:json:20240303")
    testImplementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
}
