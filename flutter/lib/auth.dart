import 'package:firebase_auth/firebase_auth.dart';
import 'package:google_sign_in/google_sign_in.dart';

import 'env.dart';

Future<void> signInWithGoogle() async {
  final google = GoogleSignIn.instance;
  await google.initialize(serverClientId: Env.googleServerClientId.isEmpty ? null : Env.googleServerClientId);
  final account = await google.authenticate();
  final idToken = account.authentication.idToken;
  await FirebaseAuth.instance.signInWithCredential(GoogleAuthProvider.credential(idToken: idToken));
}

/// Required by App Store review whenever another third-party sign-in (Google) is offered.
Future<void> signInWithApple() =>
    FirebaseAuth.instance.signInWithProvider(AppleAuthProvider()..addScope('email')..addScope('name'));

Future<void> signOut() async {
  await GoogleSignIn.instance.signOut().catchError((_) {});
  await FirebaseAuth.instance.signOut();
}
