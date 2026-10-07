import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../auth.dart';
import '../scope.dart';
import '../updater.dart';
import 'widgets.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  String? _updateStatus;

  Future<void> _checkUpdate() async {
    setState(() => _updateStatus = 'Checking...');
    try {
      final u = await checkForUpdate();
      if (u == null) {
        setState(() => _updateStatus = 'You have the latest version');
        return;
      }
      setState(() => _updateStatus = 'Downloading ${u.versionName}...');
      await for (final p in installUpdate(u)) {
        if (mounted) setState(() => _updateStatus = 'Downloading ${u.versionName}: $p%');
      }
      if (mounted) setState(() => _updateStatus = null);
    } catch (e) {
      if (mounted) setState(() => _updateStatus = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) {
        final fam = app.family;
        return Scaffold(
          appBar: AppBar(title: const Text('Settings')),
          body: ListView(children: [
            ListTile(title: Text(fam?.name ?? ''), subtitle: Text(app.user?.email ?? ''), leading: const Icon(Icons.family_restroom)),
            if (app.message != null) ListTile(leading: const Icon(Icons.info_outline), title: Text(app.message!)),
            ListTile(
              leading: const Icon(Icons.sync),
              title: const Text('Sync library'),
              subtitle: Text(app.syncing ? 'Syncing...' : '${app.store.tracks.length} songs from your family'),
              onTap: app.sync,
            ),
            const Divider(),
            const ListTile(title: Text('Family members')),
            for (final m in fam?.members ?? [])
              ListTile(
                leading: Icon(m.role == 'owner' ? Icons.star : Icons.person),
                title: Text(m.displayName.isEmpty ? m.email : m.displayName),
                subtitle: Text(m.role),
                trailing: fam!.isOwner && m.uid != app.user?.uid
                    ? IconButton(
                        icon: const Icon(Icons.person_remove),
                        onPressed: () async {
                          if (await confirm(context, 'Remove ${m.displayName.isEmpty ? m.email : m.displayName}?', 'They lose access and their playlists are deleted.', 'Remove')) {
                            await app.api.removeMember(m.uid);
                            await app.refreshFamily();
                          }
                        },
                      )
                    : null,
              ),
            if (fam?.isOwner ?? false)
              ListTile(
                leading: const Icon(Icons.person_add),
                title: const Text('Invite someone'),
                subtitle: const Text('Creates a code that works for 7 days'),
                onTap: () async {
                  final messenger = ScaffoldMessenger.of(context);
                  try {
                    final code = await app.api.createInvite();
                    await Clipboard.setData(ClipboardData(text: code));
                    if (context.mounted) {
                      await showDialog<void>(
                        context: context,
                        builder: (_) => AlertDialog(
                          title: const Text('Invite code'),
                          content: SelectableText(code, style: Theme.of(context).textTheme.headlineMedium),
                          actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Done'))],
                        ),
                      );
                    }
                  } catch (e) {
                    messenger.showSnackBar(SnackBar(content: Text('$e')));
                  }
                },
              ),
            const Divider(),
            ListTile(
              leading: const Icon(Icons.phone_android),
              title: const Text('Music on this phone'),
              subtitle: Text(app.store.phoneTracks.isEmpty ? 'Add songs stored on this phone to your library (not uploaded)' : '${app.store.phoneTracks.length} songs found'),
              trailing: app.store.phoneTracks.isEmpty
                  ? null
                  : IconButton(icon: const Icon(Icons.clear), tooltip: 'Remove', onPressed: app.clearPhoneTracks),
              onTap: () async {
                final messenger = ScaffoldMessenger.of(context);
                final ok = await app.scanPhone();
                if (!ok) messenger.showSnackBar(const SnackBar(content: Text('Allow access to audio files to find music on this phone')));
              },
            ),
            ListTile(
              leading: const Icon(Icons.download_for_offline),
              title: const Text('Downloaded for offline'),
              subtitle: Text('${app.store.downloads.length} songs, ${formatBytes(app.downloadedBytes)}'),
            ),
            if (updatesEnabled) ...[
              const Divider(),
              ListTile(leading: const Icon(Icons.system_update), title: const Text('Check for updates'), subtitle: _updateStatus == null ? null : Text(_updateStatus!), onTap: _checkUpdate),
            ],
            const Divider(),
            ListTile(leading: const Icon(Icons.logout), title: const Text('Sign out'), subtitle: const Text('Removes downloads from this phone'), onTap: signOut),
            if (fam != null)
              ListTile(
                leading: const Icon(Icons.exit_to_app),
                title: const Text('Leave family'),
                onTap: () async {
                  if (await confirm(context, 'Leave ${fam.name}?', 'Your playlists are deleted and downloads removed from this phone.', 'Leave')) {
                    await app.leaveFamily();
                  }
                },
              ),
            ListTile(
              leading: Icon(Icons.delete_forever, color: Theme.of(context).colorScheme.error),
              title: Text('Delete my account', style: TextStyle(color: Theme.of(context).colorScheme.error)),
              onTap: () async {
                if (await confirm(context, 'Delete your account?', 'This removes you from the family and deletes your playlists. It cannot be undone.', 'Delete')) {
                  try {
                    await app.deleteAccount();
                  } catch (e) {
                    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e. If it asks you to sign in again, do that and retry.')));
                  }
                }
              },
            ),
          ]),
        );
      },
    );
  }
}
