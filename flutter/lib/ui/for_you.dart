import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../scope.dart';
import 'widgets.dart';

/// AI suggestions from my star ratings: a playlist from the library plus artists to discover.
class ForYouPage extends StatefulWidget {
  const ForYouPage({super.key});

  @override
  State<ForYouPage> createState() => _ForYouPageState();
}

class _ForYouPageState extends State<ForYouPage> {
  static const _moods = ['Rainy evening', 'Workout', 'Focus', 'Dinner with family', 'Road trip'];
  final _mood = TextEditingController();
  bool _busy = false;
  String? _error;
  Suggestion? _result;

  @override
  void dispose() {
    _mood.dispose();
    super.dispose();
  }

  Future<void> _ask() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await context.app.suggest(_mood.text.trim());
      if (mounted) setState(() => _result = r);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not reach the server. Suggestions need a connection.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final r = _result;
    final picks = <(Track, String)>[
      if (r != null)
        for (final t in r.tracks)
          if (app.track(t.id) != null) (app.track(t.id)!, t.why),
    ];
    final queue = [for (final (t, _) in picks) t];
    return Scaffold(
      appBar: AppBar(title: const Text('For you')),
      body: ListView(padding: const EdgeInsets.only(bottom: 24), children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: Text('Rate songs with the stars and an AI picks what to listen to next. Add a mood if you want.', style: Theme.of(context).textTheme.bodyMedium),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: TextField(
            controller: _mood,
            maxLength: 200,
            textInputAction: TextInputAction.go,
            onSubmitted: (_) => _busy ? null : _ask(),
            decoration: const InputDecoration(
              hintText: 'Mood or occasion (optional)',
              counterText: '',
              border: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(28))),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: Wrap(spacing: 8, children: [
            for (final m in _moods) ActionChip(label: Text(m), onPressed: () => setState(() => _mood.text = m)),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: Row(children: [
            FilledButton.icon(
              onPressed: _busy ? null : _ask,
              icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.auto_awesome),
              label: Text(_busy ? 'Thinking...' : 'Suggest'),
            ),
          ]),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.all(16), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
        if (r != null) ...[
          Padding(padding: const EdgeInsets.fromLTRB(16, 20, 16, 0), child: Text(r.title, style: Theme.of(context).textTheme.titleLarge)),
          if (r.intro.isNotEmpty) Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 0), child: Text(r.intro)),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Wrap(spacing: 12, children: [
              FilledButton.icon(
                onPressed: queue.isEmpty ? null : () => context.audio.playQueue(queue, 0),
                icon: const Icon(Icons.play_arrow),
                label: const Text('Play'),
              ),
              OutlinedButton.icon(
                onPressed: queue.isEmpty
                    ? null
                    : () async {
                        final messenger = ScaffoldMessenger.of(context);
                        final p = await app.createPlaylist(r.title);
                        p.trackIds.addAll(queue.map((t) => t.id));
                        await app.savePlaylist(p);
                        messenger.showSnackBar(SnackBar(content: Text('Saved as playlist: ${r.title}')));
                      },
                icon: const Icon(Icons.playlist_add),
                label: const Text('Save as playlist'),
              ),
            ]),
          ),
          for (final (t, why) in picks) TrackTile(track: t, queue: queue, note: why),
          if (r.discover.isNotEmpty) ...[
            Padding(padding: const EdgeInsets.fromLTRB(16, 20, 16, 0), child: Text('To discover', style: Theme.of(context).textTheme.titleMedium)),
            for (final d in r.discover)
              ListTile(
                leading: const Icon(Icons.explore_outlined),
                title: Text(d.album.isEmpty ? d.artist : '${d.artist} - ${d.album}'),
                subtitle: Text(d.why),
              ),
          ],
        ],
      ]),
    );
  }
}
