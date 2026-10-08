import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:on_audio_query_pluse/on_audio_query.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';

import 'api.dart';
import 'models.dart';
import 'store.dart';
import 'updater.dart';

/// App-wide state: sign-in, family, the synced library, playlists, downloads and phone files.
/// Browsing and playing use only [LocalStore], so they work with no network; sync, playlist
/// uploads and downloads are best-effort and retried.
class AppState extends ChangeNotifier {
  AppState(this.store, this.api);

  final LocalStore store;
  final ApiClient api;
  final updates = UpdateController(); // the "new version" banner

  User? user;
  bool familyLoaded = false; // false until the first family lookup (or cache) finishes
  bool syncing = false;
  String? message; // last non-fatal problem, shown in Settings
  final Map<String, double> progress = {}; // track id -> 0..1 for downloads in flight
  late final Directory _musicDir;

  FamilyInfo? get family => store.family;

  Future<void> init() async {
    final docs = await getApplicationDocumentsDirectory();
    _musicDir = Directory('${docs.path}/music')..createSync(recursive: true);
    api.watchToken();
    user = FirebaseAuth.instance.currentUser;
    if (user != null) unawaited(_onSignedIn());
    FirebaseAuth.instance.authStateChanges().listen((u) {
      final was = user?.uid;
      user = u;
      if (u == null) {
        unawaited(_onSignedOut());
      } else if (u.uid != was) {
        unawaited(_onSignedIn());
      }
      notifyListeners();
    });
  }

  // ---- Account / family ---------------------------------------------------------------------

  Future<void> _onSignedIn() async {
    familyLoaded = store.family != null; // start offline from the cached family
    notifyListeners();
    await refreshFamily();
    if (family != null) await sync();
  }

  Future<void> _onSignedOut() async {
    for (final id in store.downloads.keys.toList()) {
      await _deleteFile(id);
    }
    store.clearAccountData();
    await store.save();
    familyLoaded = false;
    notifyListeners();
  }

  Future<void> refreshFamily() async {
    try {
      store.family = await api.getFamily();
      await store.save();
    } on ApiException catch (e) {
      if (e.status != 401) message = e.message;
    } catch (_) {
      // Offline: keep the cached family.
    }
    familyLoaded = true;
    notifyListeners();
  }

  Future<void> createFamily(String name) async {
    store.family = await api.createFamily(name);
    await store.save();
    notifyListeners();
    unawaited(sync());
  }

  Future<void> joinFamily(String code) async {
    store.family = await api.joinFamily(code);
    await store.save();
    notifyListeners();
    unawaited(sync());
  }

  Future<void> leaveFamily() async {
    await api.removeMember(user!.uid);
    await _onSignedOut();
    await refreshFamily();
  }

  Future<void> deleteAccount() async {
    await api.deleteAccount();
    await user?.delete();
  }

  // ---- Library ----------------------------------------------------------------------------

  /// Server tracks plus tracks found on this phone, by title.
  List<Track> get allTracks => [...store.tracks.values, ...store.phoneTracks.values]
    ..sort((a, b) => a.title.toLowerCase().compareTo(b.title.toLowerCase()));

  Track? track(String id) => store.tracks[id] ?? store.phoneTracks[id];

  List<Playlist> get playlists => store.playlists.values.toList()..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));

  List<Track> tracksOf(Playlist p) => [for (final id in p.trackIds) ?track(id)];

  List<Track> get recentTracks => [for (final id in store.recent) ?track(id)];

  void markPlayed(String id) {
    store.recent..remove(id)..insert(0, id);
    if (store.recent.length > 50) store.recent.removeRange(50, store.recent.length);
    unawaited(store.save());
  }

  Future<void> sync() async {
    if (syncing || family == null) return;
    syncing = true;
    notifyListeners();
    try {
      await _flushPending();
      final d = await api.library(store.since);
      for (final (t, deleted) in d.tracks) {
        if (deleted) {
          store.tracks.remove(t.id);
          await _deleteFile(t.id);
        } else {
          store.tracks[t.id] = t;
        }
      }
      final pendingIds = {for (final p in store.pending) p['id']};
      for (final (p, deleted) in d.playlists) {
        if (pendingIds.contains(p.id)) continue; // our unsent edit wins
        deleted ? store.playlists.remove(p.id) : store.playlists[p.id] = p;
      }
      store.since = d.now;
      message = null;
      await store.save();
    } on ApiException catch (e) {
      if (e.status == 403) {
        store.family = null; // removed from the family
        await store.save();
      }
      message = e.message;
    } catch (_) {
      message = 'Offline: showing what is on this phone';
    } finally {
      syncing = false;
      notifyListeners();
    }
  }

  // ---- Playlists --------------------------------------------------------------------------

  Future<Playlist> createPlaylist(String name) async {
    final p = Playlist(id: _uuid(), name: name, ownerUid: user!.uid, updatedAt: DateTime.now().millisecondsSinceEpoch);
    await savePlaylist(p);
    return p;
  }

  /// Saves locally at once, then uploads (retried on the next sync if offline).
  Future<void> savePlaylist(Playlist p) async {
    p.updatedAt = DateTime.now().millisecondsSinceEpoch;
    store.playlists[p.id] = p;
    store.pending.removeWhere((e) => e['id'] == p.id);
    store.pending.add({'op': 'put', 'id': p.id});
    await store.save();
    notifyListeners();
    unawaited(_flushPending());
  }

  Future<void> deletePlaylist(String id) async {
    store.playlists.remove(id);
    store.pending.removeWhere((e) => e['id'] == id);
    store.pending.add({'op': 'delete', 'id': id});
    await store.save();
    notifyListeners();
    unawaited(_flushPending());
  }

  Future<void> _flushPending() async {
    for (final e in store.pending.toList()) {
      try {
        if (e['op'] == 'put') {
          final p = store.playlists[e['id']];
          if (p != null) await api.putPlaylist(p);
        } else {
          await api.deletePlaylist(e['id']!);
        }
        store.pending.remove(e);
        await store.save();
      } on ApiException catch (ex) {
        if (ex.status == 403 || ex.status == 400) {
          store.pending.remove(e); // rejected for good (not ours / invalid): drop it
        } else {
          return;
        }
      } catch (_) {
        return; // offline: keep the rest queued
      }
    }
  }

  // ---- Downloads --------------------------------------------------------------------------

  bool isDownloaded(String id) => store.downloads.containsKey(id);

  /// The audio file for a track on this phone, or null if it has to be streamed.
  String? localPath(Track t) => isDownloaded(t.id) ? '${_musicDir.path}/${t.id}' : null;

  List<Track> get downloadedTracks => [for (final id in store.downloads.keys) ?track(id)];

  int get downloadedBytes => store.downloads.values.fold(0, (a, b) => a + b);

  Future<void> download(Track t) async {
    if (t.isLocal || isDownloaded(t.id) || progress.containsKey(t.id)) return;
    progress[t.id] = 0;
    notifyListeners();
    final part = File('${_musicDir.path}/${t.id}.part');
    final client = http.Client();
    try {
      var have = part.existsSync() ? part.lengthSync() : 0;
      if (t.size > 0 && have == t.size) {
        // A previous run finished writing but not renaming.
      } else {
        final req = http.Request('GET', api.streamUri(t.id))..headers.addAll(await api.authHeaders());
        if (have > 0) req.headers['Range'] = 'bytes=$have-';
        final res = await client.send(req);
        if (res.statusCode != 200 && res.statusCode != 206) throw ApiException(res.statusCode, 'Download failed (${res.statusCode})');
        if (res.statusCode == 200) have = 0; // server ignored Range: start over
        final sink = part.openWrite(mode: have > 0 ? FileMode.append : FileMode.write);
        var received = have;
        var lastPct = -1;
        try {
          await for (final chunk in res.stream) {
            sink.add(chunk);
            received += chunk.length;
            final pct = t.size > 0 ? received * 100 ~/ t.size : 0;
            if (pct != lastPct) {
              lastPct = pct;
              progress[t.id] = pct / 100;
              notifyListeners();
            }
          }
        } finally {
          await sink.close();
        }
      }
      if (t.size > 0 && part.lengthSync() != t.size) throw ApiException(0, 'Download incomplete, will resume');
      final dest = File('${_musicDir.path}/${t.id}');
      await part.rename(dest.path);
      store.downloads[t.id] = dest.lengthSync();
      await store.save();
    } catch (e) {
      message = e is ApiException ? e.message : 'Download failed: check your connection';
    } finally {
      client.close();
      progress.remove(t.id);
      notifyListeners();
    }
  }

  Future<void> downloadAll(Iterable<Track> tracks) async {
    for (final t in tracks) {
      await download(t);
    }
  }

  Future<void> removeDownload(String id) async {
    await _deleteFile(id);
    await store.save();
    notifyListeners();
  }

  Future<void> _deleteFile(String id) async {
    store.downloads.remove(id);
    for (final f in [File('${_musicDir.path}/$id'), File('${_musicDir.path}/$id.part')]) {
      if (f.existsSync()) await f.delete();
    }
  }

  // ---- Phone files ------------------------------------------------------------------------

  /// Adds the music already on this phone (device only; never uploaded). Returns false if the
  /// user refused the permission.
  Future<bool> scanPhone() async {
    var status = await Permission.audio.request();
    if (!status.isGranted) status = await Permission.storage.request(); // Android 12 and older
    if (!status.isGranted) return false;
    final songs = await OnAudioQuery().querySongs(sortType: SongSortType.TITLE, uriType: UriType.EXTERNAL, ignoreCase: true);
    store.phoneTracks = {
      for (final s in songs)
        if ((s.isMusic ?? true) && (s.duration ?? 0) > 30000 && s.uri != null)
          'local:${s.id}': Track(
            id: 'local:${s.id}',
            source: 'local',
            title: s.title,
            artist: (s.artist == null || s.artist == '<unknown>') ? '' : s.artist!,
            album: s.album ?? '',
            duration: (s.duration ?? 0) / 1000,
            trackNo: s.track ?? 0,
            uri: s.uri,
          ),
    };
    await store.save();
    notifyListeners();
    return true;
  }

  Future<void> clearPhoneTracks() async {
    store.phoneTracks = {};
    await store.save();
    notifyListeners();
  }
}

final _rng = Random.secure();

String _uuid() {
  final r = List<int>.generate(16, (_) => _rng.nextInt(256));
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  String h(int i) => r[i].toRadixString(16).padLeft(2, '0');
  return '${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}';
}
