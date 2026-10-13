import 'package:flutter/material.dart';

import '../mixes.dart';
import '../models.dart';
import '../scope.dart';
import 'for_you.dart';
import 'home.dart' show coverOf;
import 'track_list.dart';
import 'widgets.dart';

/// The phone's start page, laid out like the car screen's "For You": the mix of the hour, the family's popular songs,
/// top rated and rediscover, then the themed hours, each a cover with a few words about it; below it what was played
/// lately.
class StartPage extends StatelessWidget {
  const StartPage({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) {
        final folders = app.forYouFolders;
        final recent = app.recentTracks.take(20).toList();
        final theme = Theme.of(context);
        return RefreshIndicator(
          onRefresh: app.sync,
          child: CustomScrollView(slivers: [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
                child: Row(children: [
                  Expanded(child: Text(greetingFor(daypartOf(DateTime.now())), style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700))),
                  if (app.syncing) const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                ]),
              ),
            ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: ActionChip(
                    avatar: const Icon(Icons.auto_awesome, size: 18),
                    label: const Text('Ask the AI for a mood'),
                    onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ForYouPage())),
                  ),
                ),
              ),
            ),
            if (folders.every((f) => f.tracks.isEmpty))
              const SliverToBoxAdapter(
                child: Padding(
                  padding: EdgeInsets.all(24),
                  child: Text('Your mixes appear here once the library has synced and you have rated or played a few songs.', textAlign: TextAlign.center),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                sliver: SliverGrid(
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 220,
                    mainAxisSpacing: 16,
                    crossAxisSpacing: 14,
                    childAspectRatio: 0.74,
                  ),
                  delegate: SliverChildBuilderDelegate(
                    (context, i) {
                      final f = folders[i];
                      return _FolderCard(
                        title: f.title,
                        subtitle: f.subtitle,
                        cover: f.cover ?? (f.tracks.isEmpty ? null : f.tracks.first),
                        onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                          builder: (_) => TrackListPage(title: f.title, tracks: f.tracks, subtitle: f.subtitle, cover: f.cover ?? (f.tracks.isEmpty ? null : coverOf(f.tracks))),
                        )),
                      );
                    },
                    childCount: folders.length,
                  ),
                ),
              ),
            if (recent.isNotEmpty) ...[
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                  child: Text('Recently played', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                ),
              ),
              SliverToBoxAdapter(
                child: SizedBox(
                  height: 168,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    itemCount: recent.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 12),
                    itemBuilder: (context, i) {
                      final t = recent[i];
                      return SizedBox(
                        width: 120,
                        child: InkWell(
                          borderRadius: BorderRadius.circular(8),
                          onTap: () => context.audio.playQueue(recent, i),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            ClipRRect(borderRadius: BorderRadius.circular(8), child: TrackArt(t, size: 120)),
                            const SizedBox(height: 6),
                            Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                            Text(t.artist, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
                          ]),
                        ),
                      );
                    },
                  ),
                ),
              ),
            ],
            const SliverToBoxAdapter(child: SizedBox(height: 24)),
          ]),
        );
      },
    );
  }
}

/// A cover with its title and a few words under it, the phone's version of a car-screen grid item.
class _FolderCard extends StatelessWidget {
  const _FolderCard({required this.title, required this.subtitle, required this.cover, required this.onTap});
  final String title;
  final String subtitle;
  final Track? cover;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: LayoutBuilder(
              builder: (_, c) => cover == null
                  ? Container(width: c.maxWidth, color: theme.colorScheme.surfaceContainerHighest, child: const Icon(Icons.music_note, size: 48))
                  : TrackArt(cover!, size: c.maxWidth),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 2),
        Text(subtitle, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
      ]),
    );
  }
}
