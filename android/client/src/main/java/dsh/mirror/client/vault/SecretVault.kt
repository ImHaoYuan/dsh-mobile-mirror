package dsh.mirror.client.vault

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 账号密码的加密保险箱（AES-GCM + AndroidKeyStore）。
 *
 * <p>**为什么非存密码不可**：宿主的登录会话是**内存态**（{@code lib/server.js} 里的
 * {@code createSessionStore}），DSH 一重启就全清了 —— 会话 Cookie 留着也是废票。
 * 不存密码的话，每次重启 DSH 都得在手机上重打一遍密码；存了才能自动重登。
 *
 * <p>**密钥不可导出**：AES 密钥生成在 AndroidKeyStore 里（别名 {@link #ALIAS}），
 * 私钥材料从不出安全硬件；磁盘上只有「IV + 密文」。所以这里没有"密钥放哪"的问题，
 * 也不需要用已废弃的 androidx.security-crypto。
 *
 * <p>**失败一律自愈**：密钥被系统作废（改锁屏密码等）、密文被篡改、prefs 被清 ——
 * 任何一种都当作"没有密码"，顺手把残留清掉，让用户重新登录一次即可，
 * <b>绝不因为解密失败而崩</b>。
 */
object SecretVault {

    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "dsh_mm_login_v1"
    private const val PREFS = "dsh_mm_secret"
    private const val K_IV = "iv"
    private const val K_CT = "ct"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val TAG_BITS = 128
    private const val SEP = '\u0000'

    /** 记住一组凭据。成功返回 true；密钥生成失败等极端情况返回 false（调用方照常继续，只是不能自动重登）。 */
    fun save(ctx: Context, username: String, password: String): Boolean {
        return try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val ct = cipher.doFinal((username + SEP + password).toByteArray(Charsets.UTF_8))
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(K_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .putString(K_CT, Base64.encodeToString(ct, Base64.NO_WRAP))
                .apply()
            true
        } catch (t: Throwable) {
            clear(ctx)
            false
        }
    }

    /** 读回凭据；没有、或解不开，都返回 null。 */
    fun load(ctx: Context): Pair<String, String>? {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val ivB64 = sp.getString(K_IV, null) ?: return null
        val ctB64 = sp.getString(K_CT, null) ?: return null
        return try {
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            val ct = Base64.decode(ctB64, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
            val plain = String(cipher.doFinal(ct), Charsets.UTF_8)
            val at = plain.indexOf(SEP)
            if (at <= 0) { clear(ctx); null }
            else plain.substring(0, at) to plain.substring(at + 1)
        } catch (t: Throwable) {
            clear(ctx)          // 密钥作废 / 密文被改：清掉残留，当作没存过
            null
        }
    }

    fun exists(ctx: Context): Boolean {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return sp.contains(K_CT)
    }

    /** 清掉密文。<b>刻意不删 Keystore 里的密钥</b> —— 删了也省不下什么，留着还能复用。 */
    fun clear(ctx: Context) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        } catch (t: Throwable) {
            // 忽略
        }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // 不要求解锁屏幕才能用：后台服务也要能在锁屏时自动重登。
                .setUserAuthenticationRequired(false)
                .build()
        )
        return gen.generateKey()
    }
}
