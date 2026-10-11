import 'dart:math';

import 'models.dart';

/// Time-of-day buckets used for the car's "For You" mix. The server builds one AI mix per bucket overnight.
const dayparts = ['morning', 'afternoon', 'evening', 'night'];

String daypartOf(DateTime t) {
  final h = t.hour;
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

String greetingFor(String daypart) => switch (daypart) {
      'morning' => 'Good morning',
      'afternoon' => 'Good afternoon',
      'evening' => 'Good evening',
      _ => 'Late night',
    };

/// A mix built on the phone, for when the server has not made one yet or there is no connection:
/// songs I rated 4-5 and the family's popular ones first, then unrated filler, never songs I rated 1-2.
/// The order is shuffled but stable for a given [seed] (the day), so the car list does not jump around.
List<Track> localMix(
  Iterable<Track> tracks, {
  required Map<String, int> ratings,
  required Map<String, int> popular,
  required int seed,
  int size = 25,
}) {
  final rng = Random(seed);
  double score(Track t) {
    final r = ratings[t.id] ?? 0;
    final pop = log((popular[t.id] ?? 0) + 1);
    return (r >= 4 ? 2.0 + (r - 4) * 0.5 : 0) + pop + (r == 0 ? 0.3 : 0) + rng.nextDouble() * 1.5;
  }

  final scored = [
    for (final t in tracks)
      if (!t.isLocal && (ratings[t.id] ?? 3) > 2) (t, score(t)),
  ]..sort((a, b) => b.$2.compareTo(a.$2));
  return [for (final e in scored.take(size)) e.$1]..shuffle(rng);
}
