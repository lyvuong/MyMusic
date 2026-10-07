/// Build-time settings, passed with `--dart-define=NAME=value` (see config/production.json).
class Env {
  static const _apiUrl = String.fromEnvironment('API_URL');

  /// Where the Worker (API + web player) is served, e.g. https://music.example.com.
  static String get apiUrl {
    if (_apiUrl.isEmpty) throw StateError('Build with --dart-define=API_URL=https://<your domain>');
    return _apiUrl.endsWith('/') ? _apiUrl.substring(0, _apiUrl.length - 1) : _apiUrl;
  }

  /// OAuth client ID of type "Web application" (Firebase console, Authentication, Google); google_sign_in
  /// on Android needs it to get an ID token for Firebase.
  static const googleServerClientId = String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID');
}
