package org.lv5.mymusic

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import com.ryanheise.audioservice.AudioServiceActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// audio_service needs its activity so the UI and the media service (Android Auto) share one Flutter engine.
class MainActivity : AudioServiceActivity() {
    private var cpuLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var channel: MethodChannel? = null
    private var sharedText: String? = null // text shared to the app, until Flutter takes it

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The Flutter engine can outlive the activity (the music keeps playing): tell the running app about the share.
        if (keepShared(intent)) channel?.invokeMethod("shared", null)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (keepShared(intent)) channel?.invokeMethod("shared", null)
    }

    private fun keepShared(intent: Intent?): Boolean {
        if (intent == null || intent.action != Intent.ACTION_SEND || intent.type != "text/plain") return false
        sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
        return sharedText != null
    }

    // While a song plays with the screen off (the car), keep the CPU and Wi-Fi at full speed so streaming and the
    // next-song prefetch are not throttled. The locks time out so a missed release can not drain the battery.
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val app = applicationContext
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "org.lv5.mymusic/playback")
        channel?.setMethodCallHandler { call, result ->
            when (call.method) {
                // Android 13+ shows no playback notification (and Android Auto no now-playing bar) until this is allowed.
                "requestNotifications" -> {
                    if (Build.VERSION.SDK_INT >= 33 &&
                        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                    ) {
                        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
                    }
                    result.success(null)
                }
                "takeShared" -> {
                    result.success(sharedText)
                    sharedText = null
                }
                "hold" -> {
                    if (cpuLock == null) {
                        val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
                        cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mymusic:playback").apply { setReferenceCounted(false) }
                    }
                    if (wifiLock == null) {
                        val wm = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
                        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "mymusic:playback").apply { setReferenceCounted(false) }
                    }
                    cpuLock?.acquire(HOLD_MS)
                    if (wifiLock?.isHeld != true) wifiLock?.acquire()
                    result.success(null)
                }
                "release" -> {
                    if (cpuLock?.isHeld == true) cpuLock?.release()
                    if (wifiLock?.isHeld == true) wifiLock?.release()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    private companion object {
        const val HOLD_MS = 15 * 60 * 1000L
    }
}
