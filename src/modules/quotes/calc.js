'use strict';

const { Op } = require('sequelize');
const money = require('../../utils/money');
const { DiscountRule, Product } = require('../../models');

/**
 * Server-side quote calculation. All arithmetic uses BigInt fixed-point
 * (utils/money). Per line:
 *   subtotal = qty × unit_price
 *   discount = subtotal × discount% (explicit, else best matching discount rule)
 *   tax      = (subtotal − discount) × tax%
 *   total    = subtotal − discount + tax
 * Each component is rounded half-up to 2 dp; quote totals are sums of rounded lines.
 */
async function bestRuleDiscount(product, qty, transaction) {
  if (!product) return null;
  const today = new Date().toISOString().slice(0, 10);
  const rules = await DiscountRule.findAll({
    where: {
      is_active: true,
      [Op.or]: [{ product_id: product.id }, ...(product.category_id ? [{ category_id: product.category_id }] : [])],
      [Op.and]: [{ [Op.or]: [{ starts_on: null }, { starts_on: { [Op.lte]: today } }] }, { [Op.or]: [{ ends_on: null }, { ends_on: { [Op.gte]: today } }] }],
    },
    transaction,
  });
  let best = null;
  for (const r of rules) {
    if (money.cmp(money.toFixedBig(r.min_quantity), qty) > 0) continue;
    const d = money.toFixedBig(r.discount_percent);
    if (best === null || money.cmp(d, best) > 0) best = d;
  }
  return best;
}

async function calculate(lines, { transaction } = {}) {
  const productIds = lines.map((l) => l.product_id).filter(Boolean);
  const products = productIds.length ? await Product.findAll({ where: { id: productIds }, transaction }) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  let subtotal = 0n;
  let discount = 0n;
  let tax = 0n;
  let maxDiscount = 0n;
  let exceedsProductMax = false;
  const out = [];
  for (const [i, l] of lines.entries()) {
    const product = l.product_id ? byId.get(l.product_id) : null;
    if (l.product_id && !product) {
      const E = require('../../errors/AppError');
      throw E.validation([{ path: `line_items.${i}.product_id`, message: 'Product not found' }]);
    }
    const qty = money.toFixedBig(l.quantity);
    const price = money.toFixedBig(l.unit_price ?? product?.unit_price ?? 0);
    const ruleDiscount = l.discount_percent === undefined || l.discount_percent === null ? await bestRuleDiscount(product, qty, transaction) : null;
    const discPct = l.discount_percent !== undefined && l.discount_percent !== null ? money.toFixedBig(l.discount_percent) : ruleDiscount ?? 0n;
    const taxPct = money.toFixedBig(l.tax_rate ?? product?.tax_rate ?? 0);
    const lineSubtotal = money.round(money.mul(qty, price), 2);
    const lineDiscount = money.round(money.pct(lineSubtotal, discPct), 2);
    const lineTax = money.round(money.pct(lineSubtotal - lineDiscount, taxPct), 2);
    const lineTotal = lineSubtotal - lineDiscount + lineTax;
    subtotal += lineSubtotal;
    discount += lineDiscount;
    tax += lineTax;
    if (discPct > maxDiscount) maxDiscount = discPct;
    if (product?.max_discount_percent !== null && product?.max_discount_percent !== undefined && discPct > money.toFixedBig(product.max_discount_percent)) exceedsProductMax = true;
    out.push({
      product_id: product?.id || null,
      position: i,
      name: l.name || product?.name || 'Item',
      description: l.description ?? product?.description ?? null,
      quantity: money.toString(qty, 4),
      unit_price: money.toString(price, 4),
      discount_percent: money.toString(discPct, 4),
      tax_rate: money.toString(taxPct, 4),
      line_subtotal: money.toString(lineSubtotal, 2),
      line_discount: money.toString(lineDiscount, 2),
      line_tax: money.toString(lineTax, 2),
      line_total: money.toString(lineTotal, 2),
    });
  }
  return {
    lines: out,
    totals: {
      subtotal: money.toString(subtotal, 2),
      discount_total: money.toString(discount, 2),
      tax_total: money.toString(tax, 2),
      total: money.toString(subtotal - discount + tax, 2),
      max_line_discount_percent: money.toString(maxDiscount, 4),
    },
    exceedsProductMax,
  };
}

module.exports = { calculate };
