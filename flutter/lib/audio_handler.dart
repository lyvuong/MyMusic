import 'dart:async';
import 'dart:math';

import 'package:audio_service/audio_service.dart';
import 'package:audio_session/audio_session.dart';
import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';

import 'models.dart';
import 'state.dart';

/// The media session: notification and lock-screen controls, and the browse tree that Android
/// Auto (and other MediaBrowser clients) show on the car screen.
///
/// Browse tree (media ids): root -> dl | playlists | recent | albums | artists | all. Playable items
/// are `t:<trackId>|<context>` so that picking a song on the car screen queues the whole list it
/// was picked from (context `dl`, `all`, `recent`, `pl:<id>`, `al:<album>`, `ar:<artist>`).
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
        artUri: t.hasArt && !t.isLocal ? Uri.parse(app.api.artUrl(t.id)) : null,
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

  MediaItem _folder(String id, String title, {String? subtitle}) =>
      MediaItem(id: id, title: title, displayDescription: subtitle, playable: false);

  static String _enc(String s) => Uri.encodeComponent(s);

  /// The tracks behind a context id (see class comment).
  List<Track> _context(String ctx) {
    final all = app.allTracks;
    if (ctx == 'dl') return [...app.downloadedTracks, ...app.store.phoneTracks.values];
    if (ctx == 'recent') return app.recentTracks;
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

  @override
  Future<List<MediaItem>> getChildren(String parentMediaId, [Map<String, dynamic>? options]) async {
    if (parentMediaId == AudioService.browsableRootId) {
      return [
        _folder('dl', 'Downloaded', subtitle: 'Plays offline'),
        _folder('playlists', 'Playlists'),
        _folder('recent', 'Recently played'),
        _folder('albums', 'Albums'),
        _folder('artists', 'Artists'),
        _folder('all', 'All songs'),
      ];
    }
    switch (parentMediaId) {
      case 'playlists':
        return [for (final p in app.playlists) _folder('pl:${p.id}', p.name, subtitle: '${p.trackIds.length} songs')];
      case 'albums':
        final albums = {for (final t in app.allTracks) if (t.album.isNotEmpty) t.album}.toList()..sort();
        return [for (final a in albums) _folder('al:${_enc(a)}', a)];
      case 'artists':
        final artists = {for (final t in app.allTracks) if (t.artist.isNotEmpty) t.artist}.toList()..sort();
        return [for (final a in artists) _folder('ar:${_enc(a)}', a)];
    }
    final headers = await _artHeaders();
    // Car screens cap long lists anyway; keep the payload small.
    return [for (final t in _context(parentMediaId).take(300)) _item(t, headers, ctx: parentMediaId)];
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
