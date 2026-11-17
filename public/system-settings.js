export const costMethods = [
  ['monthly','全月一次加权平均'],
  ['moving','移动加权平均'],
  ['individual','个别计价']
];

export const defaultSystemSettings = {
  costMethods:['monthly','moving','individual'], movingSource:'stock',
  quantityDigits:3, discountDigits:4, priceDigits:2,
  taxEnabled:true, taxMode:'general', purchaseTax:'exclusive', saleTax:'exclusive',
  manualClose:true
};

export const roundDecimal = (value,digits) => Number(Number(value).toFixed(digits));

export function lineAmounts(quantity, price, discount, rate, taxInclusive) {
  const amount = quantity * price * discount * 100;
  if (taxInclusive) {
    const gross = Math.round(amount);
    const net = Math.round(amount / (1 + rate / 100));
    return {net,tax:gross-net};
  }
  const net = Math.round(amount);
  return {net,tax:Math.round(net * rate / 100)};
}

export const unitPrice = line => line.data.unitPrice ?? line.price / 100;

export function documentTaxInclusive(settings, side) {
  return settings.taxEnabled && (side==='supplier' ? settings.purchaseTax==='inclusive' : side==='customer' && settings.saleTax==='inclusive');
}
