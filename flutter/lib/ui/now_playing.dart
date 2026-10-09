import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';

import '../models.dart';
import '../scope.dart';
import 'widgets.dart';

class MiniPlayer extends StatelessWidget {
  const MiniPlayer({super.key});

  @override
  Widget build(BuildContext context) {
    final audio = context.audio;
    return StreamBuilder<MediaItem?>(
      stream: audio.mediaItem,
      builder: (context, snap) {
        final item = snap.data;
        if (item == null) return const SizedBox.shrink();
        final track = context.app.track(item.extras?['trackId'] as String? ?? '');
        return Material(
          color: Theme.of(context).colorScheme.surfaceContainerHigh,
          child: InkWell(
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(fullscreenDialog: true, builder: (_) => const NowPlayingScreen())),
            child: SizedBox(
              height: 64,
              child: Row(children: [
                const SizedBox(width: 8),
                if (track != null) TrackArt(track, size: 48) else const SizedBox(width: 48),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(item.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                    if (item.artist != null) Text(item.artist!, maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodySmall),
                  ]),
                ),
                StreamBuilder<PlaybackState>(
                  stream: audio.playbackState,
                  builder: (context, s) {
                    final playing = s.data?.playing ?? false;
                    return IconButton(
                      icon: Icon(playing ? Icons.pause : Icons.play_arrow),
                      onPressed: playing ? audio.pause : audio.play,
                    );
                  },
                ),
                IconButton(icon: const Icon(Icons.skip_next), onPressed: audio.skipToNext),
              ]),
            ),
          ),
        );
      },
    );
  }
}

class NowPlayingScreen extends StatelessWidget {
  const NowPlayingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final audio = context.audio;
    return Scaffold(
      appBar: AppBar(leading: IconButton(icon: const Icon(Icons.keyboard_arrow_down), onPressed: () => Navigator.pop(context))),
      body: StreamBuilder<MediaItem?>(
        stream: audio.mediaItem,
        builder: (context, snap) {
          final item = snap.data;
          if (item == null) return const Center(child: Text('Nothing playing'));
          final Track? track = context.app.track(item.extras?['trackId'] as String? ?? '');
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Column(children: [
              const Spacer(),
              if (track != null) TrackArt(track, size: MediaQuery.sizeOf(context).width - 80),
              const Spacer(),
              Text(item.title, style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center, maxLines: 2),
              if (item.artist != null) Text(item.artist!, style: Theme.of(context).textTheme.bodyLarge),
              if (track != null && !track.isLocal) RatingStars(track),
              const SizedBox(height: 8),
              _SeekBar(duration: item.duration ?? Duration.zero),
              StreamBuilder<PlaybackState>(
                stream: audio.playbackState,
                builder: (context, s) {
                  final st = s.data;
                  final playing = st?.playing ?? false;
                  final shuffle = st?.shuffleMode == AudioServiceShuffleMode.all;
                  final repeat = st?.repeatMode ?? AudioServiceRepeatMode.none;
                  return Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                    IconButton(
                      icon: Icon(Icons.shuffle, color: shuffle ? Theme.of(context).colorScheme.primary : null),
                      onPressed: () => audio.setShuffleMode(shuffle ? AudioServiceShuffleMode.none : AudioServiceShuffleMode.all),
                    ),
                    IconButton(iconSize: 40, icon: const Icon(Icons.skip_previous), onPressed: audio.skipToPrevious),
                    IconButton.filled(
                      iconSize: 44,
                      icon: Icon(playing ? Icons.pause : Icons.play_arrow),
                      onPressed: playing ? audio.pause : audio.play,
                    ),
                    IconButton(iconSize: 40, icon: const Icon(Icons.skip_next), onPressed: audio.skipToNext),
                    IconButton(
                      icon: Icon(repeat == AudioServiceRepeatMode.one ? Icons.repeat_one : Icons.repeat,
                          color: repeat == AudioServiceRepeatMode.none ? null : Theme.of(context).colorScheme.primary),
                      onPressed: () => audio.setRepeatMode(switch (repeat) {
                        AudioServiceRepeatMode.none => AudioServiceRepeatMode.all,
                        AudioServiceRepeatMode.all => AudioServiceRepeatMode.one,
                        _ => AudioServiceRepeatMode.none,
                      }),
                    ),
                  ]);
                },
              ),
              const SizedBox(height: 32),
            ]),
          );
        },
      ),
    );
  }
}

class _SeekBar extends StatefulWidget {
  const _SeekBar({required this.duration});
  final Duration duration;

  @override
  State<_SeekBar> createState() => _SeekBarState();
}

class _SeekBarState extends State<_SeekBar> {
  double? _drag;

  @override
  Widget build(BuildContext context) {
    final audio = context.audio;
    final total = widget.duration.inMilliseconds.toDouble();
    return StreamBuilder<Duration>(
      stream: AudioService.position,
      builder: (context, snap) {
        final pos = (snap.data ?? Duration.zero).inMilliseconds.toDouble();
        final value = (_drag ?? pos).clamp(0, total <= 0 ? 1 : total).toDouble();
        return Column(children: [
          Slider(
            value: value,
            max: total <= 0 ? 1 : total,
            onChanged: total <= 0 ? null : (v) => setState(() => _drag = v),
            onChangeEnd: (v) async {
              await audio.seek(Duration(milliseconds: v.round()));
              if (mounted) setState(() => _drag = null);
            },
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              Text(formatDuration(Duration(milliseconds: value.round()))),
              Text(formatDuration(widget.duration)),
            ]),
          ),
        ]);
      },
    );
  }
}
