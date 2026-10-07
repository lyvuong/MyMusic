import 'package:audio_service/audio_service.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import 'api.dart';
import 'audio_handler.dart';
import 'scope.dart';
import 'state.dart';
import 'store.dart';
import 'ui/family_screen.dart';
import 'ui/home.dart';
import 'ui/sign_in.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Firebase reads google-services.json (Android) / GoogleService-Info.plist (iOS).
  String? firebaseError;
  try {
    await Firebase.initializeApp();
  } catch (e) {
    firebaseError = '$e';
  }
  final app = AppState(await LocalStore.open(), ApiClient());
  if (firebaseError == null) await app.init();
  // Android Auto starts this same entry point headless to reach the media service, so the
  // handler is created here and not tied to any screen.
  final audio = await AudioService.init(
    builder: () => MyAudioHandler(app),
    config: const AudioServiceConfig(
      androidNotificationChannelId: 'org.lv5.mymusic.playback',
      androidNotificationChannelName: 'Music playback',
      androidNotificationIcon: 'drawable/ic_notification',
    ),
  );
  runApp(AppScope(app: app, audio: audio, child: MyMusicApp(firebaseError: firebaseError)));
}

class MyMusicApp extends StatelessWidget {
  const MyMusicApp({super.key, this.firebaseError});
  final String? firebaseError;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'MyMusic',
      themeMode: ThemeMode.system,
      theme: ThemeData(colorSchemeSeed: Colors.deepPurple, useMaterial3: true),
      darkTheme: ThemeData(colorSchemeSeed: Colors.deepPurple, brightness: Brightness.dark, useMaterial3: true),
      home: firebaseError != null ? _SetupError(firebaseError!) : const _Gate(),
    );
  }
}

/// Signed out -> sign-in; no family yet -> create/join; otherwise the app.
class _Gate extends StatelessWidget {
  const _Gate();

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) {
        if (app.user == null) return const SignInScreen();
        if (!app.familyLoaded) return const Scaffold(body: Center(child: CircularProgressIndicator()));
        if (app.family == null) return const FamilyScreen();
        return const HomeShell();
      },
    );
  }
}

class _SetupError extends StatelessWidget {
  const _SetupError(this.error);
  final String error;

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text('Firebase is not configured.\n\nAdd android/app/google-services.json (see README), then rebuild.\n\n$error'),
          ),
        ),
      );
}
