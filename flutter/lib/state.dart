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
import 'mixes.dart';
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

  /// Puts the song at the top of "Recently played" (the app and the car screen). Whether it was really listened to is
  /// decided later: see [countPlay] and [countSkip].
  void markStarted(String id) {
    store.recent..remove(id)..insert(0, id);
    if (store.recent.length > 50) store.recent.removeRange(50, store.recent.length);
    unawaited(store.save());
  }

  /// A song heard for a minute or to its end: feeds the family's popular list and my mixes.
  void countPlay(String id, int at) => _queueEvent(id, at, skip: false);

  /// A song I moved on from within a minute: only shapes my own mixes, never the family's popular list.
  void countSkip(String id, int at) => _queueEvent(id, at, skip: true);

  void _queueEvent(String id, int at, {required bool skip}) {
    if (id.startsWith('local:')) return;
    store.pendingPlays.add({'id': id, 'at': at, if (skip) 'skip': true});
    if (store.pendingPlays.length > 500) store.pendingPlays.removeRange(0, store.pendingPlays.length - 500);
    unawaited(_flushPlays());
    unawaited(store.save());
  }

  bool _flushingPlays = false;

  /// Uploads queued plays and skips in batches of 50; whatever fails stays queued for the next play or sync.
  Future<void> _flushPlays() async {
    if (_flushingPlays || family == null) return;
    _flushingPlays = true;
    try {
      while (store.pendingPlays.isNotEmpty) {
        final batch = store.pendingPlays.take(50).toList();
        try {
          await api.postPlays(batch);
        } on ApiException catch (e) {
          if (e.status != 400) return; // 400: rejected for good, drop it
        } catch (_) {
          return; // offline
        }
        store.pendingPlays.removeRange(0, batch.length);
        await store.save();
      }
    } finally {
      _flushingPlays = false;
    }
  }

  // ---- Car: popular songs, nightly mixes, cover URLs ---------------------------------------

  /// The family's most played songs, most played first.
  List<Track> get popularTracks {
    final ids = store.popular.keys.toList()..sort((a, b) => store.popular[b]!.compareTo(store.popular[a]!));
    return [for (final id in ids) ?track(id)];
  }

  /// Songs I rated 4-5, best first (family popularity breaks ties).
  List<Track> get topRatedTracks {
    final ids = store.ratings.entries.where((e) => e.value >= 4).map((e) => e.key).toList()
      ..sort((a, b) {
        final c = store.ratings[b]!.compareTo(store.ratings[a]!);
        return c != 0 ? c : (store.popular[b] ?? 0).compareTo(store.popular[a] ?? 0);
      });
    return [for (final id in ids) ?track(id)];
  }

  /// Songs I rated well but have not played lately, in a shuffle that stays the same all day.
  List<Track> get rediscoverTracks {
    final recent = store.recent.toSet();
    final now = DateTime.now();
    final list = [for (final t in topRatedTracks) if (!recent.contains(t.id)) t];
    return list..shuffle(Random(now.year * 10000 + now.month * 100 + now.day));
  }

  /// The mix for [daypart]: the AI one from last night if there is one, else a local pick from ratings and popularity.
  ({String title, String subtitle, List<Track> tracks, Track? cover}) mixFor(String daypart) {
    final m = store.mixes[daypart];
    final fromServer = m == null ? <Track>[] : [for (final id in m.trackIds) ?track(id)];
    if (m != null && m.isThemed) {
      // A themed mix has no local stand-in: it is either on the phone or not offered.
      return (title: m.title, subtitle: _themedNote(m, fromServer), tracks: fromServer, cover: _coverOf(m, fromServer));
    }
    final now = DateTime.now();
    final tracks = fromServer.isNotEmpty
        ? fromServer
        : localMix(store.tracks.values, ratings: store.ratings, popular: store.popular, seed: now.year * 10000 + now.month * 100 + now.day);
    final title = '${greetingFor(daypart)} mix';
    final intro = fromServer.isNotEmpty && m!.intro.isNotEmpty ? m.intro : '${tracks.length} songs picked for you';
    return (title: title, subtitle: intro, tracks: tracks, cover: _coverOf(m, tracks));
  }

  /// The themed hours made last night (Vietnamese, pop, love songs, ...), in the server's order, without the thin ones.
  List<({String key, String title, String subtitle, List<Track> tracks, Track? cover})> get themedMixes {
    final list = store.mixes.values.where((m) => m.isThemed).toList()..sort((a, b) => a.rank.compareTo(b.rank));
    final out = <({String key, String title, String subtitle, List<Track> tracks, Track? cover})>[];
    for (final m in list) {
      final x = mixFor(m.daypart);
      if (x.tracks.length >= 5) out.add((key: m.daypart, title: x.title, subtitle: x.subtitle, tracks: x.tracks, cover: x.cover));
    }
    return out;
  }

  /// The cover the server chose for the mix when that song is known here and has one, else the first song with a cover.
  Track? _coverOf(Mix? m, List<Track> tracks) {
    final chosen = m == null || m.cover.isEmpty ? null : track(m.cover);
    if (chosen != null && chosen.hasArt && !chosen.isLocal) return chosen;
    for (final t in tracks) {
      if (t.hasArt && !t.isLocal) return t;
    }
    return null;
  }

  /// "Romantic songs for the long drive · 61 min · Artist, Artist": a few words for the car screen.
  String _themedNote(Mix m, List<Track> tracks) {
    final counts = <String, int>{};
    for (final t in tracks) {
      if (t.artist.isNotEmpty) counts[t.artist] = (counts[t.artist] ?? 0) + 1;
    }
    final artists = (counts.keys.toList()..sort((a, b) => counts[b]!.compareTo(counts[a]!))).take(3).toList();
    final who = artists.isEmpty ? '' : ' · ${artists.join(', ')}';
    return '${m.intro.isEmpty ? '${tracks.length} songs' : m.intro}$who';
  }

  final Map<String, String> _artUrls = {}; // signed car-sized cover URLs by track id
  int _artExp = 0; // epoch seconds when the cached URLs stop working

  /// Fetches signed cover URLs for [ids] that have none yet (the car's image loader cannot send the login header).
  /// Best-effort: on failure [artUriFor] falls back to the plain URL.
  Future<void> ensureArtUrls(Iterable<String> ids) async {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    if (_artExp - now < 1800) {
      _artUrls.clear(); // expired or about to
      _artExp = 0;
    }
    final need = ids.where((id) => !id.startsWith('local:') && !_artUrls.containsKey(id)).toSet().toList();
    for (var i = 0; i < need.length; i += 500) {
      try {
        final r = await api.artUrls(need.sublist(i, min(i + 500, need.length)));
        _artUrls.addAll(r.urls);
        _artExp = _artExp == 0 ? r.exp : min(_artExp, r.exp);
      } catch (_) {
        return; // offline or slow: plain URLs
      }
    }
  }

  /// The best cover URL for a track right now, or null when it has none.
  Uri? artUriFor(Track t) {
    if (!t.hasArt || t.isLocal) return null;
    return Uri.parse(_artUrls[t.id] ?? api.artUrl(t.id));
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
      try {
        await _pullRatings();
      } catch (_) {
        // Ratings are best-effort; the library itself synced.
      }
      try {
        await _flushPlays();
        store.popular = await api.getPopular();
        final mixes = await api.getMixes();
        if (mixes.isNotEmpty) store.mixes = {for (final m in mixes) m.daypart: m};
      } catch (_) {
        // The car lists are best-effort too; the cached ones (or a local pick) are used.
      }
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

  // ---- Ratings ----------------------------------------------------------------------------

  /// My rating of a song, 0 when unrated.
  int ratingOf(String id) => store.ratings[id] ?? 0;

  /// Rates a song (0 clears). Saved on the phone at once and uploaded when there is a connection.
  Future<void> rate(String id, int stars) async {
    if (id.startsWith('local:')) return; // phone files are not in the family library
    if (stars == 0) {
      store.ratings.remove(id);
    } else {
      store.ratings[id] = stars;
    }
    store.pendingRatings[id] = stars;
    await store.save();
    notifyListeners();
    unawaited(_flushRatings());
  }

  Future<void> _flushRatings() async {
    for (final e in store.pendingRatings.entries.toList()) {
      try {
        await api.putRating(e.key, e.value);
      } on ApiException catch (ex) {
        if (ex.status != 404 && ex.status != 400) return; // 404/400: rejected for good, drop it
      } catch (_) {
        return; // offline: keep the rest queued
      }
      if (store.pendingRatings[e.key] == e.value) store.pendingRatings.remove(e.key);
    }
    await store.save();
  }

  Future<void> _pullRatings() async {
    await _flushRatings();
    final server = await api.getRatings();
    for (final e in store.pendingRatings.entries) {
      if (e.value == 0) {
        server.remove(e.key);
      } else {
        server[e.key] = e.value;
      }
    }
    store.ratings = server;
  }

  /// A playlist and new-music ideas from my ratings, optionally for a mood. Needs a connection.
  Future<Suggestion> suggest(String prompt) async {
    await _flushRatings();
    return api.suggest(prompt);
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
