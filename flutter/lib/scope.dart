import 'package:flutter/widgets.dart';

import 'audio_handler.dart';
import 'state.dart';

/// Gives widgets the app state and the audio handler (no state-management package needed).
class AppScope extends InheritedWidget {
  const AppScope({super.key, required this.app, required this.audio, required super.child});

  final AppState app;
  final MyAudioHandler audio;

  static AppScope of(BuildContext context) => context.getInheritedWidgetOfExactType<AppScope>()!;

  @override
  bool updateShouldNotify(AppScope old) => false;
}

extension AppContext on BuildContext {
  AppState get app => AppScope.of(this).app;
  MyAudioHandler get audio => AppScope.of(this).audio;
}
