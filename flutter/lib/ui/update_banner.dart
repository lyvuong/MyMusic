import 'package:flutter/material.dart';

import '../updater.dart';

/// Strip at the very top of the app when a newer build is available: tap Update to download and
/// install it, or Later to hide it until the next launch (or a newer build).
class UpdateBanner extends StatelessWidget {
  const UpdateBanner({super.key, required this.controller});
  final UpdateController controller;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final u = controller.update;
        if (u == null || !controller.visible) return const SizedBox.shrink();
        final scheme = Theme.of(context).colorScheme;
        final busy = controller.progress != null;
        final p = controller.progress ?? 0;
        final detail = controller.error ?? (busy ? 'Downloading... ${p == 0 ? '' : '$p%'}' : (u.notes ?? '').trim());
        return Material(
          color: scheme.primaryContainer,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(children: [
                Icon(Icons.system_update, color: scheme.onPrimaryContainer),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('New version ${u.versionName} is available', style: TextStyle(fontWeight: FontWeight.w600, color: scheme.onPrimaryContainer)),
                    if (detail.isNotEmpty)
                      Text(detail, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: controller.error != null ? scheme.error : scheme.onPrimaryContainer)),
                  ]),
                ),
                if (!busy) ...[
                  TextButton(onPressed: controller.dismiss, child: const Text('Later')),
                  FilledButton(onPressed: controller.install, child: Text(controller.error != null ? 'Retry' : 'Update')),
                ],
              ]),
              if (busy)
                Padding(
                  padding: const EdgeInsets.only(top: 8, right: 8),
                  child: LinearProgressIndicator(value: p == 0 ? null : p / 100),
                ),
            ]),
          ),
        );
      },
    );
  }
}
