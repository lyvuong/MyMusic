package org.lv5.mymusic

import android.content.Context
import android.net.wifi.WifiManager
import android.os.PowerManager
import com.ryanheise.audioservice.AudioServiceActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// audio_service needs its activity so the UI and the media service (Android Auto) share one Flutter engine.
class MainActivity : AudioServiceActivity() {
    private var cpuLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    // While a song plays with the screen off (the car), keep the CPU and Wi-Fi at full speed so streaming and the
    // next-song prefetch are not throttled. The locks time out so a missed release can not drain the battery.
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val app = applicationContext
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "org.lv5.mymusic/playback").setMethodCallHandler { call, result ->
            when (call.method) {
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
