export const costMethods = [
  ['monthly','全月一次加权平均'],
  ['moving','移动加权平均'],
  ['individual','个别计价']
];

export const defaultSystemSettings = {
  costMethods:['monthly','moving','individual'], movingSource:'stock',
  quantityDigits:3, discountDigits:4, priceDigits:2,
  taxEnabled:true, taxMode:'general', purchaseTax:'exclusive', saleTax:'exclusive',
  manualClose:true, defaultSettlementAccount:null, companyName:'', companyAddress:'', companyPhone:''
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

export const tradeTypes = ['purchaseOrder','purchase','purchaseReturn','purchaseExchange','salesOrder','sale','salesReturn','exchange'];
export const tradeFields = [
  ['product','商品编号/名称'],['barcode','条码'],['quantity','数量'],['unit','单位'],
  ['price','单价(不含税)'],['baseAmount','金额'],['discount','折扣'],['discountedUnit','折后单价'],
  ['net','折后金额'],['tax','税率%'],['taxAmount','税额'],['grossUnit','含税单价'],
  ['gross','含税金额'],['source','价格来源'],['note','备注']
];
export const tradeColumns = ['行号',...tradeFields.map(([,label])=>label)];
export const tradeTotalKeys = ['quantity','baseAmount','net','tax','gross'];

export function tradeLine(quantity, price, discount, rate, taxInclusive, stored) {
  const unit = taxInclusive ? price/(1+rate/100) : price;
  const {net,tax} = stored ?? lineAmounts(quantity,price,discount,rate,taxInclusive);
  const discountedUnit = unit*discount;
  return {quantity,unit,baseAmount:Math.round(quantity*unit*100),discount:discount*100,discountedUnit,
    net,rate,tax,grossUnit:discountedUnit*(1+rate/100),gross:net+tax};
}

export function priceFromTradeGross(grossUnit, discount, rate, taxInclusive) {
  return discount>0 ? grossUnit/discount/(taxInclusive?1:1+rate/100) : null;
}

export function priceFromTradeGrossInput(input, quantity, discount, rate, taxInclusive) {
  if (!input) return null;
  if (input.key==='grossAmount'&&!(quantity>0)) return null;
  const grossUnit=input.key==='grossAmount'?input.value/quantity:input.value;
  return priceFromTradeGross(grossUnit,discount,rate,taxInclusive);
}

export function storedTradeLine(line, data) {
  const hasTerms = line.data.unitPrice != null || line.data.discount != null || line.data.tax != null;
  const quantity = (line.data.enteredQuantity??line.quantity)/1000;
  const price = hasTerms ? unitPrice(line) : quantity ? line.net/100/quantity : 0;
  return tradeLine(quantity,price,(line.data.discount??1)*(data.discount??1),line.data.tax??0,data.taxInclusive===true,line);
}

export const tradeLineSign = (type, data) =>
  ['exchange','purchaseExchange'].includes(type)&&data.direction==='return' ? -1 : 1;

export function storedTradeTotals(doc) {
  const totals = Object.fromEntries(tradeTotalKeys.map(key=>[key,0]));
  for (const line of doc.lines) {
    const values = storedTradeLine(line,doc.data);
    for (const key of tradeTotalKeys) totals[key] += values[key]*tradeLineSign(doc.type,line.data);
  }
  return totals;
}

export function tradeLineRow(line, data) {
  const v=storedTradeLine(line,data);
  const price=n=>n.toFixed(Math.max(4,data.precision?.priceDigits??2)).replace(/(\.\d{2,}?)0+$/,'$1');
  const cash=n=>(n/100).toFixed(2);
  const direction=line.data.direction==='return'?'（退回）':line.data.direction==='out'?'（换出/换入）':'';
  return [line.position,[line.productCode,line.productName].filter(Boolean).join(' ')+direction,line.data.barcode??line.productBarcode??'',
    v.quantity,line.data.unit,price(v.unit),cash(v.baseAmount),roundDecimal(v.discount,6)+'%',
    price(v.discountedUnit),cash(v.net),v.rate,cash(v.tax),price(v.grossUnit),cash(v.gross),line.data.source||'手工',line.data.note];
}

export function tradeTotalRow(totals) {
  const cash=n=>(n/100).toFixed(2);
  const values={quantity:roundDecimal(totals.quantity,4),baseAmount:cash(totals.baseAmount),net:cash(totals.net),
    taxAmount:cash(totals.tax),gross:cash(totals.gross)};
  return ['合计',...tradeFields.map(([key])=>values[key]??'')];
}

export function tradeSettlementLabels(type) {
  if (type==='purchaseReturn') return {due:'应收退款合计',advance:'退款转预付款',paid:'本单收退款金额',full:'全额收退款'};
  if (type==='salesReturn') return {due:'应付退款合计',advance:'退款转预收款',paid:'本单付退款金额',full:'全额付退款'};
  return type.startsWith('purchase')
    ? {due:'应付合计',advance:'用预付款',paid:'本单付款金额',full:'全额付款'}
    : {due:'应收合计',advance:'用预收款',paid:'本单收款金额',full:'全额收款'};
}
export function tradeSettlementRows(doc, accountName) {
  const data=doc.data;
  const labels=tradeSettlementLabels(doc.type);
  const cash=n=>(Number(n||0)/100).toFixed(2);
  return [['商品合计(含税)',cash(doc.tradeAmounts.gross)],['整单优惠',cash(data.reduction)],['运费',cash(data.freight)],
    [labels.due,cash(doc.total)],[labels.advance,cash(data.advance)],['资金账户',accountName(data.account)||'—'],
    [labels.paid,cash(data.paid)],['本单未结金额',cash(doc.tradeAmounts.outstanding)],
    ...(doc.execution?[['已执行金额',cash(doc.tradeAmounts.executed)]]:[]),
    ...(data.receipts||[]).map(row=>[accountName(row.account)||'资金账户',cash(row.amount)])];
}

export const costDocumentTypes=['gain','miscIn','loss','transfer','miscOut','issue','issueReturn'];
export const unsettledDocumentTypes=[...tradeTypes,'openingAR','openingAP'];
export function settlementNotice(doc) {
  if (doc.autoSettlements?.length) return '。'+doc.autoSettlements.map(row=>
    '已自动生成'+(row.type==='payment'?'付款单 ':'收款单 ')+row.number).join('；');
  if (tradeTypes.includes(doc.type)&&!['posted','settled'].includes(doc.status)&&
      (Number(doc.data.paid)>0||(doc.data.receipts||[]).some(row=>Number(row.amount)>0))) {
    const payment=doc.type.startsWith('purchase')!==doc.type.endsWith('Return');
    return '。记账后将自动生成'+(payment?'付款单':'收款单');
  }
  return '';
}
