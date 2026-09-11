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
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Firma de release: la inyecta CI desde GitHub Secrets
            // (VIEWLBA_KEYSTORE_BASE64/…). Localmente se puede firmar con un
            // keystore propio sobrescribiendo estas propiedades en
            // ~/.gradle/gradle.properties o env vars.
            val ksPath = System.getenv("VIEWLBA_KEYSTORE_FILE")
            val ksPassword = System.getenv("VIEWLBA_KEYSTORE_PASSWORD")
            val ksAlias = System.getenv("VIEWLBA_KEY_ALIAS")
            val ksKeyPassword = System.getenv("VIEWLBA_KEY_PASSWORD")
            if (ksPath != null && ksPassword != null && ksAlias != null) {
                signingConfig = signingConfigs.create("release") {
                    storeFile = file(ksPath)
                    storePassword = ksPassword
                    keyAlias = ksAlias
                    keyPassword = ksKeyPassword ?: ksPassword
                }
            }
            // sin firma configurada → APK sin firmar (CI lo avisa)
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

    // Biometría/PIN (desbloqueo del generador)
    implementation("androidx.biometric:biometric:1.1.0")

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
