import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;

import 'env.dart';
import 'models.dart';

class ApiException implements Exception {
  ApiException(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

/// Talks to the Worker. Every call sends the current Firebase ID token.
class ApiClient {
  String? _token; // last known token, for image loaders that can't await

  void watchToken() {
    FirebaseAuth.instance.idTokenChanges().listen((u) async => _token = await u?.getIdToken());
  }

  Future<Map<String, String>> authHeaders() async {
    final t = await FirebaseAuth.instance.currentUser?.getIdToken();
    if (t == null) throw ApiException(401, 'Not signed in');
    _token = t;
    return {'Authorization': 'Bearer $t'};
  }

  Map<String, String> get headersSync => _token == null ? {} : {'Authorization': 'Bearer $_token'};

  Uri streamUri(String id) => Uri.parse('${Env.apiUrl}/api/stream/$id');
  String artUrl(String id) => '${Env.apiUrl}/api/art/$id';

  Future<dynamic> _send(String method, String path, {Object? body, Duration timeout = const Duration(seconds: 20)}) async {
    final req = http.Request(method, Uri.parse('${Env.apiUrl}$path'));
    req.headers.addAll(await authHeaders());
    if (body != null) {
      req.headers['Content-Type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    final res = await http.Response.fromStream(await req.send().timeout(timeout));
    if (res.statusCode >= 300) {
      var msg = 'Request failed (${res.statusCode})';
      try {
        msg = (jsonDecode(res.body) as Map<String, dynamic>)['error'] as String? ?? msg;
      } catch (_) {}
      throw ApiException(res.statusCode, msg);
    }
    return res.body.isEmpty ? null : jsonDecode(res.body);
  }

  /// The caller's family, or null if they have none yet.
  Future<FamilyInfo?> getFamily() async {
    try {
      return FamilyInfo.fromJson(await _send('GET', '/api/family') as Map<String, dynamic>);
    } on ApiException catch (e) {
      if (e.status == 404) return null;
      rethrow;
    }
  }

  Future<FamilyInfo> createFamily(String name) async =>
      FamilyInfo.fromJson(await _send('POST', '/api/family', body: {'name': name}) as Map<String, dynamic>);

  Future<FamilyInfo> joinFamily(String code) async =>
      FamilyInfo.fromJson(await _send('POST', '/api/family/join', body: {'code': code}) as Map<String, dynamic>);

  Future<String> createInvite() async => (await _send('POST', '/api/family/invites') as Map<String, dynamic>)['code'] as String;

  Future<void> removeMember(String uid) => _send('DELETE', '/api/family/members/$uid');

  Future<void> deleteAccount() => _send('DELETE', '/api/account');

  /// Tracks and playlists changed since [since]; deleted ones come back flagged.
  Future<({int now, List<(Track, bool)> tracks, List<(Playlist, bool)> playlists})> library(int since) async {
    final j = await _send('GET', '/api/library?since=$since') as Map<String, dynamic>;
    return (
      now: (j['now'] as num).toInt(),
      tracks: [for (final t in j['tracks'] as List) (Track.fromJson(t as Map<String, dynamic>), (t['deleted'] as bool?) ?? false)],
      playlists: [for (final p in j['playlists'] as List) (Playlist.fromJson(p as Map<String, dynamic>), (p['deleted'] as bool?) ?? false)],
    );
  }

  Future<void> putPlaylist(Playlist p) =>
      _send('PUT', '/api/playlists/${p.id}', body: {'name': p.name, 'shared': p.shared, 'trackIds': p.trackIds});

  Future<void> deletePlaylist(String id) => _send('DELETE', '/api/playlists/$id');

  /// My ratings by track id.
  Future<Map<String, int>> getRatings() async {
    final j = await _send('GET', '/api/ratings') as Map<String, dynamic>;
    return (j['ratings'] as Map).map((k, v) => MapEntry(k as String, (v as num).toInt()));
  }

  /// 1-5 stars; 0 clears the rating.
  Future<void> putRating(String trackId, int stars) => _send('PUT', '/api/ratings/$trackId', body: {'rating': stars});

  Future<Suggestion> suggest(String prompt) async =>
      Suggestion.fromJson(await _send('POST', '/api/suggest', body: {'prompt': prompt}, timeout: const Duration(seconds: 90)) as Map<String, dynamic>);

  /// Uploads plays (`{'id', 'at'}`); the server ignores songs it does not know.
  Future<void> postPlays(List<Map<String, dynamic>> plays) => _send('POST', '/api/plays', body: {
        'plays': [for (final p in plays) {'trackId': p['id'], 'at': p['at']}],
      });

  /// The family's play counts by track id.
  Future<Map<String, int>> getPopular() async {
    final j = await _send('GET', '/api/popular') as Map<String, dynamic>;
    return {for (final t in j['tracks'] as List) (t as Map)['id'] as String: (t['plays'] as num).toInt()};
  }

  /// My nightly AI mixes.
  Future<List<Mix>> getMixes() async {
    final j = await _send('GET', '/api/mixes') as Map<String, dynamic>;
    return [for (final m in j['mixes'] as List) Mix.fromJson(m as Map<String, dynamic>)];
  }

  /// Signed, car-sized cover URLs (no login header needed) and when they stop working (epoch seconds).
  Future<({Map<String, String> urls, int exp})> artUrls(List<String> ids) async {
    final j = await _send('POST', '/api/art-urls', body: {'ids': ids}, timeout: const Duration(seconds: 8)) as Map<String, dynamic>;
    return (urls: (j['urls'] as Map).cast<String, String>(), exp: (j['exp'] as num).toInt());
  }
}
