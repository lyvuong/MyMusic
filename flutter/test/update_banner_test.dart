import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mymusic/ui/update_banner.dart';
import 'package:mymusic/updater.dart';

const _update = AppUpdate(versionCode: 120, versionName: '0.1.120', file: 'mymusic-120-arm64-v8a.apk', sha256: 'x', notes: 'Redesign the web player');

Widget _app(UpdateController c) => MaterialApp(home: Scaffold(body: Column(children: [UpdateBanner(controller: c), const Text('library')])));

void main() {
  testWidgets('shows nothing when there is no update', (tester) async {
    final c = UpdateController(check: () async => null);
    await c.check();
    await tester.pumpWidget(_app(c));
    expect(find.textContaining('New version'), findsNothing);
  });

  testWidgets('shows the banner, and Later hides it for that version only', (tester) async {
    var latest = _update;
    final c = UpdateController(check: () async => latest);
    await c.check();
    await tester.pumpWidget(_app(c));
    expect(find.text('New version 0.1.120 is available'), findsOneWidget);
    expect(find.text('Redesign the web player'), findsOneWidget);

    await tester.tap(find.text('Later'));
    await tester.pump();
    expect(find.textContaining('New version'), findsNothing);

    latest = const AppUpdate(versionCode: 121, versionName: '0.1.121', file: 'f', sha256: 'x');
    await c.check(force: true);
    await tester.pump();
    expect(find.text('New version 0.1.121 is available'), findsOneWidget);
  });

  testWidgets('Update shows progress, then the banner returns if the install is cancelled', (tester) async {
    final c = UpdateController(check: () async => _update, install: (_) => Stream.fromIterable([0, 40, 100]));
    await c.check();
    await tester.pumpWidget(_app(c));
    await tester.tap(find.text('Update'));
    await tester.pumpAndSettle();
    expect(c.progress, isNull);
    expect(find.text('Update'), findsOneWidget);
  });

  testWidgets('a failed download shows the reason and Retry', (tester) async {
    final c = UpdateController(check: () async => _update, install: (_) => Stream.error(StateError('The download was corrupted. Try again.')));
    await c.check();
    await tester.pumpWidget(_app(c));
    await tester.tap(find.text('Update'));
    await tester.pumpAndSettle();
    expect(find.text('The download was corrupted. Try again.'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  test('checks are throttled, and an offline check is retried', () async {
    var calls = 0;
    final c = UpdateController(check: () async {
      calls++;
      if (calls == 1) throw Exception('offline');
      return _update;
    });
    await c.check();
    await c.check();
    expect(calls, 2);
    expect(c.update?.versionCode, 120);
    await c.check();
    expect(calls, 2);
    await c.check(force: true);
    expect(calls, 3);
  });
}
