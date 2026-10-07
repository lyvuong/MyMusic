import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../auth.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  String? _error;
  bool _busy = false;

  Future<void> _run(Future<void> Function() signIn) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await signIn();
    } catch (e) {
      if (mounted) setState(() => _error = 'Sign-in failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.library_music, size: 72, color: Theme.of(context).colorScheme.primary),
                const SizedBox(height: 16),
                Text('MyMusic', style: Theme.of(context).textTheme.headlineMedium),
                const SizedBox(height: 8),
                const Text('Your family\'s music, on your phone and in the car.', textAlign: TextAlign.center),
                const SizedBox(height: 32),
                FilledButton.icon(
                  onPressed: _busy ? null : () => _run(signInWithGoogle),
                  icon: const Icon(Icons.login),
                  label: const Text('Continue with Google'),
                ),
                if (defaultTargetPlatform == TargetPlatform.iOS) ...[
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: _busy ? null : () => _run(signInWithApple),
                    icon: const Icon(Icons.apple),
                    label: const Text('Continue with Apple'),
                  ),
                ],
                if (_busy) const Padding(padding: EdgeInsets.only(top: 16), child: CircularProgressIndicator()),
                if (_error != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
