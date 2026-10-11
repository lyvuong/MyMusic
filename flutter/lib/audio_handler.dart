import 'dart:async';
import 'dart:math';

import 'package:audio_service/audio_service.dart';
import 'package:audio_session/audio_session.dart';
import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';

import 'mixes.dart';
import 'models.dart';
import 'state.dart';

/// The media session: notification and lock-screen controls, and the browse tree that Android
/// Auto (and other MediaBrowser clients) show on the car screen.
///
/// Browse tree (media ids): root -> foryou | albums | recent | library.
///   foryou  -> `mix:daypart` | pop | top | redisc  (AI mix of the hour, popular, top rated, rediscover)
///   library -> playlists | artists | dl | all
/// Playable items are `t:<trackId>|<context>` so that picking a song on the car screen queues the whole
/// list it was picked from (context `dl`, `all`, `recent`, `pl:id`, `al:album`, `ar:artist`,
/// `mix:daypart`, `pop`, `top`, `redisc`). `play:context` and `shuffle:context` start a whole list.
///
/// One track is loaded at a time (rather than a gapless playlist) so every track gets a fresh
/// auth token and a downloaded file is preferred over streaming.
class MyAudioHandler extends BaseAudioHandler with SeekHandler {
  MyAudioHandler(this.app) {
    _init();
  }

  final AppState app;
  final _player = AudioPlayer();
  final _rng = Random();

  List<Track> _tracks = [];
  List<MediaItem> _items = [];
  List<int> _order = []; // play order as indices into _tracks
  int _pos = -1; // position in _order
  bool _shuffle = false;
  AudioServiceRepeatMode _repeat = AudioServiceRepeatMode.none;
  int _gen = 0; // bumped on every load so a slow, superseded load is ignored
  int _failures = 0;

  /// The last reason a track could not be loaded, for the UI to show (null when none).
  final playError = ValueNotifier<String?>(null);

  Future<void> _init() async {
    final session = await AudioSession.instance;
    await session.configure(const AudioSessionConfiguration.music());
    _player.playbackEventStream.listen((_) => _broadcast(), onError: (Object e, StackTrace st) => _broadcast());
    _player.processingStateStream.listen((s) {
      if (s == ProcessingState.completed) unawaited(_onCompleted());
    });
  }

  // ---- Playback state -----------------------------------------------------------------------

  void _broadcast() {
    final playing = _player.playing;
    playbackState.add(PlaybackState(
      controls: [
        MediaControl.skipToPrevious,
        if (playing) MediaControl.pause else MediaControl.play,
        MediaControl.skipToNext,
        MediaControl.custom(
          androidIcon: _loved ? 'drawable/ic_favorite' : 'drawable/ic_favorite_border',
          label: _loved ? 'Loved' : 'Love',
          name: 'love',
        ),
        MediaControl.stop,
      ],
      systemActions: const {MediaAction.seek, MediaAction.seekForward, MediaAction.seekBackward},
      androidCompactActionIndices: const [0, 1, 2],
      processingState: const {
        ProcessingState.idle: AudioProcessingState.idle,
        ProcessingState.loading: AudioProcessingState.loading,
        ProcessingState.buffering: AudioProcessingState.buffering,
        ProcessingState.ready: AudioProcessingState.ready,
        ProcessingState.completed: AudioProcessingState.completed,
      }[_player.processingState]!,
      playing: playing,
      updatePosition: _player.position,
      bufferedPosition: _player.bufferedPosition,
      speed: _player.speed,
      queueIndex: _pos < 0 || _pos >= _order.length ? null : _order[_pos],
      repeatMode: _repeat,
      shuffleMode: _shuffle ? AudioServiceShuffleMode.all : AudioServiceShuffleMode.none,
    ));
  }

  // ---- Queue --------------------------------------------------------------------------------

  /// Replaces the queue with [tracks] and starts playing at [index].
  Future<void> playQueue(List<Track> tracks, int index) async {
    if (tracks.isEmpty) return;
    _tracks = tracks;
    final headers = await _artHeaders();
    await app.ensureArtUrls(tracks.take(100).map((t) => t.id));
    _items = [for (final t in tracks) _item(t, headers)];
    queue.add(_items);
    _order = List.generate(tracks.length, (i) => i);
    if (_shuffle) _shuffleKeeping(index);
    _pos = _order.indexOf(index);
    _failures = 0;
    await _playPos(_pos);
  }

  void _shuffleKeeping(int first) {
    _order = List.generate(_tracks.length, (i) => i)..remove(first);
    _order.shuffle(_rng);
    _order.insert(0, first);
  }

  Future<Map<String, String>> _artHeaders() async {
    try {
      return await app.api.authHeaders();
    } catch (_) {
      return const {};
    }
  }

  MediaItem _item(Track t, Map<String, String> headers, {String ctx = ''}) => MediaItem(
        id: 't:${t.id}${ctx.isEmpty ? '' : '|$ctx'}',
        title: t.title,
        artist: t.artist.isEmpty ? null : t.artist,
        album: t.album.isEmpty ? null : t.album,
        duration: t.duration > 0 ? Duration(milliseconds: (t.duration * 1000).round()) : null,
        artUri: app.artUriFor(t),
        artHeaders: headers,
        playable: true,
        extras: {'trackId': t.id},
      );

  Future<AudioSource> _sourceFor(Track t) async {
    final file = app.localPath(t);
    if (file != null) return AudioSource.file(file);
    if (t.isLocal) return AudioSource.uri(Uri.parse(t.uri!));
    return AudioSource.uri(app.api.streamUri(t.id), headers: await app.api.authHeaders());
  }

  Future<void> _playPos(int pos) async {
    if (pos < 0 || pos >= _order.length) return;
    final gen = ++_gen;
    _pos = pos;
    final i = _order[pos];
    final track = _tracks[i];
    mediaItem.add(_items[i]);
    _broadcast();
    try {
      final source = await _sourceFor(track);
      if (gen != _gen) return;
      await _player.setAudioSource(source);
      if (gen != _gen) return;
      _failures = 0;
      app.markPlayed(track.id);
      unawaited(_player.play());
    } catch (e) {
      if (gen != _gen) return;
      playError.value = "Can't play \"${track.title}\": $e";
      // Not downloaded and no connection (or removed on the server): move on, but stop if the whole queue fails.
      if (++_failures < _order.length && pos + 1 < _order.length) {
        await _playPos(pos + 1);
      } else {
        await _player.stop();
      }
    }
  }

  Future<void> _onCompleted() async {
    if (_repeat == AudioServiceRepeatMode.one) {
      await _player.seek(Duration.zero);
      unawaited(_player.play());
    } else if (_pos + 1 < _order.length) {
      await _playPos(_pos + 1);
    } else if (_repeat == AudioServiceRepeatMode.all && _order.isNotEmpty) {
      await _playPos(0);
    } else {
      await _player.pause();
    }
  }

  @override
  Future<void> play() => _player.play();

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> seek(Duration position) => _player.seek(position);

  @override
  Future<void> stop() async {
    _gen++;
    await _player.stop();
    return super.stop();
  }

  @override
  Future<void> skipToNext() async {
    if (_pos + 1 < _order.length) {
      await _playPos(_pos + 1);
    } else if (_repeat == AudioServiceRepeatMode.all && _order.isNotEmpty) {
      await _playPos(0);
    }
  }

  @override
  Future<void> skipToPrevious() async {
    if (_player.position > const Duration(seconds: 3) || _pos <= 0) {
      await _player.seek(Duration.zero);
    } else {
      await _playPos(_pos - 1);
    }
  }

  @override
  Future<void> skipToQueueItem(int index) async {
    final pos = _order.indexOf(index);
    if (pos >= 0) await _playPos(pos);
  }

  @override
  Future<void> setShuffleMode(AudioServiceShuffleMode shuffleMode) async {
    _shuffle = shuffleMode != AudioServiceShuffleMode.none;
    if (_order.isNotEmpty && _pos >= 0) {
      final current = _order[_pos];
      if (_shuffle) {
        _shuffleKeeping(current);
      } else {
        _order = List.generate(_tracks.length, (i) => i);
      }
      _pos = _order.indexOf(current);
    }
    _broadcast();
  }

  @override
  Future<void> setRepeatMode(AudioServiceRepeatMode repeatMode) async {
    _repeat = repeatMode;
    _broadcast();
  }

  // ---- Browse tree (Android Auto) -----------------------------------------------------------

  /// Hints for the car: folders under this one are shown as a grid of covers.
  static const _gridChildren = {
    AndroidContentStyle.supportedKey: true,
    AndroidContentStyle.browsableHintKey: AndroidContentStyle.gridItemHintValue,
    AndroidContentStyle.playableHintKey: AndroidContentStyle.listItemHintValue,
  };

  MediaItem _folder(String id, String title, {String? subtitle, Track? art, bool grid = false}) => MediaItem(
        id: id,
        title: title,
        displayDescription: subtitle,
        artUri: art == null ? null : app.artUriFor(art),
        playable: false,
        extras: grid ? _gridChildren : null,
      );

  static String _enc(String s) => Uri.encodeComponent(s);

  /// The tracks behind a context id (see class comment).
  List<Track> _context(String ctx) {
    final all = app.allTracks;
    if (ctx == 'dl') return [...app.downloadedTracks, ...app.store.phoneTracks.values];
    if (ctx == 'recent') return app.recentTracks;
    if (ctx == 'pop') return app.popularTracks;
    if (ctx == 'top') return app.topRatedTracks;
    if (ctx == 'redisc') return app.rediscoverTracks;
    if (ctx.startsWith('mix:')) return app.mixFor(ctx.substring(4)).tracks;
    if (ctx.startsWith('pl:')) {
      final p = app.store.playlists[ctx.substring(3)];
      return p == null ? [] : app.tracksOf(p);
    }
    if (ctx.startsWith('al:')) {
      final name = Uri.decodeComponent(ctx.substring(3));
      return all.where((t) => t.album == name).toList()..sort((a, b) => a.trackNo.compareTo(b.trackNo));
    }
    if (ctx.startsWith('ar:')) {
      final name = Uri.decodeComponent(ctx.substring(3));
      return all.where((t) => t.artist == name).toList();
    }
    return all;
  }

  /// First track of [tracks] that has a cover, to stand in for a folder's picture.
  static Track? _artOf(Iterable<Track> tracks) {
    for (final t in tracks) {
      if (t.hasArt && !t.isLocal) return t;
    }
    return null;
  }

  List<MediaItem> _rootFolders() => [
        _folder('foryou', 'For You', subtitle: '${greetingFor(daypartOf(DateTime.now()))} mix, popular, top rated', grid: true),
        _folder('albums', 'Albums', grid: true),
        _folder('recent', 'Recently played'),
        _folder('library', 'Library', subtitle: 'Playlists, artists, downloads, all songs'),
      ];

  List<MediaItem> _forYou() {
    final dp = daypartOf(DateTime.now());
    final mix = app.mixFor(dp);
    final pop = app.popularTracks;
    final top = app.topRatedTracks;
    final redisc = app.rediscoverTracks;
    return [
      _folder('mix:$dp', mix.title, subtitle: mix.subtitle, art: _artOf(mix.tracks)),
      if (pop.isNotEmpty) _folder('pop', 'Popular with the family', subtitle: '${pop.length} songs', art: _artOf(pop)),
      if (top.isNotEmpty) _folder('top', 'Your top rated', subtitle: '${top.length} songs', art: _artOf(top)),
      if (redisc.length >= 5) _folder('redisc', 'Rediscover', subtitle: 'Loved songs you have not heard lately', art: _artOf(redisc)),
    ];
  }

  List<MediaItem> _library() => [
        _folder('playlists', 'Playlists', grid: true),
        _folder('artists', 'Artists', grid: true),
        _folder('dl', 'Downloaded', subtitle: 'Plays offline'),
        _folder('all', 'All songs'),
      ];

  /// Albums by artist then title, each with its cover and artist.
  List<MediaItem> _albumFolders() {
    final byAlbum = <String, List<Track>>{};
    for (final t in app.allTracks) {
      if (t.album.isNotEmpty) (byAlbum[t.album] ??= []).add(t);
    }
    final entries = byAlbum.entries.map((e) {
      final artists = {for (final t in e.value) if (t.artist.isNotEmpty) t.artist};
      return (name: e.key, artist: artists.length == 1 ? artists.first : (artists.isEmpty ? '' : 'Various artists'), tracks: e.value);
    }).toList()
      ..sort((a, b) {
        final c = a.artist.toLowerCase().compareTo(b.artist.toLowerCase());
        return c != 0 ? c : a.name.toLowerCase().compareTo(b.name.toLowerCase());
      });
    return [for (final a in entries) _folder('al:${_enc(a.name)}', a.name, subtitle: a.artist, art: _artOf(a.tracks))];
  }

  List<MediaItem> _artistFolders() {
    final by = <String, List<Track>>{};
    for (final t in app.allTracks) {
      if (t.artist.isNotEmpty) (by[t.artist] ??= []).add(t);
    }
    final names = by.keys.toList()..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
    return [for (final a in names) _folder('ar:${_enc(a)}', a, subtitle: '${by[a]!.length} songs', art: _artOf(by[a]!))];
  }

  List<MediaItem> _playlistFolders() => [
        for (final p in app.playlists) _folder('pl:${p.id}', p.name, subtitle: '${p.trackIds.length} songs', art: _artOf(app.tracksOf(p))),
      ];

  /// The track whose cover stands in for each album / artist / playlist folder, for one batch of signed URLs.
  List<String> _folderArtIds(String folder) {
    final groups = <String, Track>{};
    switch (folder) {
      case 'albums':
        for (final t in app.allTracks) {
          if (t.album.isNotEmpty && t.hasArt && !t.isLocal) groups.putIfAbsent(t.album, () => t);
        }
      case 'artists':
        for (final t in app.allTracks) {
          if (t.artist.isNotEmpty && t.hasArt && !t.isLocal) groups.putIfAbsent(t.artist, () => t);
        }
      case 'playlists':
        for (final p in app.playlists) {
          final t = _artOf(app.tracksOf(p));
          if (t != null) groups[p.id] = t;
        }
    }
    return [for (final t in groups.values) t.id];
  }

  @override
  Future<List<MediaItem>> getChildren(String parentMediaId, [Map<String, dynamic>? options]) async {
    if (parentMediaId == AudioService.browsableRootId) return _rootFolders();
    // Car covers need signed URLs: fetch them for what this folder shows (one request), then build the items.
    switch (parentMediaId) {
      case 'library':
        return _library();
      case 'foryou':
        final dp = daypartOf(DateTime.now());
        await app.ensureArtUrls([...app.mixFor(dp).tracks, ...app.popularTracks, ...app.topRatedTracks].take(60).map((t) => t.id));
        return _forYou();
      case 'albums':
        await app.ensureArtUrls(_folderArtIds('albums'));
        return _albumFolders();
      case 'artists':
        await app.ensureArtUrls(_folderArtIds('artists'));
        return _artistFolders();
      case 'playlists':
        await app.ensureArtUrls(_folderArtIds('playlists'));
        return _playlistFolders();
    }
    final tracks = _context(parentMediaId);
    final shown = tracks.take(500).toList();
    await app.ensureArtUrls(shown.map((t) => t.id));
    final headers = await _artHeaders();
    final cover = _artOf(shown);
    final coverUri = cover == null ? null : app.artUriFor(cover);
    return [
      if (shown.length > 1 && parentMediaId != 'all') ...[
        MediaItem(id: 'play:$parentMediaId', title: 'Play all', displayDescription: '${tracks.length} songs', artUri: coverUri, playable: true),
        MediaItem(id: 'shuffle:$parentMediaId', title: 'Shuffle', artUri: coverUri, playable: true),
      ],
      for (final t in shown) _item(t, headers, ctx: parentMediaId),
    ];
  }

  @override
  Future<MediaItem?> getMediaItem(String mediaId) async {
    final track = app.track(_trackIdOf(mediaId));
    return track == null ? null : _item(track, await _artHeaders());
  }

  static String _trackIdOf(String mediaId) {
    final bar = mediaId.indexOf('|');
    return (bar < 0 ? mediaId : mediaId.substring(0, bar)).replaceFirst('t:', '');
  }

  @override
  Future<void> playFromMediaId(String mediaId, [Map<String, dynamic>? extras]) async {
    if (mediaId.startsWith('play:') || mediaId.startsWith('shuffle:')) {
      final shuffle = mediaId.startsWith('shuffle:');
      final list = [..._context(mediaId.substring(mediaId.indexOf(':') + 1))];
      if (shuffle) list.shuffle(_rng);
      await playQueue(list, 0);
      return;
    }
    final id = _trackIdOf(mediaId);
    final bar = mediaId.indexOf('|');
    final list = bar < 0 ? <Track>[] : _context(mediaId.substring(bar + 1));
    var index = list.indexWhere((t) => t.id == id);
    if (index < 0) {
      final t = app.track(id);
      if (t == null) return;
      await playQueue([t], 0);
    } else {
      await playQueue(list, index);
    }
  }

  // ---- Love (5 stars) from the car, which feeds the AI mixes --------------------------------

  String? get _currentId => _pos < 0 || _pos >= _order.length ? null : _tracks[_order[_pos]].id;

  bool get _loved {
    final id = _currentId;
    return id != null && app.ratingOf(id) >= 5;
  }

  @override
  Future<dynamic> customAction(String name, [Map<String, dynamic>? extras]) async {
    if (name == 'love') {
      final id = _currentId;
      if (id != null) {
        await app.rate(id, _loved ? 0 : 5);
        _broadcast();
      }
      return null;
    }
    return super.customAction(name, extras);
  }

  // ---- Search / voice ("Hey Google, play ...") ----------------------------------------------

  List<Track> _find(String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return [];
    return app.allTracks
        .where((t) => t.title.toLowerCase().contains(q) || t.artist.toLowerCase().contains(q) || t.album.toLowerCase().contains(q))
        .toList();
  }

  @override
  Future<List<MediaItem>> search(String query, [Map<String, dynamic>? extras]) async {
    final headers = await _artHeaders();
    return [for (final t in _find(query).take(100)) _item(t, headers)];
  }

  @override
  Future<void> playFromSearch(String query, [Map<String, dynamic>? extras]) async {
    var hits = _find(query);
    if (hits.isEmpty) {
      // "Play music" with no specific request: shuffle what is available offline, else everything.
      hits = _context('dl');
      if (hits.isEmpty) hits = app.allTracks;
      hits = [...hits]..shuffle(_rng);
    }
    await playQueue(hits, 0);
  }
}
