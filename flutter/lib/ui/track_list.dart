import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';

import '../models.dart';
import '../scope.dart';
import 'now_playing.dart';
import 'widgets.dart';

/// A fixed list of songs (an album or an artist).
class TrackListPage extends StatelessWidget {
  const TrackListPage({super.key, required this.title, required this.tracks, this.cover, this.subtitle});
  final String title;
  final List<Track> tracks;
  final Track? cover; // shown large above the songs
  final String? subtitle; // a few words about the list, shown under the title

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title), actions: [
        IconButton(icon: const Icon(Icons.download_for_offline), tooltip: 'Download all', onPressed: () => context.app.downloadAll(tracks)),
      ]),
      body: Column(children: [
        if (cover != null && cover!.hasArt && !cover!.isLocal)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: Row(children: [
              TrackArt(cover!, size: 120),
              const SizedBox(width: 16),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.titleLarge),
                Text(subtitle ?? '${tracks.length} songs', maxLines: 3, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodyMedium),
              ])),
            ]),
          )
        else if (subtitle != null)
          Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 0), child: Align(alignment: Alignment.centerLeft, child: Text(subtitle!))),
        if (tracks.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: Row(children: [
              FilledButton.icon(onPressed: () => context.audio.playQueue(tracks, 0), icon: const Icon(Icons.play_arrow), label: const Text('Play')),
              const SizedBox(width: 12),
              OutlinedButton.icon(
                onPressed: () async {
                  final audio = context.audio;
                  await audio.setShuffleMode(AudioServiceShuffleMode.all);
                  await audio.playQueue(tracks, 0);
                },
                icon: const Icon(Icons.shuffle),
                label: const Text('Shuffle'),
              ),
            ]),
          ),
        Expanded(child: ListView.builder(itemCount: tracks.length, itemBuilder: (_, i) => TrackTile(track: tracks[i], queue: tracks))),
        const MiniPlayer(),
      ]),
    );
  }
}

class PlaylistPage extends StatelessWidget {
  const PlaylistPage({super.key, required this.playlistId});
  final String playlistId;

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) {
        final p = app.store.playlists[playlistId];
        if (p == null) return const Scaffold(body: Center(child: Text('Playlist removed')));
        final mine = p.ownerUid == app.user?.uid;
        final tracks = app.tracksOf(p);
        return Scaffold(
          appBar: AppBar(title: Text(p.name), actions: [
            IconButton(icon: const Icon(Icons.download_for_offline), tooltip: 'Download all', onPressed: () => app.downloadAll(tracks)),
            if (mine)
              PopupMenuButton<String>(
                onSelected: (v) async {
                  if (v == 'rename') {
                    final n = await promptText(context, 'Rename playlist', 'Name', initial: p.name);
                    if (n != null && n.isNotEmpty) {
                      p.name = n;
                      await app.savePlaylist(p);
                    }
                  } else if (v == 'share') {
                    p.shared = !p.shared;
                    await app.savePlaylist(p);
                  } else if (v == 'delete' && await confirm(context, 'Delete playlist?', 'The songs stay in the library.', 'Delete')) {
                    await app.deletePlaylist(p.id);
                    if (context.mounted) Navigator.pop(context);
                  }
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'rename', child: Text('Rename')),
                  PopupMenuItem(value: 'share', child: Text(p.shared ? 'Stop sharing with family' : 'Share with family')),
                  const PopupMenuItem(value: 'delete', child: Text('Delete')),
                ],
              ),
          ]),
          body: Column(children: [
            if (tracks.isNotEmpty)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Row(children: [
                  FilledButton.icon(onPressed: () => context.audio.playQueue(tracks, 0), icon: const Icon(Icons.play_arrow), label: const Text('Play')),
                  const SizedBox(width: 12),
                  OutlinedButton.icon(
                    onPressed: () async {
                      final audio = context.audio;
                      await audio.setShuffleMode(AudioServiceShuffleMode.all);
                      await audio.playQueue(tracks, 0);
                    },
                    icon: const Icon(Icons.shuffle),
                    label: const Text('Shuffle'),
                  ),
                ]),
              ),
            Expanded(
              child: tracks.isEmpty
                  ? const Center(child: Text('Empty. Add songs from the menu on any song.'))
                  : ListView.builder(
                      itemCount: tracks.length,
                      itemBuilder: (_, i) => TrackTile(
                        track: tracks[i],
                        queue: tracks,
                        onRemove: mine
                            ? () {
                                p.trackIds.remove(tracks[i].id);
                                app.savePlaylist(p);
                              }
                            : null,
                      ),
                    ),
            ),
            const MiniPlayer(),
          ]),
        );
      },
    );
  }
}
