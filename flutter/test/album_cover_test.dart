import 'package:flutter_test/flutter_test.dart';
import 'package:mymusic/models.dart';
import 'package:mymusic/ui/home.dart';

void main() {
  test('an album uses the first song that has a cover, else the first song', () {
    const a = Track(id: 'a', source: 'nas', title: 'A');
    const b = Track(id: 'b', source: 'nas', title: 'B', hasArt: true);
    const c = Track(id: 'c', source: 'local', title: 'C', hasArt: true);
    expect(coverOf([a, b]).id, 'b');
    expect(coverOf([c, a]).id, 'c', reason: 'a phone-only file has no cover to fetch');
    expect(coverOf([a, c]).id, 'a');
  });
}
