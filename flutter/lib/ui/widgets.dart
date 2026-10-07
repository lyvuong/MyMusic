import 'package:flutter/material.dart';

import '../models.dart';
import '../scope.dart';

String formatDuration(Duration d) {
  final m = d.inMinutes;
  final s = (d.inSeconds % 60).toString().padLeft(2, '0');
  return '$m:$s';
}

String formatBytes(int b) {
  if (b < 1 << 20) return '${(b / 1024).toStringAsFixed(0)} KB';
  if (b < 1 << 30) return '${(b / (1 << 20)).toStringAsFixed(1)} MB';
  return '${(b / (1 << 30)).toStringAsFixed(2)} GB';
}

class TrackArt extends StatelessWidget {
  const TrackArt(this.track, {super.key, this.size = 48});
  final Track track;
  final double size;

  @override
  Widget build(BuildContext context) {
    final placeholder = Container(
      width: size,
      height: size,
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Icon(Icons.music_note, size: size / 2),
    );
    if (!track.hasArt || track.isLocal) return ClipRRect(borderRadius: BorderRadius.circular(6), child: placeholder);
    return ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: Image.network(
        context.app.api.artUrl(track.id),
        headers: context.app.api.headersSync,
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => placeholder,
      ),
    );
  }
}

/// One song row. Tapping plays [queue] from this song.
class TrackTile extends StatelessWidget {
  const TrackTile({super.key, required this.track, required this.queue, this.onRemove});
  final Track track;
  final List<Track> queue;
  final VoidCallback? onRemove; // set inside a playlist

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) {
        final downloaded = app.isDownloaded(track.id);
        final pct = app.progress[track.id];
        return ListTile(
          leading: TrackArt(track),
          title: Text(track.title, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Text([track.artist, track.album].where((s) => s.isNotEmpty).join(' - '), maxLines: 1, overflow: TextOverflow.ellipsis),
          onTap: () => context.audio.playQueue(queue, queue.indexWhere((t) => t.id == track.id)),
          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
            if (pct != null)
              SizedBox(width: 20, height: 20, child: CircularProgressIndicator(value: pct == 0 ? null : pct, strokeWidth: 2))
            else if (track.isLocal)
              const Icon(Icons.phone_android, size: 18)
            else if (downloaded)
              Icon(Icons.download_done, size: 20, color: Theme.of(context).colorScheme.primary),
            PopupMenuButton<String>(
              onSelected: (v) => _onMenu(context, v),
              itemBuilder: (_) => [
                const PopupMenuItem(value: 'playlist', child: Text('Add to playlist')),
                if (!track.isLocal)
                  downloaded
                      ? const PopupMenuItem(value: 'undownload', child: Text('Remove download'))
                      : const PopupMenuItem(value: 'download', child: Text('Download for offline')),
                if (onRemove != null) const PopupMenuItem(value: 'remove', child: Text('Remove from playlist')),
              ],
            ),
          ]),
        );
      },
    );
  }

  Future<void> _onMenu(BuildContext context, String v) async {
    final app = context.app;
    switch (v) {
      case 'download':
        await app.download(track);
      case 'undownload':
        await app.removeDownload(track.id);
      case 'remove':
        onRemove?.call();
      case 'playlist':
        await addToPlaylistDialog(context, track);
    }
  }
}

Future<void> addToPlaylistDialog(BuildContext context, Track track) async {
  final app = context.app;
  final messenger = ScaffoldMessenger.of(context);
  final mine = app.playlists.where((p) => p.ownerUid == app.user?.uid).toList();
  final choice = await showModalBottomSheet<String>(
    context: context,
    builder: (_) => SafeArea(
      child: ListView(shrinkWrap: true, children: [
        ListTile(leading: const Icon(Icons.add), title: const Text('New playlist'), onTap: () => Navigator.pop(context, '\u0000new')),
        for (final p in mine) ListTile(leading: const Icon(Icons.queue_music), title: Text(p.name), onTap: () => Navigator.pop(context, p.id)),
      ]),
    ),
  );
  if (choice == null) return;
  if (choice == '\u0000new') {
    if (!context.mounted) return;
    final name = await promptText(context, 'New playlist', 'Name');
    if (name == null || name.isEmpty) return;
    final p = await app.createPlaylist(name);
    p.trackIds.add(track.id);
    await app.savePlaylist(p);
  } else {
    final p = app.store.playlists[choice]!;
    if (!p.trackIds.contains(track.id)) {
      p.trackIds.add(track.id);
      await app.savePlaylist(p);
    }
  }
  messenger.showSnackBar(const SnackBar(content: Text('Added to playlist')));
}

Future<String?> promptText(BuildContext context, String title, String label, {String initial = ''}) {
  final c = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (_) => AlertDialog(
      title: Text(title),
      content: TextField(controller: c, autofocus: true, decoration: InputDecoration(labelText: label)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, c.text.trim()), child: const Text('OK')),
      ],
    ),
  );
}

Future<bool> confirm(BuildContext context, String title, String body, String action) async {
  final r = await showDialog<bool>(
    context: context,
    builder: (_) => AlertDialog(
      title: Text(title),
      content: Text(body),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(action)),
      ],
    ),
  );
  return r ?? false;
}
