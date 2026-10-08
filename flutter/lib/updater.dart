import 'dart:convert';
import 'dart:ffi' show Abi;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:ota_update/ota_update.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'env.dart';

/// A newer build published by scripts/android-release.mjs (android/latest.json in R2).
class AppUpdate {
  const AppUpdate({required this.versionCode, required this.versionName, required this.file, required this.sha256, this.notes});
  final int versionCode;
  final String versionName;
  final String file;
  final String sha256;
  final String? notes;
}

Future<({String name, int code})> currentVersion() async {
  final info = await PackageInfo.fromPlatform();
  return (name: info.version, code: int.tryParse(info.buildNumber) ?? 0);
}

String? get _abi => switch (Abi.current()) {
      Abi.androidArm64 => 'arm64-v8a',
      Abi.androidArm => 'armeabi-v7a',
      Abi.androidX64 => 'x86_64',
      _ => null,
    };

/// Self-update only applies to sideloaded Android release builds; a Play Store build is
/// built with `--dart-define=STORE_BUILD=true` and never offers it.
bool get updatesEnabled =>
    kReleaseMode && defaultTargetPlatform == TargetPlatform.android && !const bool.fromEnvironment('STORE_BUILD');

/// Asks the Worker for the newest build; returns it if newer than this install.
Future<AppUpdate?> checkForUpdate() async {
  final abi = _abi;
  if (!updatesEnabled || abi == null) return null;
  final res = await http.get(Uri.parse('${Env.apiUrl}/api/app/android/latest')).timeout(const Duration(seconds: 15));
  if (res.statusCode == 404) return null; // nothing published yet
  if (res.statusCode >= 300) throw StateError('update check ${res.statusCode}');
  final j = jsonDecode(res.body) as Map<String, dynamic>;
  final apk = (j['apks'] as Map<String, dynamic>?)?[abi] as Map<String, dynamic>?;
  final code = j['versionCode'] as int? ?? 0;
  if (apk == null || code <= (await currentVersion()).code) return null;
  return AppUpdate(
    versionCode: code,
    versionName: j['versionName'] as String? ?? '$code',
    file: apk['file'] as String,
    sha256: apk['sha256'] as String,
    notes: j['notes'] as String?,
  );
}

/// Downloads the update (checksum-verified) and opens Android's installer. Emits progress 0-100.
Stream<int> installUpdate(AppUpdate update) async* {
  final info = await PackageInfo.fromPlatform();
  await for (final e in OtaUpdate().execute(
    '${Env.apiUrl}/api/app/android/${update.file}',
    destinationFilename: 'mymusic-update.apk',
    sha256checksum: update.sha256,
    androidProviderAuthority: '${info.packageName}.ota_update_provider',
  )) {
    switch (e.status) {
      case OtaStatus.DOWNLOADING:
        yield int.tryParse(e.value ?? '') ?? 0;
      case OtaStatus.INSTALLING || OtaStatus.INSTALLATION_DONE:
        yield 100;
        return;
      case OtaStatus.PERMISSION_NOT_GRANTED_ERROR:
        throw StateError('Allow MyMusic to install apps, then try again.');
      case OtaStatus.CHECKSUM_ERROR:
        throw StateError('The download was corrupted. Try again.');
      default:
        throw StateError('Update failed (${e.status.name}${e.value == null ? '' : ': ${e.value}'})');
    }
  }
}

/// What the "new version" banner shows: whether a newer build exists, whether the user hid it, and
/// the download progress. Checks run at start and whenever the app comes back to the foreground.
class UpdateController extends ChangeNotifier {
  UpdateController({Future<AppUpdate?> Function()? check, Stream<int> Function(AppUpdate)? install})
      : _check = check ?? checkForUpdate,
        _install = install ?? installUpdate;

  final Future<AppUpdate?> Function() _check;
  final Stream<int> Function(AppUpdate) _install;

  AppUpdate? update;
  int? progress; // 0-100 while downloading, null otherwise
  String? error;
  int _dismissed = 0; // version code the user chose "Later" for; a newer build shows the banner again
  DateTime? _checkedAt;

  bool get visible => update != null && (progress != null || update!.versionCode != _dismissed);

  /// Quietly asks for the newest build; at most every 30 minutes unless [force]. Offline is fine.
  Future<void> check({bool force = false}) async {
    final last = _checkedAt;
    if (progress != null || (!force && last != null && DateTime.now().difference(last) < const Duration(minutes: 30))) return;
    _checkedAt = DateTime.now();
    try {
      final u = await _check();
      if (u?.versionCode != update?.versionCode) {
        update = u;
        error = null;
        notifyListeners();
      }
    } catch (_) {
      _checkedAt = null; // try again next time
    }
  }

  void dismiss() {
    _dismissed = update?.versionCode ?? 0;
    notifyListeners();
  }

  Future<void> install() async {
    final u = update;
    if (u == null || progress != null) return;
    error = null;
    progress = 0;
    notifyListeners();
    try {
      await for (final p in _install(u)) {
        progress = p;
        notifyListeners();
      }
    } catch (e) {
      error = e is StateError ? e.message : '$e';
    }
    progress = null;
    notifyListeners();
  }
}
