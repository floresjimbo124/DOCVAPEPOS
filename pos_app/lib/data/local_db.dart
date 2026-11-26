// On-device database (SQLite via drift). The register reads only from here,
// so selling works with no internet. Sales wait in the outbox until synced.

import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

part 'local_db.g.dart';

class Categories extends Table {
  TextColumn get id => text()();
  TextColumn get name => text()();
  IntColumn get sortOrder => integer().withDefault(const Constant(0))();
  @override
  Set<Column> get primaryKey => {id};
}

class Products extends Table {
  TextColumn get id => text()();
  TextColumn get categoryId => text().nullable()();
  TextColumn get name => text()();
  TextColumn get brand => text().nullable()();
  BoolColumn get isDevice => boolean().withDefault(const Constant(false))();
  BoolColumn get isActive => boolean().withDefault(const Constant(true))();
  @override
  Set<Column> get primaryKey => {id};
}

class Variants extends Table {
  TextColumn get id => text()();
  TextColumn get productId => text()();
  TextColumn get flavor => text().nullable()();
  RealColumn get nicotineMg => real().nullable()();
  RealColumn get sizeMl => real().nullable()();
  TextColumn get color => text().nullable()();
  IntColumn get priceCentavos => integer()();
  BoolColumn get isActive => boolean().withDefault(const Constant(true))();
  @override
  Set<Column> get primaryKey => {id};
}

/// Stock at THIS device's branch (refreshed on sync, decremented locally on sale).
class LocalStock extends Table {
  TextColumn get variantId => text()();
  IntColumn get quantity => integer()();
  @override
  Set<Column> get primaryKey => {variantId};
}

/// Variants pinned to the favorites row, and recent sales for the "recent" row.
class Favorites extends Table {
  TextColumn get variantId => text()();
  IntColumn get sortOrder => integer().withDefault(const Constant(0))();
  @override
  Set<Column> get primaryKey => {variantId};
}

/// Completed sales waiting to be sent to the server (complete_sale payload JSON).
class Outbox extends Table {
  TextColumn get saleId => text()();
  TextColumn get payload => text()();
  DateTimeColumn get createdAt => dateTime()();
  IntColumn get attempts => integer().withDefault(const Constant(0))();
  TextColumn get lastError => text().nullable()();
  @override
  Set<Column> get primaryKey => {saleId};
}

class VariantRow {
  final Variant variant;
  final Product product;
  final int stock;
  VariantRow(this.variant, this.product, this.stock);

  String get label => [
        if (variant.flavor != null) variant.flavor!,
        if (variant.nicotineMg != null) '${_n(variant.nicotineMg!)}mg',
        if (variant.sizeMl != null) '${_n(variant.sizeMl!)}ml',
        if (variant.color != null) variant.color!,
      ].join(' · ');
  static String _n(double d) => d == d.roundToDouble() ? d.toInt().toString() : d.toString();
}

@DriftDatabase(tables: [Categories, Products, Variants, LocalStock, Favorites, Outbox])
class LocalDb extends _$LocalDb {
  LocalDb([QueryExecutor? e]) : super(e ?? driftDatabase(name: 'docvape_pos'));

  @override
  int get schemaVersion => 1;

  Stream<List<Category>> watchCategories() =>
      (select(categories)..orderBy([(c) => OrderingTerm(expression: c.sortOrder)])).watch();

  Future<List<Product>> productsIn(String categoryId) => (select(products)
        ..where((p) => p.categoryId.equals(categoryId) & p.isActive)
        ..orderBy([(p) => OrderingTerm(expression: p.name)]))
      .get();

  Future<List<VariantRow>> _variantRows(Expression<bool> where) async {
    final q = select(variants).join([
      innerJoin(products, products.id.equalsExp(variants.productId)),
      leftOuterJoin(localStock, localStock.variantId.equalsExp(variants.id)),
    ])
      ..where(variants.isActive & products.isActive & where)
      ..orderBy([OrderingTerm(expression: products.name), OrderingTerm(expression: variants.flavor)]);
    final rows = await q.get();
    return [
      for (final r in rows)
        VariantRow(r.readTable(variants), r.readTable(products), r.readTableOrNull(localStock)?.quantity ?? 0)
    ];
  }

  Future<List<VariantRow>> variantsOf(String productId) => _variantRows(variants.productId.equals(productId));

  /// Search as you type: product name, brand, flavor or color.
  Future<List<VariantRow>> search(String text) {
    final t = '%${text.trim().toLowerCase()}%';
    return _variantRows(products.name.lower().like(t) |
        products.brand.lower().like(t) |
        variants.flavor.lower().like(t) |
        variants.color.lower().like(t));
  }

  Future<List<VariantRow>> favoriteRows() async {
    final favIds = (await (select(favorites)..orderBy([(f) => OrderingTerm(expression: f.sortOrder)])).get())
        .map((f) => f.variantId)
        .toList();
    final rows = await _variantRows(variants.id.isIn(favIds));
    rows.sort((a, b) => favIds.indexOf(a.variant.id).compareTo(favIds.indexOf(b.variant.id)));
    return rows;
  }

  /// Saves the sale to the outbox and deducts local stock in one transaction.
  Future<void> queueSale(String saleId, String payloadJson, Map<String, int> qtyByVariant) => transaction(() async {
        await into(outbox).insert(OutboxCompanion.insert(saleId: saleId, payload: payloadJson, createdAt: DateTime.now()));
        for (final e in qtyByVariant.entries) {
          await customStatement(
              'INSERT INTO local_stock (variant_id, quantity) VALUES (?, ?) '
              'ON CONFLICT(variant_id) DO UPDATE SET quantity = quantity - ?',
              [e.key, -e.value, e.value]);
        }
      });

  Stream<int> watchPendingCount() => (selectOnly(outbox)..addColumns([outbox.saleId.count()]))
      .map((r) => r.read(outbox.saleId.count()) ?? 0)
      .watchSingle();
}
