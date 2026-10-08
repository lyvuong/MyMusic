import 'package:flutter/material.dart';

import '../models.dart';
import '../scope.dart';
import 'now_playing.dart';
import 'settings.dart';
import 'track_list.dart';
import 'update_banner.dart';
import 'widgets.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => context.app.updates.check());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) context.app.updates.check();
  }

  @override
  Widget build(BuildContext context) {
    final pages = const [LibraryPage(), PlaylistsPage(), DownloadsPage(), SettingsPage()];
    return Scaffold(
      body: SafeArea(child: Column(children: [
        UpdateBanner(controller: context.app.updates),
        Expanded(child: IndexedStack(index: _tab, children: pages)),
      ])),
      bottomNavigationBar: Column(mainAxisSize: MainAxisSize.min, children: [
        const MiniPlayer(),
        NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.library_music_outlined), selectedIcon: Icon(Icons.library_music), label: 'Library'),
            NavigationDestination(icon: Icon(Icons.queue_music_outlined), selectedIcon: Icon(Icons.queue_music), label: 'Playlists'),
            NavigationDestination(icon: Icon(Icons.download_for_offline_outlined), selectedIcon: Icon(Icons.download_for_offline), label: 'Offline'),
            NavigationDestination(icon: Icon(Icons.settings_outlined), selectedIcon: Icon(Icons.settings), label: 'Settings'),
          ],
        ),
      ]),
    );
  }
}

class LibraryPage extends StatefulWidget {
  const LibraryPage({super.key});

  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return DefaultTabController(
      length: 3,
      child: ListenableBuilder(
        listenable: app,
        builder: (context, _) {
          final all = app.allTracks;
          final q = _query.toLowerCase();
          final songs = q.isEmpty
              ? all
              : all.where((t) => t.title.toLowerCase().contains(q) || t.artist.toLowerCase().contains(q) || t.album.toLowerCase().contains(q)).toList();
          return Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: TextField(
                decoration: InputDecoration(
                  hintText: 'Search your music',
                  prefixIcon: const Icon(Icons.search),
                  border: const OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(28))),
                  suffixIcon: app.syncing ? const Padding(padding: EdgeInsets.all(12), child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))) : null,
                ),
                onChanged: (v) => setState(() => _query = v),
              ),
            ),
            const TabBar(tabs: [Tab(text: 'Songs'), Tab(text: 'Albums'), Tab(text: 'Artists')]),
            Expanded(
              child: TabBarView(children: [
                _SongList(songs),
                _GroupList(all, (t) => t.album, grid: true),
                _GroupList(all, (t) => t.artist),
              ]),
            ),
          ]);
        },
      ),
    );
  }
}

class _SongList extends StatelessWidget {
  const _SongList(this.songs);
  final List<Track> songs;

  @override
  Widget build(BuildContext context) {
    if (songs.isEmpty) {
      return const Center(child: Padding(padding: EdgeInsets.all(24), child: Text('No songs yet. Ask the family owner to sync the NAS in the web player, or add music from this phone in Settings.', textAlign: TextAlign.center)));
    }
    return RefreshIndicator(
      onRefresh: context.app.sync,
      child: ListView.builder(
        itemCount: songs.length,
        itemBuilder: (_, i) => TrackTile(track: songs[i], queue: songs),
      ),
    );
  }
}

class _GroupList extends StatelessWidget {
  const _GroupList(this.all, this.key_, {this.grid = false});
  final List<Track> all;
  final String Function(Track) key_;
  final bool grid;

  @override
  Widget build(BuildContext context) {
    final groups = <String, List<Track>>{};
    for (final t in all) {
      final k = key_(t);
      if (k.isNotEmpty) groups.putIfAbsent(k, () => []).add(t);
    }
    final names = groups.keys.toList()..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
    void open(String n, List<Track> tracks) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => TrackListPage(title: n, tracks: tracks, cover: coverOf(tracks))));
    if (grid) {
      return GridView.builder(
        padding: const EdgeInsets.all(12),
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 200, mainAxisSpacing: 12, crossAxisSpacing: 12, childAspectRatio: 0.78),
        itemCount: names.length,
        itemBuilder: (_, i) {
          final n = names[i];
          final tracks = groups[n]!..sort((a, b) => a.trackNo.compareTo(b.trackNo));
          return InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => open(n, tracks),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(child: LayoutBuilder(builder: (_, c) => TrackArt(coverOf(tracks), size: c.maxWidth))),
              const SizedBox(height: 6),
              Text(n, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
              Text(tracks.map((t) => t.artist).where((a) => a.isNotEmpty).toSet().length == 1 ? tracks.first.artist : '${tracks.length} songs',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodySmall),
            ]),
          );
        },
      );
    }
    return ListView.builder(
      itemCount: names.length,
      itemBuilder: (_, i) {
        final n = names[i];
        final tracks = groups[n]!..sort((a, b) => a.trackNo.compareTo(b.trackNo));
        return ListTile(
          leading: TrackArt(coverOf(tracks), size: 44),
          title: Text(n),
          subtitle: Text('${tracks.length} songs'),
          onTap: () => open(n, tracks),
        );
      },
    );
  }
}

/// The song whose cover stands for a group: the first one that has art, else the first song (shows the placeholder).
Track coverOf(List<Track> tracks) => tracks.firstWhere((t) => t.hasArt && !t.isLocal, orElse: () => tracks.first);

class PlaylistsPage extends StatelessWidget {
  const PlaylistsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) {
        final lists = app.playlists;
        return Scaffold(
          appBar: AppBar(title: const Text('Playlists')),
          floatingActionButton: FloatingActionButton(
            onPressed: () async {
              final name = await promptText(context, 'New playlist', 'Name');
              if (name != null && name.isNotEmpty) await app.createPlaylist(name);
            },
            child: const Icon(Icons.add),
          ),
          body: lists.isEmpty
              ? const Center(child: Text('No playlists yet'))
              : ListView(children: [
                  for (final p in lists)
                    ListTile(
                      leading: const Icon(Icons.queue_music),
                      title: Text(p.name),
                      subtitle: Text('${p.trackIds.length} songs${p.shared ? ' - shared' : ''}${p.ownerUid == app.user?.uid ? '' : ' - from a family member'}'),
                      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PlaylistPage(playlistId: p.id))),
                    ),
                ]),
        );
      },
    );
  }
}

class DownloadsPage extends StatelessWidget {
  const DownloadsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) {
        final tracks = app.downloadedTracks;
        return Scaffold(
          appBar: AppBar(title: const Text('Available offline')),
          body: tracks.isEmpty
              ? const Center(child: Padding(padding: EdgeInsets.all(24), child: Text('Nothing downloaded yet. Use the menu on a song, or "Download all" on a playlist.', textAlign: TextAlign.center)))
              : Column(children: [
                  ListTile(title: Text('${tracks.length} songs - ${formatBytes(app.downloadedBytes)}')),
                  Expanded(child: ListView.builder(itemCount: tracks.length, itemBuilder: (_, i) => TrackTile(track: tracks[i], queue: tracks))),
                ]),
        );
      },
    );
  }
}
