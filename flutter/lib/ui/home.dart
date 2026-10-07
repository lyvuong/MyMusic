import 'package:flutter/material.dart';

import '../models.dart';
import '../scope.dart';
import 'now_playing.dart';
import 'settings.dart';
import 'track_list.dart';
import 'widgets.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final pages = const [LibraryPage(), PlaylistsPage(), DownloadsPage(), SettingsPage()];
    return Scaffold(
      body: SafeArea(child: IndexedStack(index: _tab, children: pages)),
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
                _GroupList(all, (t) => t.album, Icons.album),
                _GroupList(all, (t) => t.artist, Icons.person),
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
      return const Center(child: Padding(padding: EdgeInsets.all(24), child: Text('No songs yet. Upload music on the web player, or add music from this phone in Settings.', textAlign: TextAlign.center)));
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
  const _GroupList(this.all, this.key_, this.icon);
  final List<Track> all;
  final String Function(Track) key_;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final groups = <String, List<Track>>{};
    for (final t in all) {
      final k = key_(t);
      if (k.isNotEmpty) groups.putIfAbsent(k, () => []).add(t);
    }
    final names = groups.keys.toList()..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
    return ListView.builder(
      itemCount: names.length,
      itemBuilder: (_, i) {
        final n = names[i];
        final tracks = groups[n]!..sort((a, b) => a.trackNo.compareTo(b.trackNo));
        return ListTile(
          leading: Icon(icon),
          title: Text(n),
          subtitle: Text('${tracks.length} songs'),
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => TrackListPage(title: n, tracks: tracks))),
        );
      },
    );
  }
}

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
