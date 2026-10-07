import 'package:flutter/material.dart';

import '../auth.dart';
import '../scope.dart';

/// First run after sign-in: start a family or join one with an invite code.
class FamilyScreen extends StatefulWidget {
  const FamilyScreen({super.key});

  @override
  State<FamilyScreen> createState() => _FamilyScreenState();
}

class _FamilyScreenState extends State<FamilyScreen> {
  final _name = TextEditingController();
  final _code = TextEditingController();
  String? _error;
  bool _busy = false;

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return Scaffold(
      appBar: AppBar(title: const Text('Your family'), actions: [TextButton(onPressed: signOut, child: const Text('Sign out'))]),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text('Start a family', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          const Text('Everyone in a family shares one music library. You can invite the others after.'),
          const SizedBox(height: 12),
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Family name', border: OutlineInputBorder())),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _busy ? null : () => _run(() async {
              final name = _name.text.trim();
              if (name.isEmpty) throw 'Enter a name';
              await app.createFamily(name);
            }),
            child: const Text('Create family'),
          ),
          const Divider(height: 48),
          Text('Join a family', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          TextField(
            controller: _code,
            textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(labelText: 'Invite code', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          FilledButton.tonal(
            onPressed: _busy ? null : () => _run(() => app.joinFamily(_code.text)),
            child: const Text('Join'),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
        ],
      ),
    );
  }
}
