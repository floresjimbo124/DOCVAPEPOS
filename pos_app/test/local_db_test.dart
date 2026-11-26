import 'package:docvape_pos/data/demo_seed.dart';
import 'package:docvape_pos/data/local_db.dart';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late LocalDb db;
  setUp(() async {
    db = LocalDb(NativeDatabase.memory());
    await seedDemoIfEmpty(db);
  });
  tearDown(() => db.close());

  test('browse: category -> products -> variants with labels', () async {
    final products = await db.productsIn('c-juice');
    expect(products.map((p) => p.name), ['Freebase 60ml', 'Salt Nic 30ml']);
    final variants = await db.variantsOf('p-salt');
    expect(variants.map((v) => v.label), contains('Mango · 30mg · 30ml'));
  });

  test('search matches flavor, brand and name', () async {
    expect((await db.search('lychee')).single.variant.id, 'v-pod-lychee');
    expect((await db.search('cloud')).length, 5);
    expect((await db.search('pod kit')).length, 2);
  });

  test('favorites keep their order', () async {
    expect((await db.favoriteRows()).map((r) => r.variant.id), ['v-pod-straw', 'v-salt-mango-30']);
  });

  test('queued sale goes to outbox and deducts local stock', () async {
    await db.queueSale('sale-1', '{}', {'v-pod-straw': 3});
    expect((await db.variantsOf('p-pod')).firstWhere((r) => r.variant.id == 'v-pod-straw').stock, 7);
    expect(await db.watchPendingCount().first, 1);
    final rows = await db.select(db.outbox).get();
    expect(rows.single.saleId, 'sale-1');
    // seeding is skipped once data exists
    await seedDemoIfEmpty(db);
    expect((await db.select(db.categories).get()).length, 3);
  });
}
