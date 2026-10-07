import 'package:flutter_test/flutter_test.dart';
import 'package:mymusic/models.dart';

void main() {
  test('Track survives a JSON round trip', () {
    const t = Track(id: 'a', source: 'r2', title: 'Song', artist: 'Band', album: 'LP', duration: 12.5, trackNo: 3, hasArt: true, size: 99, etag: 'e');
    final back = Track.fromJson(t.toJson());
    expect(back.title, 'Song');
    expect(back.duration, 12.5);
    expect(back.hasArt, isTrue);
    expect(back.isLocal, isFalse);
  });

  test('Playlist keeps track order and tolerates missing fields', () {
    final p = Playlist.fromJson({'id': 'p', 'name': 'Mix', 'trackIds': ['b', 'a']});
    expect(p.trackIds, ['b', 'a']);
    expect(p.shared, isFalse);
  });

  test('FamilyInfo knows the owner', () {
    final f = FamilyInfo.fromJson({'id': 'f', 'name': 'Us', 'role': 'owner', 'members': []});
    expect(f.isOwner, isTrue);
  });
}
