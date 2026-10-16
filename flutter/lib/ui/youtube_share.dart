import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../scope.dart';

/// Share -> MyMusic from the YouTube app: shows a sheet with the video's names to confirm, then queues the download.
/// The shared text arrives through the activity (see MainActivity): once at start-up and again while the app is open.
class YoutubeShareListener extends StatefulWidget {
  const YoutubeShareListener({super.key, required this.child});
  final Widget child;

  @override
  State<YoutubeShareListener> createState() => _YoutubeShareListenerState();
}

class _YoutubeShareListenerState extends State<YoutubeShareListener> {
  static const _channel = MethodChannel('org.lv5.mymusic/playback');

  @override
  void initState() {
    super.initState();
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'shared') await _take();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _take());
  }

  @override
  void dispose() {
    _channel.setMethodCallHandler(null);
    super.dispose();
  }

  Future<void> _take() async {
    String? text;
    try {
      text = await _channel.invokeMethod<String>('takeShared');
    } catch (_) {
      return;
    }
    final link = RegExp(r'https?://\S+').firstMatch(text ?? '')?.group(0);
    if (link == null || !mounted) return;
    final app = context.app;
    if (!(app.family?.isOwner ?? false)) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Only the library owner can add songs from YouTube.')));
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _AddSheet(url: link),
    );
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class _AddSheet extends StatefulWidget {
  const _AddSheet({required this.url});
  final String url;

  @override
  State<_AddSheet> createState() => _AddSheetState();
}

class _AddSheetState extends State<_AddSheet> {
  final _title = TextEditingController();
  final _artist = TextEditingController();
  final _album = TextEditingController();
  Map<String, dynamic>? _info;
  String? _error;
  bool _ai = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _look();
  }

  @override
  void dispose() {
    _title.dispose();
    _artist.dispose();
    _album.dispose();
    super.dispose();
  }

  Future<void> _look() async {
    try {
      final info = await context.app.api.youtubeInfo(widget.url);
      if (!mounted) return;
      setState(() {
        _info = info;
        _title.text = (info['title'] as String?) ?? '';
        _artist.text = (info['artist'] as String?) ?? '';
        _album.text = (info['album'] as String?) ?? '';
        _ai = info['aiLabel'] == true || info['aiHint'] == true;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  bool get _ready => _info != null && _info!['tooLong'] != true && _title.text.trim().isNotEmpty && _artist.text.trim().isNotEmpty;

  Future<void> _add() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    try {
      await context.app.api.importYoutube(
        url: widget.url,
        title: _title.text.trim(),
        artist: _artist.text.trim(),
        album: _album.text.trim(),
        ai: _ai,
      );
      navigator.pop();
      messenger.showSnackBar(SnackBar(content: Text('Added "${_title.text.trim()}": it shows up in the library when the download finishes.')));
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = '$e';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final info = _info;
    final secs = (info?['duration'] as num?)?.toInt() ?? 0;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Add to library', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(widget.url, maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 12),
            if (info == null && _error == null) const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
            if (info != null) ...[
              TextField(controller: _title, decoration: const InputDecoration(labelText: 'Title'), onChanged: (_) => setState(() {})),
              TextField(controller: _artist, decoration: const InputDecoration(labelText: 'Artist'), onChanged: (_) => setState(() {})),
              TextField(controller: _album, decoration: const InputDecoration(labelText: 'Album (optional)')),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _ai,
                onChanged: (v) => setState(() => _ai = v ?? false),
                title: const Text('Made by AI (shows a badge)'),
                subtitle: Text('${secs ~/ 60}:${(secs % 60).toString().padLeft(2, '0')}${info['tooLong'] == true ? ' · too long for the server (max 2 hours)' : ''}'),
              ),
            ],
            if (_error != null) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: const Text('Cancel')),
                const SizedBox(width: 8),
                FilledButton(onPressed: _ready && !_busy ? _add : null, child: Text(_busy ? 'Adding…' : 'Add to library')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
