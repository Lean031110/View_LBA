# ViewLBA License Generator — reglas ProGuard/R8.
#
# BouncyCastle se usa con las clases de bajo nivel (rfc8032/rfc7748/HKDF):
# sin reflexión → no necesita keep. SQLCipher carga una lib nativa y usa
# reflexión mínima documentada: se conserva su paquete.
-keep class net.zetetic.database.** { *; }
-dontwarn net.zetetic.database.**

# org.json es parte del platform: sin problema.

# Nunca ofuscar los nombres de las columnas/constantes del esquema SQL
# (se referencian por reflexión en Db.kt).
-keep class com.viewlba.licensegen.db.DbKt { *; }
