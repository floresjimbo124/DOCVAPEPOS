// Checkout: age check, device serials, discount, manual receipt no., payment.
// Returns true when the cart passes validation and is ready to save.

import 'package:flutter/material.dart';

import '../domain/cart.dart';

class CheckoutSheet extends StatefulWidget {
  final Cart cart;
  const CheckoutSheet({super.key, required this.cart});
  @override
  State<CheckoutSheet> createState() => _CheckoutSheetState();
}

class _CheckoutSheetState extends State<CheckoutSheet> {
  Cart get cart => widget.cart;
  PayMethod method = PayMethod.cash;
  final tendered = TextEditingController();
  final reference = TextEditingController();
  final receipt = TextEditingController();
  final serials = <CartLine, TextEditingController>{};
  String? error;

  int? _centavos(String s) {
    final v = double.tryParse(s.replaceAll(',', '').trim());
    return v == null ? null : (v * 100).round();
  }

  Future<void> _pickDiscount() async {
    final kind = await showDialog<DiscountKind?>(
      context: context,
      builder: (_) => SimpleDialog(title: const Text('Discount'), children: [
        for (final k in DiscountKind.values)
          SimpleDialogOption(onPressed: () => Navigator.pop(context, k), child: Text(k.name.toUpperCase())),
        SimpleDialogOption(onPressed: () => Navigator.pop(context), child: const Text('Remove discount')),
      ]),
    );
    if (!mounted) return;
    if (kind == null) return setState(() => cart.discount = null);
    final a = TextEditingController(), b = TextEditingController();
    final idBased = kind == DiscountKind.senior || kind == DiscountKind.pwd;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(kind.name.toUpperCase()),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: a, decoration: InputDecoration(labelText: idBased ? 'Name on ID' : (kind == DiscountKind.percent ? 'Percent' : 'Amount (₱)')),
              keyboardType: idBased ? TextInputType.name : TextInputType.number),
          if (idBased) TextField(controller: b, decoration: const InputDecoration(labelText: 'ID number')),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Apply'))],
      ),
    );
    if (ok != true) return;
    setState(() {
      cart.discount = idBased
          ? OrderDiscount(kind, 20, idHolder: a.text.trim(), idNumber: b.text.trim())
          : OrderDiscount(kind, double.tryParse(a.text) ?? 0);
    });
  }

  void _confirm() {
    for (final e in serials.entries) {
      e.key.serialNo = e.value.text.trim().isEmpty ? null : e.value.text.trim();
    }
    cart.manualReceiptNo = receipt.text.trim().isEmpty ? null : receipt.text.trim();
    cart.payments
      ..clear()
      ..add(Payment(
        method,
        cart.totalCentavos,
        tenderedCentavos: method == PayMethod.cash ? (_centavos(tendered.text) ?? cart.totalCentavos) : null,
        referenceNo: method == PayMethod.cash ? null : reference.text,
      ));
    try {
      cart.validate();
      Navigator.pop(context, true);
    } on CheckoutError catch (e) {
      cart.payments.clear();
      setState(() => error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final devices = cart.lines.where((l) => l.variant.isDevice).toList();
    for (final d in devices) {
      serials.putIfAbsent(d, () => TextEditingController(text: d.serialNo));
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.viewInsetsOf(context).bottom + 16),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Total ${peso(cart.totalCentavos)}', style: Theme.of(context).textTheme.headlineSmall),
          if (cart.discountCentavos > 0) Text('Discount ${cart.discount!.kind.name.toUpperCase()}: -${peso(cart.discountCentavos)}'),
          TextButton(onPressed: _pickDiscount, child: const Text('Discount…')),
          CheckboxListTile(
            value: cart.ageVerified,
            onChanged: (v) => setState(() => cart.ageVerified = v ?? false),
            title: const Text('Customer is 18+ (ID checked)'),
            subtitle: const Text('Required by RA 11900'),
          ),
          for (final d in devices)
            TextField(controller: serials[d], decoration: InputDecoration(labelText: 'Serial no. – ${d.variant.productName} ${d.variant.label}')),
          TextField(controller: receipt, decoration: const InputDecoration(labelText: 'Manual receipt no.')),
          const SizedBox(height: 12),
          SegmentedButton<PayMethod>(
            segments: const [
              ButtonSegment(value: PayMethod.cash, label: Text('Cash')),
              ButtonSegment(value: PayMethod.gcash, label: Text('GCash')),
              ButtonSegment(value: PayMethod.maya, label: Text('Maya')),
            ],
            selected: {method},
            onSelectionChanged: (s) => setState(() => method = s.first),
          ),
          if (method == PayMethod.cash)
            TextField(controller: tendered, keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Cash given (₱) – blank = exact'))
          else ...[
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text('Show the branch QR. Check the payment arrived on the branch phone before confirming.'),
            ),
            TextField(controller: reference, decoration: const InputDecoration(labelText: 'Reference no.')),
          ],
          if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          const SizedBox(height: 12),
          FilledButton(onPressed: _confirm, child: const Text('Complete sale')),
        ]),
      ),
    );
  }
}
