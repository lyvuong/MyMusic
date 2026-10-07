package org.lv5.mymusic

import com.ryanheise.audioservice.AudioServiceActivity

// audio_service needs its activity so the UI and the media service (Android Auto) share one Flutter engine.
class MainActivity : AudioServiceActivity()
