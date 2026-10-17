import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'models.dart';

/// Everything the app needs to browse and play with no network: the synced library, playlists,
/// downloads index, phone tracks, and playlist edits waiting to be uploaded. One JSON file.
class LocalStore {
  LocalStore._(this._file);
  final File _file;

  int since = 0;
  FamilyInfo? family;
  Map<String, Track> tracks = {};
  Map<String, Playlist> playlists = {};
  Map<String, Track> phoneTracks = {};
  Map<String, int> downloads = {}; // track id -> bytes on disk
  List<String> recent = [];
  List<Map<String, String>> pending = []; // {'op': 'put'|'delete', 'id': playlistId}
  Map<String, int> ratings = {}; // my 1-5 star ratings by track id
  Map<String, int> pendingRatings = {}; // ratings not uploaded yet (0 = cleared)
  List<Map<String, dynamic>> pendingPlays = []; // {'id': trackId, 'at': epoch ms, 'skip': true for a skip} not uploaded yet
  Map<String, int> popular = {}; // family play counts by track id
  Map<String, Mix> mixes = {}; // my nightly AI mixes by day-part

  static Future<LocalStore> open() async {
    final dir = await getApplicationDocumentsDirectory();
    final s = LocalStore._(File('${dir.path}/library.json'));
    if (s._file.existsSync()) {
      try {
        s._load(jsonDecode(await s._file.readAsString()) as Map<String, dynamic>);
      } catch (_) {
        // A corrupt index only costs a re-sync; downloaded files are re-found by id.
      }
    }
    return s;
  }

  void _load(Map<String, dynamic> j) {
    since = (j['since'] as num?)?.toInt() ?? 0;
    family = j['family'] == null ? null : FamilyInfo.fromJson(j['family'] as Map<String, dynamic>);
    final saved = j['tracks'] as List? ?? [];
    tracks = {for (final t in saved) (t as Map<String, dynamic>)['id'] as String: Track.fromJson(t)};
    // A library saved before songs carried the AI flag: read it all again once to learn which songs are AI.
    if (saved.isNotEmpty && !(saved.first as Map).containsKey('ai')) since = 0;
    playlists = {for (final p in (j['playlists'] as List? ?? [])) (p as Map<String, dynamic>)['id'] as String: Playlist.fromJson(p)};
    phoneTracks = {for (final t in (j['phoneTracks'] as List? ?? [])) (t as Map<String, dynamic>)['id'] as String: Track.fromJson(t)};
    downloads = ((j['downloads'] as Map?) ?? {}).map((k, v) => MapEntry(k as String, (v as num).toInt()));
    recent = ((j['recent'] as List?) ?? []).cast<String>().toList();
    pending = ((j['pending'] as List?) ?? []).map((e) => (e as Map).cast<String, String>()).toList();
    ratings = ((j['ratings'] as Map?) ?? {}).map((k, v) => MapEntry(k as String, (v as num).toInt()));
    pendingRatings = ((j['pendingRatings'] as Map?) ?? {}).map((k, v) => MapEntry(k as String, (v as num).toInt()));
    pendingPlays = ((j['pendingPlays'] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    popular = ((j['popular'] as Map?) ?? {}).map((k, v) => MapEntry(k as String, (v as num).toInt()));
    mixes = {for (final m in (j['mixes'] as List? ?? [])) (m as Map<String, dynamic>)['daypart'] as String: Mix.fromJson(m)};
  }

  Future<void> save() async {
    final j = {
      'since': since,
      'family': family?.toJson(),
      'tracks': tracks.values.map((t) => t.toJson()).toList(),
      'playlists': playlists.values.map((p) => p.toJson()).toList(),
      'phoneTracks': phoneTracks.values.map((t) => t.toJson()).toList(),
      'downloads': downloads,
      'recent': recent,
      'pending': pending,
      'ratings': ratings,
      'pendingRatings': pendingRatings,
      'pendingPlays': pendingPlays,
      'popular': popular,
      'mixes': mixes.values.map((m) => m.toJson()).toList(),
    };
    final tmp = File('${_file.path}.tmp');
    await tmp.writeAsString(jsonEncode(j), flush: true);
    await tmp.rename(_file.path); // atomic: a crash mid-write never leaves a half file
  }

  /// Signing out removes the family's library from this phone (downloads are deleted by AppState).
  void clearAccountData() {
    since = 0;
    family = null;
    tracks = {};
    playlists = {};
    downloads = {};
    recent = [];
    pending = [];
    ratings = {};
    pendingRatings = {};
    pendingPlays = [];
    popular = {};
    mixes = {};
  }
}
