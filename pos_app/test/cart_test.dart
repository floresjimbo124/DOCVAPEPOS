import 'package:docvape_pos/domain/cart.dart';
import 'package:flutter_test/flutter_test.dart';

const juice = CartVariant(variantId: 'v1', productName: 'Juice', label: 'Mango · 3mg', priceCentavos: 35000);
const kit = CartVariant(variantId: 'v2', productName: 'Pod Kit', label: 'Black', priceCentavos: 120000, isDevice: true);

Cart ready(Cart c) => c..ageVerified = true;

void main() {
  test('same variant stacks, devices get separate lines', () {
    final c = Cart()..add(juice)..add(juice)..add(kit)..add(kit);
    expect(c.lines.length, 3);
    expect(c.lines.first.quantity, 2);
    expect(c.subtotalCentavos, 2 * 35000 + 2 * 120000);
  });

  test('percent and fixed discounts', () {
    final c = Cart()..add(juice)..add(juice);
    c.discount = const OrderDiscount(DiscountKind.percent, 10);
    expect(c.totalCentavos, 63000);
    c.discount = const OrderDiscount(DiscountKind.fixed, 50);
    expect(c.totalCentavos, 65000);
    c.discount = const OrderDiscount(DiscountKind.fixed, 9999);
    expect(c.totalCentavos, 0, reason: 'discount never exceeds subtotal');
  });

  test('senior discount: VAT exempt + 20% when VAT registered', () {
    final c = Cart(vatRegistered: true)..add(juice); // 350.00
    c.discount = const OrderDiscount(DiscountKind.senior, 20, idHolder: 'Lola', idNumber: 'SC-1');
    expect(c.totalCentavos, 25000); // 350 / 1.12 * 0.8 = 250.00
    final nonVat = Cart(vatRegistered: false)..add(juice);
    nonVat.discount = const OrderDiscount(DiscountKind.pwd, 20, idHolder: 'A', idNumber: 'P-1');
    expect(nonVat.totalCentavos, 28000);
  });

  test('validation mirrors server rules', () {
    final c = Cart()..add(juice);
    c.payments.add(const Payment(PayMethod.cash, 35000));
    expect(() => c.validate(), throwsA(isA<CheckoutError>().having((e) => e.message, 'm', contains('18'))));
    c.ageVerified = true;
    c.validate();

    final g = ready(Cart()..add(juice))..payments.add(const Payment(PayMethod.gcash, 35000));
    expect(() => g.validate(), throwsA(isA<CheckoutError>().having((e) => e.message, 'm', contains('reference'))));

    final d = ready(Cart()..add(kit))..payments.add(const Payment(PayMethod.cash, 120000));
    expect(() => d.validate(), throwsA(isA<CheckoutError>().having((e) => e.message, 'm', contains('serial'))));
    d.lines.first.serialNo = 'SN123';
    d.validate();

    final short = ready(Cart()..add(juice))..payments.add(const Payment(PayMethod.cash, 30000));
    expect(() => short.validate(), throwsA(isA<CheckoutError>()));
  });

  test('split payment and change', () {
    final c = ready(Cart()..add(juice)..add(juice)); // 700
    c.payments
      ..add(const Payment(PayMethod.cash, 30000, tenderedCentavos: 50000))
      ..add(const Payment(PayMethod.maya, 40000, referenceNo: 'M-1'));
    c.validate();
    expect(c.changeCentavos, 20000);
  });

  test('payload matches server complete_sale format', () {
    final c = ready(Cart()..add(juice))
      ..manualReceiptNo = '0001'
      ..payments.add(const Payment(PayMethod.gcash, 35000, referenceNo: ' REF1 '));
    final p = c.toSalePayload(branchId: 'b', shiftId: 's', staffId: 'u', saleId: 'id1');
    expect(p['id'], 'id1');
    expect(p['items'][0], {'variant_id': 'v1', 'quantity': 1, 'unit_price': '350.00'});
    expect(p['payments'][0], {'method': 'gcash', 'amount': '350.00', 'reference_no': 'REF1'});
    expect(p['age_verified'], true);
  });

  test('peso formatting', () {
    expect(peso(123456789), '₱1,234,567.89');
    expect(peso(5), '₱0.05');
  });
}
