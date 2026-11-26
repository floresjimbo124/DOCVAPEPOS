// Register: find products by tapping (category -> product -> variant), search,
// or favorites; build the cart; check out. Plain functional UI - visual design later.

import 'dart:convert';

import 'package:flutter/material.dart';

import '../data/local_db.dart';
import '../domain/cart.dart';
import 'checkout_sheet.dart';

class RegisterScreen extends StatefulWidget {
  final LocalDb db;
  final String branchId, shiftId, staffId;
  const RegisterScreen({super.key, required this.db, required this.branchId, required this.shiftId, required this.staffId});
  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final cart = Cart();
  String? categoryId;
  String query = '';
  final searchCtrl = TextEditingController();

  LocalDb get db => widget.db;

  CartVariant _toCart(VariantRow r) => CartVariant(
      variantId: r.variant.id,
      productName: r.product.name,
      label: r.label,
      priceCentavos: r.variant.priceCentavos,
      isDevice: r.product.isDevice);

  void _add(VariantRow r) => setState(() => cart.add(_toCart(r)));

  Future<void> _openProduct(Product p) async {
    final rows = await db.variantsOf(p.id);
    if (!mounted) return;
    if (rows.length == 1) return _add(rows.first);
    final picked = await showModalBottomSheet<VariantRow>(
      context: context,
      builder: (_) => ListView(shrinkWrap: true, children: [
        ListTile(title: Text(p.name, style: const TextStyle(fontWeight: FontWeight.bold))),
        for (final r in rows)
          ListTile(
            title: Text(r.label),
            subtitle: Text('Stock: ${r.stock}'),
            trailing: Text(peso(r.variant.priceCentavos)),
            enabled: r.stock > 0,
            onTap: () => Navigator.pop(context, r),
          ),
      ]),
    );
    if (picked != null) _add(picked);
  }

  Future<void> _checkout() async {
    final done = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => CheckoutSheet(cart: cart),
    );
    if (done != true) return;
    final payload = cart.toSalePayload(branchId: widget.branchId, shiftId: widget.shiftId, staffId: widget.staffId);
    final qty = <String, int>{};
    for (final l in cart.lines) {
      qty[l.variant.variantId] = (qty[l.variant.variantId] ?? 0) + l.quantity;
    }
    final change = cart.changeCentavos;
    await db.queueSale(payload['id'] as String, jsonEncode(payload), qty);
    setState(cart.clear);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(change > 0 ? 'Sale saved. Change: ${peso(change)}' : 'Sale saved')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 800; // tablet vs phone
    final catalogue = _catalogue();
    final cartPanel = _cartPanel();
    return Scaffold(
      appBar: AppBar(title: const Text('Register'), actions: [
        StreamBuilder<int>(
          stream: db.watchPendingCount(),
          builder: (_, s) => Padding(
            padding: const EdgeInsets.all(16),
            child: Text('Unsynced: ${s.data ?? 0}'),
          ),
        ),
      ]),
      body: wide
          ? Row(children: [Expanded(flex: 3, child: catalogue), const VerticalDivider(width: 1), SizedBox(width: 360, child: cartPanel)])
          : catalogue,
      bottomNavigationBar: wide
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: FilledButton(
                  onPressed: cart.lines.isEmpty
                      ? null
                      : () => showModalBottomSheet(
                          context: context, isScrollControlled: true,
                          builder: (_) => StatefulBuilder(builder: (_, _) => SizedBox(height: 500, child: _cartPanel()))),
                  child: Text('Cart (${cart.lines.length}) · ${peso(cart.totalCentavos)}'),
                ),
              ),
            ),
    );
  }

  Widget _catalogue() => Column(children: [
        Padding(
          padding: const EdgeInsets.all(8),
          child: TextField(
            controller: searchCtrl,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search),
              hintText: 'Search name, brand, flavor',
              suffixIcon: query.isEmpty
                  ? null
                  : IconButton(icon: const Icon(Icons.clear), onPressed: () => setState(() { searchCtrl.clear(); query = ''; })),
            ),
            onChanged: (v) => setState(() => query = v),
          ),
        ),
        Expanded(child: query.trim().isEmpty ? _browse() : _variantList(db.search(query))),
      ]);

  Widget _browse() => ListView(children: [
        _sectionTitle('Favorites'),
        SizedBox(height: 72, child: _variantList(db.favoriteRows(), horizontal: true)),
        StreamBuilder<List<Category>>(
          stream: db.watchCategories(),
          builder: (_, s) {
            final cats = s.data ?? [];
            categoryId ??= cats.isEmpty ? null : cats.first.id;
            return Wrap(spacing: 8, children: [
              for (final c in cats)
                ChoiceChip(label: Text(c.name), selected: c.id == categoryId, onSelected: (_) => setState(() => categoryId = c.id)),
            ]);
          },
        ),
        if (categoryId != null)
          FutureBuilder<List<Product>>(
            future: db.productsIn(categoryId!),
            builder: (_, s) => GridView.count(
              crossAxisCount: MediaQuery.sizeOf(context).width >= 800 ? 4 : 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              padding: const EdgeInsets.all(8),
              childAspectRatio: 2,
              children: [
                for (final p in s.data ?? <Product>[])
                  Card(
                    child: InkWell(
                      onTap: () => _openProduct(p),
                      child: Center(child: Text(p.name, textAlign: TextAlign.center)),
                    ),
                  ),
              ],
            ),
          ),
      ]);

  Widget _sectionTitle(String t) =>
      Padding(padding: const EdgeInsets.fromLTRB(8, 8, 8, 4), child: Text(t, style: Theme.of(context).textTheme.titleSmall));

  Widget _variantList(Future<List<VariantRow>> rows, {bool horizontal = false}) => FutureBuilder<List<VariantRow>>(
        future: rows,
        builder: (_, s) {
          final items = s.data ?? [];
          if (horizontal) {
            return ListView(scrollDirection: Axis.horizontal, children: [
              for (final r in items)
                Card(
                  child: InkWell(
                    onTap: r.stock > 0 ? () => _add(r) : null,
                    child: Padding(padding: const EdgeInsets.all(8), child: Text('${r.product.name}\n${r.label}')),
                  ),
                ),
            ]);
          }
          return ListView(children: [
            for (final r in items)
              ListTile(
                title: Text(r.product.name),
                subtitle: Text('${r.label} · Stock ${r.stock}'),
                trailing: Text(peso(r.variant.priceCentavos)),
                enabled: r.stock > 0,
                onTap: () => _add(r),
              ),
          ]);
        },
      );

  Widget _cartPanel() => StatefulBuilder(
        builder: (context, setPanel) {
          void update(VoidCallback f) { setState(f); setPanel(() {}); }
          return Column(children: [
            Expanded(
              child: ListView(children: [
                for (final l in [...cart.lines])
                  ListTile(
                    title: Text(l.variant.productName),
                    subtitle: Text([l.variant.label, if (l.serialNo != null) 'SN ${l.serialNo}'].join(' · ')),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      IconButton(icon: const Icon(Icons.remove), onPressed: () => update(() => cart.setQuantity(l, l.quantity - 1))),
                      Text('${l.quantity}'),
                      IconButton(icon: const Icon(Icons.add), onPressed: l.variant.isDevice ? null : () => update(() => cart.setQuantity(l, l.quantity + 1))),
                    ]),
                  ),
              ]),
            ),
            ListTile(title: const Text('Total'), trailing: Text(peso(cart.totalCentavos), style: Theme.of(context).textTheme.titleLarge)),
            Padding(
              padding: const EdgeInsets.all(8),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(onPressed: cart.lines.isEmpty ? null : _checkout, child: const Text('Checkout')),
              ),
            ),
          ]);
        },
      );
}
