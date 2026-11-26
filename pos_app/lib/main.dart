import 'package:flutter/material.dart';

import 'data/demo_seed.dart';
import 'data/local_db.dart';
import 'ui/register_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final db = LocalDb();
  await seedDemoIfEmpty(db);
  runApp(DocvapeApp(db: db));
}

class DocvapeApp extends StatelessWidget {
  final LocalDb db;
  const DocvapeApp({super.key, required this.db});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'DOCVAPE POS',
        theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.teal),
        // Placeholder ids until device sign-in + PIN login + shifts are built.
        home: RegisterScreen(db: db, branchId: 'demo-branch', shiftId: 'demo-shift', staffId: 'demo-staff'),
      );
}
