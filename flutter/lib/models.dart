/// A song. `source` is 'r2' / 'nas' (served by the Worker) or 'local' (a file on this phone, `uri` is a content URI).
class Track {
  const Track({
    required this.id,
    required this.source,
    required this.title,
    this.artist = '',
    this.album = '',
    this.duration = 0,
    this.trackNo = 0,
    this.hasArt = false,
    this.size = 0,
    this.etag = '',
    this.uri,
  });

  final String id;
  final String source;
  final String title;
  final String artist;
  final String album;
  final double duration; // seconds
  final int trackNo;
  final bool hasArt;
  final int size;
  final String etag;
  final String? uri;

  bool get isLocal => source == 'local';

  factory Track.fromJson(Map<String, dynamic> j) => Track(
        id: j['id'] as String,
        source: j['source'] as String,
        title: j['title'] as String,
        artist: (j['artist'] as String?) ?? '',
        album: (j['album'] as String?) ?? '',
        duration: (j['duration'] as num?)?.toDouble() ?? 0,
        trackNo: (j['trackNo'] as num?)?.toInt() ?? 0,
        hasArt: (j['hasArt'] as bool?) ?? false,
        size: (j['size'] as num?)?.toInt() ?? 0,
        etag: (j['etag'] as String?) ?? '',
        uri: j['uri'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'source': source,
        'title': title,
        'artist': artist,
        'album': album,
        'duration': duration,
        'trackNo': trackNo,
        'hasArt': hasArt,
        'size': size,
        'etag': etag,
        if (uri != null) 'uri': uri,
      };
}

class Playlist {
  Playlist({
    required this.id,
    required this.name,
    required this.ownerUid,
    this.shared = false,
    List<String>? trackIds,
    this.updatedAt = 0,
  }) : trackIds = trackIds ?? [];

  final String id;
  String name;
  final String ownerUid;
  bool shared;
  List<String> trackIds;
  int updatedAt;

  factory Playlist.fromJson(Map<String, dynamic> j) => Playlist(
        id: j['id'] as String,
        name: j['name'] as String,
        ownerUid: (j['ownerUid'] as String?) ?? '',
        shared: (j['shared'] as bool?) ?? false,
        trackIds: ((j['trackIds'] as List?) ?? []).cast<String>().toList(),
        updatedAt: (j['updatedAt'] as num?)?.toInt() ?? 0,
      );

  Map<String, dynamic> toJson() =>
      {'id': id, 'name': name, 'ownerUid': ownerUid, 'shared': shared, 'trackIds': trackIds, 'updatedAt': updatedAt};
}

class Member {
  const Member({required this.uid, required this.displayName, required this.email, required this.role});
  final String uid;
  final String displayName;
  final String email;
  final String role;

  factory Member.fromJson(Map<String, dynamic> j) => Member(
        uid: j['uid'] as String,
        displayName: (j['displayName'] as String?) ?? '',
        email: (j['email'] as String?) ?? '',
        role: j['role'] as String,
      );

  Map<String, dynamic> toJson() => {'uid': uid, 'displayName': displayName, 'email': email, 'role': role};
}

class FamilyInfo {
  const FamilyInfo({required this.id, required this.name, required this.role, required this.members});
  final String id;
  final String name;
  final String role;
  final List<Member> members;

  bool get isOwner => role == 'owner';

  factory FamilyInfo.fromJson(Map<String, dynamic> j) => FamilyInfo(
        id: j['id'] as String,
        name: j['name'] as String,
        role: j['role'] as String,
        members: ((j['members'] as List?) ?? []).map((m) => Member.fromJson(m as Map<String, dynamic>)).toList(),
      );

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'role': role, 'members': members.map((m) => m.toJson()).toList()};
}

/// An AI listening suggestion: a playlist from the library plus artists to discover.
class Suggestion {
  const Suggestion({required this.title, required this.intro, required this.tracks, required this.discover});
  final String title;
  final String intro;
  final List<({String id, String why})> tracks;
  final List<({String artist, String album, String why})> discover;

  factory Suggestion.fromJson(Map<String, dynamic> j) => Suggestion(
        title: (j['title'] as String?) ?? '',
        intro: (j['intro'] as String?) ?? '',
        tracks: [for (final t in (j['tracks'] as List? ?? [])) (id: t['id'] as String, why: (t['why'] as String?) ?? '')],
        discover: [
          for (final d in (j['discover'] as List? ?? []))
            (artist: d['artist'] as String, album: (d['album'] as String?) ?? '', why: (d['why'] as String?) ?? ''),
        ],
      );
}

/// A nightly mix built on the server: the AI one for a time of day (key morning | afternoon | evening | night), or a
/// themed hour of music (key `theme-...`: Vietnamese, pop, love songs, ...) drawn from the whole library.
class Mix {
  const Mix({
    required this.daypart,
    required this.title,
    required this.intro,
    required this.trackIds,
    required this.generatedAt,
    this.cover = '',
    this.rank = 0,
  });
  final String daypart;
  final String title;
  final String intro;
  final List<String> trackIds;
  final int generatedAt; // epoch ms
  final String cover; // id of the song whose cover stands for the mix, '' when not chosen
  final int rank; // order of the themed mixes

  bool get isThemed => daypart.startsWith('theme-');

  factory Mix.fromJson(Map<String, dynamic> j) => Mix(
        daypart: j['daypart'] as String,
        title: (j['title'] as String?) ?? '',
        intro: (j['intro'] as String?) ?? '',
        trackIds: ((j['trackIds'] as List?) ?? []).cast<String>().toList(),
        generatedAt: (j['generatedAt'] as num?)?.toInt() ?? 0,
        cover: (j['cover'] as String?) ?? '',
        rank: (j['rank'] as num?)?.toInt() ?? 0,
      );

  Map<String, dynamic> toJson() =>
      {'daypart': daypart, 'title': title, 'intro': intro, 'trackIds': trackIds, 'generatedAt': generatedAt, 'cover': cover, 'rank': rank};
}
