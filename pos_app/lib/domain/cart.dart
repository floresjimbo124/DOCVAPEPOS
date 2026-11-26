// Cart and checkout math. Pure Dart, no UI or database, so it is easy to test.
// All money is integer centavos to avoid rounding errors.

import 'package:uuid/uuid.dart';

class CartVariant {
  final String variantId;
  final String productName;
  final String label; // e.g. "Mango · 3mg · 30ml"
  final int priceCentavos;
  final bool isDevice;
  const CartVariant({
    required this.variantId,
    required this.productName,
    required this.label,
    required this.priceCentavos,
    this.isDevice = false,
  });
}

class CartLine {
  final CartVariant variant;
  int quantity;
  String? serialNo;
  CartLine(this.variant, {this.quantity = 1, this.serialNo});
  int get grossCentavos => variant.priceCentavos * quantity;
}

enum DiscountKind { percent, fixed, senior, pwd }

class OrderDiscount {
  final DiscountKind kind;
  final num value; // percent (e.g. 10) or fixed pesos
  final String? idHolder;
  final String? idNumber;
  const OrderDiscount(this.kind, this.value, {this.idHolder, this.idNumber});
}

enum PayMethod { cash, gcash, maya }

class Payment {
  final PayMethod method;
  final int amountCentavos;
  final int? tenderedCentavos; // cash given
  final String? referenceNo;
  const Payment(this.method, this.amountCentavos, {this.tenderedCentavos, this.referenceNo});
}

class CheckoutError implements Exception {
  final String message;
  CheckoutError(this.message);
  @override
  String toString() => message;
}

class Cart {
  /// VAT-registered stores remove 12% VAT before the 20% Senior/PWD discount.
  final bool vatRegistered;
  Cart({this.vatRegistered = true});

  final List<CartLine> lines = [];
  OrderDiscount? discount;
  final List<Payment> payments = [];
  bool ageVerified = false;
  String? manualReceiptNo;

  void add(CartVariant v) {
    final existing = lines.where((l) => l.variant.variantId == v.variantId && !v.isDevice);
    if (existing.isNotEmpty) {
      existing.first.quantity++;
    } else {
      lines.add(CartLine(v)); // devices get one line each so each has its own serial
    }
  }

  void setQuantity(CartLine line, int qty) {
    if (qty <= 0) {
      lines.remove(line);
    } else {
      line.quantity = line.variant.isDevice ? 1 : qty;
    }
  }

  int get subtotalCentavos => lines.fold(0, (s, l) => s + l.grossCentavos);

  int get discountCentavos {
    final d = discount;
    if (d == null) return 0;
    final sub = subtotalCentavos;
    final amount = switch (d.kind) {
      DiscountKind.percent => (sub * d.value / 100).round(),
      DiscountKind.fixed => (d.value * 100).round(),
      // Senior/PWD (RA 9994 / RA 10754): VAT exempt + 20% off the VAT-exclusive price.
      DiscountKind.senior || DiscountKind.pwd =>
        vatRegistered ? sub - (sub / 1.12 * 0.8).round() : (sub * 0.2).round(),
    };
    return amount.clamp(0, sub);
  }

  int get totalCentavos => subtotalCentavos - discountCentavos;
  int get paidCentavos => payments.fold(0, (s, p) => s + p.amountCentavos);
  int get balanceCentavos => totalCentavos - paidCentavos;

  int get changeCentavos => payments
      .where((p) => p.method == PayMethod.cash && p.tenderedCentavos != null)
      .fold(0, (s, p) => s + (p.tenderedCentavos! - p.amountCentavos));

  /// Same checks the server runs, so cashiers see problems before the sale syncs.
  void validate() {
    if (lines.isEmpty) throw CheckoutError('Cart is empty');
    if (!ageVerified) throw CheckoutError('Confirm the customer is 18 or older');
    for (final l in lines) {
      if (l.variant.isDevice && (l.serialNo ?? '').trim().isEmpty) {
        throw CheckoutError('Enter the serial number for ${l.variant.productName}');
      }
    }
    final d = discount;
    if (d != null && (d.kind == DiscountKind.senior || d.kind == DiscountKind.pwd)) {
      if ((d.idHolder ?? '').trim().isEmpty || (d.idNumber ?? '').trim().isEmpty) {
        throw CheckoutError('Senior/PWD discount needs name and ID number');
      }
    }
    for (final p in payments) {
      if (p.method != PayMethod.cash && (p.referenceNo ?? '').trim().isEmpty) {
        throw CheckoutError('Enter the ${p.method.name.toUpperCase()} reference number');
      }
      if (p.tenderedCentavos != null && p.tenderedCentavos! < p.amountCentavos) {
        throw CheckoutError('Cash given is less than the amount');
      }
    }
    if (paidCentavos != totalCentavos) {
      throw CheckoutError('Payments (${peso(paidCentavos)}) do not match total (${peso(totalCentavos)})');
    }
  }

  /// Builds the JSON for the server's complete_sale() function.
  Map<String, dynamic> toSalePayload({
    required String branchId,
    required String shiftId,
    required String staffId,
    String? saleId,
    DateTime? now,
  }) {
    validate();
    String dec(int c) => (c / 100).toStringAsFixed(2);
    final d = discount;
    return {
      'id': saleId ?? const Uuid().v4(),
      'branch_id': branchId,
      'shift_id': shiftId,
      'staff_id': staffId,
      'age_verified': ageVerified,
      'manual_receipt_no': manualReceiptNo,
      'client_created_at': (now ?? DateTime.now()).toUtc().toIso8601String(),
      'items': [
        for (final l in lines)
          {
            'variant_id': l.variant.variantId,
            'quantity': l.quantity,
            'unit_price': dec(l.variant.priceCentavos),
            if (l.serialNo != null) 'serial_no': l.serialNo,
          }
      ],
      'discounts': [
        if (d != null)
          {
            'kind': d.kind.name,
            'value': d.value,
            'amount': dec(discountCentavos),
            if (d.idHolder != null) 'id_holder': d.idHolder,
            if (d.idNumber != null) 'id_number': d.idNumber,
          }
      ],
      'payments': [
        for (final p in payments)
          {
            'method': p.method.name,
            'amount': dec(p.amountCentavos),
            if (p.tenderedCentavos != null) 'tendered': dec(p.tenderedCentavos!),
            if (p.referenceNo != null) 'reference_no': p.referenceNo!.trim(),
          }
      ],
    };
  }

  void clear() {
    lines.clear();
    payments.clear();
    discount = null;
    ageVerified = false;
    manualReceiptNo = null;
  }
}

String peso(int centavos) {
  final s = (centavos.abs() / 100).toStringAsFixed(2);
  final parts = s.split('.');
  final whole = parts[0].replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return '${centavos < 0 ? '-' : ''}₱$whole.${parts[1]}';
}
