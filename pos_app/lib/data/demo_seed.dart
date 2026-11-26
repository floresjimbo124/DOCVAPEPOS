// Sample catalogue so the register can be tried before the real product list
// arrives. Replaced by server sync later.

import 'package:drift/drift.dart';
import 'local_db.dart';

Future<void> seedDemoIfEmpty(LocalDb db) async {
  if ((await db.select(db.categories).get()).isNotEmpty) return;
  await db.batch((b) {
    b.insertAll(db.categories, [
      CategoriesCompanion.insert(id: 'c-juice', name: 'E-Liquids', sortOrder: const Value(1)),
      CategoriesCompanion.insert(id: 'c-pods', name: 'Pods', sortOrder: const Value(2)),
      CategoriesCompanion.insert(id: 'c-dev', name: 'Devices', sortOrder: const Value(3)),
    ]);
    b.insertAll(db.products, [
      ProductsCompanion.insert(id: 'p-salt', categoryId: const Value('c-juice'), name: 'Salt Nic 30ml', brand: const Value('Cloud Co')),
      ProductsCompanion.insert(id: 'p-free', categoryId: const Value('c-juice'), name: 'Freebase 60ml', brand: const Value('Cloud Co')),
      ProductsCompanion.insert(id: 'p-pod', categoryId: const Value('c-pods'), name: 'Disposable Pod 5000', brand: const Value('PuffMax')),
      ProductsCompanion.insert(id: 'p-kit', categoryId: const Value('c-dev'), name: 'Pod Kit X', brand: const Value('VapeTech'), isDevice: const Value(true)),
    ]);
    VariantsCompanion v(String id, String p, int price, {String? flavor, double? mg, double? ml, String? color}) =>
        VariantsCompanion.insert(
            id: id, productId: p, priceCentavos: price,
            flavor: Value(flavor), nicotineMg: Value(mg), sizeMl: Value(ml), color: Value(color));
    b.insertAll(db.variants, [
      v('v-salt-mango-30', 'p-salt', 35000, flavor: 'Mango', mg: 30, ml: 30),
      v('v-salt-mango-50', 'p-salt', 37000, flavor: 'Mango', mg: 50, ml: 30),
      v('v-salt-grape-30', 'p-salt', 35000, flavor: 'Grape', mg: 30, ml: 30),
      v('v-free-mint-3', 'p-free', 45000, flavor: 'Mint', mg: 3, ml: 60),
      v('v-free-mint-6', 'p-free', 45000, flavor: 'Mint', mg: 6, ml: 60),
      v('v-pod-straw', 'p-pod', 55000, flavor: 'Strawberry'),
      v('v-pod-lychee', 'p-pod', 55000, flavor: 'Lychee Ice'),
      v('v-kit-black', 'p-kit', 120000, color: 'Black'),
      v('v-kit-blue', 'p-kit', 120000, color: 'Blue'),
    ]);
    b.insertAll(db.localStock, [
      for (final id in ['v-salt-mango-30', 'v-salt-mango-50', 'v-salt-grape-30', 'v-free-mint-3', 'v-free-mint-6',
        'v-pod-straw', 'v-pod-lychee', 'v-kit-black', 'v-kit-blue'])
        LocalStockCompanion.insert(variantId: id, quantity: 10),
    ]);
    b.insertAll(db.favorites, [
      FavoritesCompanion.insert(variantId: 'v-pod-straw', sortOrder: const Value(1)),
      FavoritesCompanion.insert(variantId: 'v-salt-mango-30', sortOrder: const Value(2)),
    ]);
  });
}
