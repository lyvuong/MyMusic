import 'package:flutter_test/flutter_test.dart';
import 'package:mymusic/mixes.dart';
import 'package:mymusic/models.dart';

Track t(String id, {String source = 'r2'}) => Track(id: id, source: source, title: id);

void main() {
  test('daypartOf buckets the hour', () {
    expect(daypartOf(DateTime(2026, 1, 1, 7)), 'morning');
    expect(daypartOf(DateTime(2026, 1, 1, 12)), 'afternoon');
    expect(daypartOf(DateTime(2026, 1, 1, 18)), 'evening');
    expect(daypartOf(DateTime(2026, 1, 1, 23)), 'night');
    expect(daypartOf(DateTime(2026, 1, 1, 3)), 'night');
  });

  test('localMix drops disliked and phone songs, favours loved and popular', () {
    final tracks = [for (var i = 0; i < 40; i++) t('s$i'), t('bad'), t('phone', source: 'local')];
    final mix = localMix(tracks, ratings: {'bad': 1, 's0': 5}, popular: {'s1': 9}, seed: 1, size: 10);
    expect(mix.length, 10);
    final ids = mix.map((e) => e.id).toSet();
    expect(ids, isNot(contains('bad')));
    expect(ids, isNot(contains('phone')));
    expect(ids, containsAll(['s0', 's1']));
  });

  test('localMix is stable for a seed', () {
    final tracks = [for (var i = 0; i < 30; i++) t('s$i')];
    List<String> run() => localMix(tracks, ratings: {}, popular: {}, seed: 7, size: 12).map((e) => e.id).toList();
    expect(run(), run());
  });

  test('Mix survives a JSON round trip', () {
    const m = Mix(daypart: 'morning', title: 'Up', intro: 'Hi', trackIds: ['a', 'b'], generatedAt: 5);
    final back = Mix.fromJson(m.toJson());
    expect(back.trackIds, ['a', 'b']);
    expect(back.daypart, 'morning');
  });
}
