import { permits } from '../public/permissions.js';
import { getSystemSettings } from './system-settings.js';
import { documentTaxInclusive, lineAmounts, roundDecimal, unitPrice } from '../public/system-settings.js';
import { documentFields, normalizeFieldRules } from '../public/document-settings.js';
import { families, stockEffects, relatedDocuments, settlementFooters, submittedSources, orderFulfillment } from '../public/catalog.js';
import { productUnits } from '../public/units.js';
import { generateJournal, adjustJournalForClosing } from './accounting.js';

export const parse = value => JSON.parse(value || '{}');
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: process.env.ERP_TIMEZONE || 'America/New_York' });
export function check(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), {status});
}
export function number(value, min = 0, max = 1e8) {
  const n = Number(value ?? 0);
  check(Number.isFinite(n) && n >= min && n <= max, '数值超出允许范围');
  return n;
}
export const cents = value => Math.round(number(value) * 100);
const scaledQuantity = value => roundDecimal(value,1);
export const qty = (value,digits=3) => scaledQuantity(roundDecimal(number(value,0,1e6),digits)*1000);
export const editable = ['draft','rejected'];
export const posted = ['posted','settled'];
export const transitions = {
  draft:{submit:'pending',delete:'deleted',stop:'stopped'},
  pending:{approve:'approved',reject:'rejected',stop:'stopped'},
  approved:{post:'posted',unapprove:'draft'}, posted:{settle:'settled'}, rejected:{submit:'pending',delete:'deleted'},
  stopped:{restore:'draft',delete:'deleted'}, deleted:{restore:'draft'}
};
export function visible(user, row) {
  if (user.role === 'admin') return true;
  const warehouses = JSON.parse(user.warehouses);
  return (!user.department || !row.department || row.department === user.department)
    && [row.warehouse,row.target].every(id => !id || !warehouses.length || warehouses.includes(id));
}
export function getMaster(s, id, kind, required = true) {
  if (!id && !required) return null;
  const row = s.one('SELECT * FROM master WHERE id=? AND kind=? AND active=1', Number(id || 0), kind);
  check(row, '请选择有效的' + ({products:'商品', partners:'往来单位', warehouses:'仓库', accounts:'资金账户',ledgerAccounts:'会计科目'}[kind] || '资料'));
  return {...row, data:parse(row.data)};
}
export function lookupPrice(s, productId, partnerId, quantity, side, preset = 1) {
  const product = getMaster(s, productId, 'products').data;
  const rows = s.all('SELECT name,data FROM master WHERE active=1 AND kind IN (?,?)', side === 'supplier' ? 'supplierPrices' : 'customerPrices', 'tiers');
  const matches = rows.map(r => parse(r.data)).filter(r => Number(r.product) === productId);
  const partner = partnerId && matches.find(r => Number(r.partner) === partnerId);
  if (partner) return {price:number(partner.price), source:side === 'supplier' ? '供货商价格本' : '客户价格本'};
  const tier = matches.filter(r => !r.partner && number(r.minimum) <= quantity).sort((a,b) => b.minimum-a.minimum)[0];
  if (tier) return {price:number(tier.price),source:'数量阶梯价'};
  const presetPrice = product['preset' + preset];
  if (presetPrice !== '' && presetPrice != null) return {price:number(presetPrice),source:'预设售价 ' + preset};
  return side === 'supplier' && product.purchase != null
    ? {price:number(product.purchase),source:'采购价'} : {price:number(product.retail),source:'零售价'};
}
function orderExecution(s,user,order) {
  const type=orderFulfillment[order.type];
  const downstream=s.all(`SELECT id,number,date,status,warehouse,target,department,type FROM documents
    WHERE type=? AND json_extract(data,'$.reference')=? AND status IN ('posted','settled') ORDER BY date,id`,type,order.id);
  const processed=s.all(`SELECT l.product,SUM(l.quantity) quantity FROM lines l JOIN documents d ON d.id=l.doc
    WHERE d.type=? AND json_extract(d.data,'$.reference')=? AND d.status IN ('posted','settled') GROUP BY l.product`,type,order.id);
  const quantities=new Map(processed.map(line=>[line.product,line.quantity]));
  const rows=order.lines.map(line=>{
    const done=Math.min(line.quantity,scaledQuantity(quantities.get(line.product)||0));
    quantities.set(line.product,scaledQuantity((quantities.get(line.product)||0)-done));
    return {position:line.position,ordered:line.quantity,done,remaining:scaledQuantity(line.quantity-done)};
  });
  const remaining=rows.some(line=>line.remaining>0);
  const state=!remaining?'complete':order.status==='settled'?'closed':rows.some(line=>line.done)?'partial':'waiting';
  return {rows,state,documents:downstream.filter(row=>visible(user,row)&&permits(user,'d:'+row.type))};
}
export function documentBalance(s,docId,partner,category) {
  return s.one('SELECT COALESCE(SUM(amount),0) total FROM ledger WHERE reference=? AND entity=? AND category=?',
    docId,partner,category).total;
}
export function getDocument(s, user, id, detail=false) {
  const row = s.one(`SELECT d.*, p.name partnerName, w.name warehouseName, u.name creatorName
    FROM documents d LEFT JOIN master p ON d.partner=p.id LEFT JOIN master w ON d.warehouse=w.id
    JOIN users u ON u.id=d.creator WHERE d.id=?`, Number(id));
  check(row && visible(user,row) && permits(user,'d:'+row.type), '单据不存在或无访问权限', 404);
  const doc={...row,data:parse(row.data),attachments:s.all('SELECT id,name,length(content) size FROM attachments WHERE doc=? ORDER BY id',row.id),lines:s.all(`SELECT l.*, m.name productName, m.code productCode
    FROM lines l LEFT JOIN master m ON m.id=l.product WHERE l.doc=? ORDER BY l.position`,row.id)
    .map(line => ({...line,data:parse(line.data)}))};
  if (Object.hasOwn(orderFulfillment,doc.type)) doc.execution=orderExecution(s,user,doc);
  if (['purchase','purchaseExchange','sale','exchange'].includes(doc.type)) {
    doc.unpaid=documentBalance(s,doc.id,doc.partner,['purchase','purchaseExchange'].includes(doc.type)?'ap':'ar');
  }
  if (detail) {
    doc.relations=s.all(`SELECT d.id,d.number,d.type,d.status,d.date,d.department,d.warehouse,d.target
      FROM documents d WHERE d.status!='deleted' AND (d.id=? OR json_extract(d.data,'$.reference')=?)
      ORDER BY d.date,d.id`,doc.data.reference||null,doc.id)
      .filter(row=>visible(user,row)&&permits(user,'d:'+row.type)).map(({id,number,type,status,date})=>({id,number,type,status,date}));
    doc.history=s.all(`SELECT a.created date,a.action,u.name operator FROM audit a LEFT JOIN users u ON u.id=a.user_id
      WHERE (a.action='保存单据' AND a.detail=?) OR (a.action IN ('submit','approve','unapprove','reject','post','settle','stop','delete','restore') AND a.detail=?)
      ORDER BY a.id DESC LIMIT 100`,String(doc.id),doc.number);
    const accounts=[doc.data.account,doc.data.targetAccount,...(doc.data.receipts||[]).map(row=>row.account),
      ...(doc.data.saleExpenses||[]).flatMap(row=>[row.partner,row.subject,row.account]),doc.data.carrier];
    doc.names=Object.fromEntries([...new Set(accounts.filter(Boolean).map(Number))].map(key=>[key,s.one('SELECT name FROM master WHERE id=?',key)?.name||'']));
  }
  return doc;
}
function validateDate(date) {
  check(/^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(date)) &&
    new Date(date).toISOString().slice(0,10) === date && date <= today(), '请输入不晚于今天的有效单据日期');
}
function openPeriod(s,date) {
  check(!s.one('SELECT month FROM closes WHERE month>=? LIMIT 1', date.slice(0,7)), '该期间已月结');
}
export function saveDocument(s, user, input, {preview=false}={}) {
  return s.tx(() => {
    const current = input.id ? getDocument(s,user,input.id) : null;
    check(!current || editable.includes(current.status), '仅草稿或驳回的单据可编辑',409);
    if (current) check(input.revision === current.data.revision, '单据已被其他用户修改，请重新打开',409);
    const type = current?.type || input.type;
    check(Object.hasOwn(families,type),'未知单据类型');
    check(permits(user,'d:'+type,current?'edit':'create'),'没有此单据的保存权限',403);
    const [,prefix,,partnerType,effect] = families[type];
    const date = input.date || today();
    validateDate(date);
    check(!current || date === current.date, '已编号单据不能修改单据日期，请重新开单');
    openPeriod(s,date);
    let department = user.role === 'admin' ? String(input.department || '') : user.department;
    const selected = input.data ?? {};
    const configured=s.one('SELECT fields_json FROM document_settings WHERE user_id=? AND type=?',user.id,type);
    const rules=normalizeFieldRules(type,parse(configured?.fields_json||'{}'));
    const requireConfigured=(section,values,prefix='')=>{
      for (const [key,rule] of Object.entries(rules[section])) {
        if (!rule.required) continue;
        const value=values[key];
        const label=rule.alias||configuredLabels[section].find(f=>f.key===key).label;
        check((typeof value==='string'&&value.trim()!=='')||(typeof value==='number'&&Number.isFinite(value)),prefix+'请填写'+label);
      }
    };
    const configuredLabels=documentFields(type);
    requireConfigured('head',{...selected,...input});
    requireConfigured('headCustom',selected);
    requireConfigured('foot',selected);
    const partner = getMaster(s,input.partner,'partners',!!partnerType);
    check(!partnerType || [partnerType,'both'].includes(partner.data.type), '往来单位类型与单据不符');
    let warehouse = getMaster(s,input.warehouse,'warehouses',stockEffects.includes(effect) || ['purchaseOrder','salesOrder','transferOrder','purchaseFee'].includes(type));
    const target = getMaster(s,input.target,'warehouses',effect === 'transfer' || type === 'transferOrder');
    check(!target || (warehouse && target.id !== warehouse.id), '调入仓和调出仓必须不同');
    check(visible(user,{department,warehouse:warehouse?.id,target:target?.id}), '超出部门或仓库权限',403);
    const foreign = selected.reference ? getDocument(s,user,selected.reference) : null;
    if (foreign) {
      check(relatedDocuments[type]?.includes(foreign.type), '关联单据类型不匹配');
      const allowed=submittedSources.includes(foreign.type)?['pending','approved',...posted]:posted;
      check(allowed.includes(foreign.status),'关联单据尚未提交或已失效');
      if (orderFulfillment[foreign.type]===type) check(!['complete','closed'].includes(foreign.execution.state),'关联订单已完成或已终止');
      check(!partner || partner.id === foreign.partner || type==='payment'&&['sale','purchase'].includes(foreign.type)&&
        foreign.data.saleExpenses?.some(row=>row.partner===partner.id), '关联单据的往来单位不一致');
      check(date >= foreign.date, '单据日期不能早于关联单据');
      if (['purchase','sale','transfer','purchaseReturn','purchaseExchange','salesReturn','exchange'].includes(type))
        check(!foreign.warehouse || warehouse?.id===foreign.warehouse,'关联单据的仓库不一致');
      if (type==='transfer') check(target?.id===foreign.target,'关联调拨订单的调入仓不一致');
      if (['receipt','payment','salesFee'].includes(type)) {
        warehouse=foreign.warehouse ? getMaster(s,foreign.warehouse,'warehouses') : null;
        department=foreign.department;
        check(visible(user,{department,warehouse:warehouse?.id}), '超出部门或仓库权限',403);
      }
    }
    const settings=getSystemSettings(s);
    const precision=current?.data.precision || (current ? {quantityDigits:3,priceDigits:2,discountDigits:4} :
      {quantityDigits:settings.quantityDigits,priceDigits:settings.priceDigits,discountDigits:settings.discountDigits});
    const taxEnabled=current ? current.data.taxEnabled!==false : settings.taxEnabled;
    const taxInclusive=current ? current.data.taxInclusive===true : documentTaxInclusive(settings,partnerType);
    const taxMode=current ? current.data.taxMode||'general' : settings.taxMode;
    const discount=roundDecimal(number(selected.discount??1,0,1),precision.discountDigits);
    const data = {
      ...selected, precision, taxEnabled, taxInclusive, taxMode, reference:foreign?.id || null, discount, revision:(current?.data.revision || 0)+1,
      amount:cents(selected.amount), reduction:cents(selected.reduction), freight:cents(selected.freight),
      advance:cents(selected.advance), fee:cents(selected.fee), paid:cents(selected.paid)
    };
    if (selected.handlerId) {
      const staff=s.one('SELECT id,name FROM users WHERE id=? AND active=1',Number(selected.handlerId));
      check(staff,'请选择在职的经手人');
      data.handlerId=staff.id;
      data.handler=staff.name;
    }
    for (const [key,kind] of [['carrier','carriers'],['settlementPartner','partners'],['account','accounts'],
      ['targetAccount','accounts'],['subject','expenses']]) {
      if (selected[key]) data[key]=getMaster(s,selected[key],kind).id;
    }
    if (settlementFooters.includes(type)) {
      const receipts=selected.receipts||[];
      const saleExpenses=selected.saleExpenses||[];
      check(Array.isArray(receipts)&&Array.isArray(saleExpenses)&&receipts.length<=30&&saleExpenses.length<=30,'收款信息与销售费用各最多 30 行');
      data.receipts=receipts.map(row=>({
        account:getMaster(s,row.account,'accounts').id,amount:cents(row.amount)
      })).filter(row=>row.amount>0);
      data.saleExpenses=saleExpenses.map(row=>({
        partner:getMaster(s,row.partner,'partners',false)?.id||null,
        subject:getMaster(s,row.subject,'expenses',false)?.id||null,
        amount:cents(row.amount),paid:cents(row.paid),account:getMaster(s,row.account,'accounts',false)?.id||null,
        note:String(row.note||'').slice(0,200)
      })).filter(row=>row.amount||row.paid);
      check(data.saleExpenses.every(row=>row.paid<=row.amount && (!row.paid||row.account) &&
        (row.paid===row.amount||row.partner)),'未付销售费用须指定往来单位，已付金额须指定付款账户');
    }
    const rows = input.lines || [];
    check(Array.isArray(rows) && rows.length <= 500,'明细最多 500 行');
    const goods = !['cash','journal'].includes(effect);
    if (goods) check(rows.length > 0,'请填写商品明细');
    const lines = rows.map((row,i) => {
      requireConfigured('body',row,'第 '+(i+1)+' 行：');
      requireConfigured('bodyCustom',row,'第 '+(i+1)+' 行：');
      const product = goods ? getMaster(s,row.product,'products') : null;
      const base=product?.data.unit||'';
      const unit=String(row.unit||base);
      const unitsByProduct=goods?productUnits(product.data):null;
      const unitFactor=goods?unitsByProduct.get(unit):1;
      check(unitFactor,'明细单位与商品的单位设置不符');
      const enteredQuantity=goods?qty(row.quantity,precision.quantityDigits):0;
      const units=qty(enteredQuantity*unitFactor/1000,Math.max(3,precision.quantityDigits));
      check(!goods || units > 0 || ['count','revalue','fee'].includes(effect),'数量必须大于零');
      const price=goods?roundDecimal(number(row.price),precision.priceDigits):0;
      const lineDiscount=roundDecimal(number(row.discount??1,0,1),precision.discountDigits);
      const rate=taxEnabled?number(row.tax??0,0,100):0;
      const {net,tax}=lineAmounts(enteredQuantity/1000,price,lineDiscount*discount,rate,taxInclusive);
      let debit = 0;
      let credit = 0;
      let account = null;
      if (effect === 'journal') {
        account = getMaster(s,row.ledgerAccount,'ledgerAccounts').id;
        debit = cents(row.debit);
        credit = cents(row.credit);
        check((debit > 0) !== (credit > 0),'凭证明细须选择借方或贷方金额');
      }
      const data = {...row,unitPrice:price,unit,unitFactor,enteredQuantity,discount:lineDiscount,tax:rate,debit,credit,ledgerAccount:account,
        batch:String(row.batch || '').trim(),expiry:String(row.expiry || ''),serials:[...new Set(String(row.serials || '').split(/[，,\s]+/).filter(Boolean))]};
      return {position:i+1,product:product?.id || null,units,price:cents(price),net,tax,data};
    });
    if (effect === 'journal') {
      check(lines.length >= 2 && lines.reduce((n,l) => n+l.data.debit-l.data.credit,0) === 0,'借方和贷方合计必须相等');
    }
    if (['cash','fee'].includes(effect)) check(data.amount > 0,'金额必须大于零');
    if (type==='purchaseExchange') check(lines.some(line=>line.data.direction==='return')&&lines.some(line=>line.data.direction!=='return'),'采购换货须同时填写退回供应商和换入明细');
    const total = ['cash','fee'].includes(effect) ? data.amount : lines.reduce((sum,l) => sum + (l.data.direction === 'return' && effect === 'exchange' ? -1 : 1) * (l.net+l.tax),0) + data.freight - data.reduction;
    check(Number.isSafeInteger(total) && (total >= 0 || effect === 'exchange'),'单据金额无效');
    validateDocumentLimits(s,{type,total,partner:partner?.id,warehouse:warehouse?.id,
      lines:lines.map(line=>({...line,quantity:line.units}))},foreign);
    if (preview) return {valid:true};
    if (current) {
      s.run('UPDATE documents SET date=?,partner=?,warehouse=?,target=?,department=?,total=?,data=? WHERE id=?',date,partner?.id||null,warehouse?.id||null,target?.id||null,department,total,JSON.stringify(data),current.id);
      s.run('DELETE FROM lines WHERE doc=?',current.id);
    }
    const sequence = current ? null : s.one(`INSERT INTO sequences(prefix,date,value) VALUES (?,?,1)
      ON CONFLICT(prefix,date) DO UPDATE SET value=value+1 RETURNING value`,prefix,date).value;
    check(current || sequence <= 99999,'当日编号已用完');
    const id = current?.id || s.run(`INSERT INTO documents(number,type,date,status,partner,warehouse,target,department,creator,total,data)
      VALUES (?,?,?,'draft',?,?,?,?,?,?,?)`,prefix+'-'+date.replaceAll('-','')+'-'+String(sequence).padStart(5,'0'),
      type,date,partner?.id||null,warehouse?.id||null,target?.id||null,department,user.id,total,JSON.stringify(data)).lastInsertRowid;
    for (const line of lines) {
      s.run('INSERT INTO lines VALUES (?,?,?,?,?,?,?,?)',id,line.position,line.product,line.units,line.price,line.net,line.tax,JSON.stringify(line.data));
    }
    const existingAttachments=s.all('SELECT id,length(content) size FROM attachments WHERE doc=?',id);
    const removed=input.removedAttachments||[];
    const additional=input.attachments||[];
    check(Array.isArray(removed)&&Array.isArray(additional)&&additional.length<=10,'无效附件列表');
    const remaining=existingAttachments.filter(file=>!removed.includes(file.id));
    let attachmentBytes=remaining.reduce((n,f)=>n+f.size,0);
    check(remaining.length+additional.length<=10,'每单最多 10 个附件');
    for (const file of existingAttachments.filter(file=>removed.includes(file.id))) s.run('DELETE FROM attachments WHERE id=? AND doc=?',file.id,id);
    for (const file of additional) {
      const name=String(file.name||'');
      check(name.length<=180 && !/[\u0000-\u001f\u007f/\\]/.test(name) &&
        /\.(jpg|jpeg|gif|png|bmp|txt|doc|docx|xls|xlsx|ppt|pptx|pdf|zip|rar)$/i.test(name),'附件类型或名称无效');
      check(typeof file.content==='string' && file.content.length<=20*1024*1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(file.content),'附件格式或大小无效');
      const content=Buffer.from(file.content,'base64');
      check(content.length && content.length<=15*1024*1024,'单个附件最大 15 MB');
      attachmentBytes+=content.length;
      check(attachmentBytes<=30*1024*1024,'每单附件合计最大 30 MB');
      s.run('INSERT INTO attachments(doc,name,content) VALUES (?,?,?)',id,name,content);
    }
    log(s,user,'保存单据',String(id));
    return getDocument(s,user,id);
  });
}
export function log(s,user,action,detail) {
  s.run('INSERT INTO audit(user_id,action,detail) VALUES (?,?,?)',user.id,action,detail);
}
function balance(s, product, warehouse) {
  return s.one('SELECT quantity,value FROM stock WHERE product=? AND warehouse=?',product,warehouse) || {quantity:0,value:0};
}
function adjustStock(s,doc,line,warehouse,quantity,value,incoming,product) {
  check(!s.one('SELECT id FROM movements WHERE product=? AND warehouse=? AND date>? LIMIT 1',line.product,warehouse,doc.date),
    product.name+'已有更晚日期的库存流水，请核对记账顺序');
  const before = balance(s,line.product,warehouse);
  const after = scaledQuantity(before.quantity+quantity);
  check(after >= 0, product.name + '库存不足');
  const {batch,expiry,serials} = line.data;
  if (quantity !== 0 && product.data.batch) {
    check(batch,'请输入'+ product.name +'的批次号');
    const existing = s.one('SELECT quantity,expiry FROM lots WHERE product=? AND warehouse=? AND batch=?',line.product,warehouse,batch);
    const lot = scaledQuantity((existing?.quantity || 0)+quantity);
    check(lot>=0,product.name+'批次库存不足');
    check(!existing?.expiry || !expiry || existing.expiry===expiry,'该批次到期日期不一致');
    s.run(`INSERT INTO lots VALUES (?,?,?,?,?) ON CONFLICT(product,warehouse,batch)
      DO UPDATE SET quantity=excluded.quantity,expiry=excluded.expiry`,line.product,warehouse,batch,expiry || existing?.expiry || '',lot);
  }
  if (quantity !== 0 && product.data.serial) {
    check(serials.length * 1000 === Math.abs(quantity),'序列号个数须等于变动数量');
    for (const serial of serials) {
      const existing = s.one('SELECT warehouse,batch FROM serials WHERE product=? AND serial=?',line.product,serial);
      if (quantity > 0) {
        check(!existing,'序列号 '+serial+' 已在库');
        s.run('INSERT INTO serials VALUES (?,?,?,?)',line.product,serial,warehouse,batch);
      } else {
        check(existing?.warehouse === warehouse && existing.batch === batch,'序列号 '+serial+' 不属于当前仓库和批次');
        s.run('DELETE FROM serials WHERE product=? AND serial=?',line.product,serial);
      }
    }
  }
  const deltaValue = after === 0 ? -before.value : value;
  check(before.value+deltaValue >= 0,'库存金额不能为负');
  s.run(`INSERT INTO stock VALUES (?,?,?,?) ON CONFLICT(product,warehouse)
    DO UPDATE SET quantity=excluded.quantity,value=excluded.value`,line.product,warehouse,after,before.value+deltaValue);
  s.run(`INSERT INTO movements(doc,position,date,product,warehouse,quantity,value,incoming,cost_method,batch,expiry,serials)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,doc.id,line.position,doc.date,line.product,warehouse,quantity,deltaValue,
    incoming ? 1 : 0,product.data.method || 'moving',batch,expiry,JSON.stringify(serials));
  return deltaValue;
}
function batchBalance(s,product,warehouse,batch) {
  const row=s.one(`SELECT COALESCE(SUM(quantity),0) quantity, COALESCE(SUM(value),0) value
    FROM movements WHERE product=? AND warehouse=? AND batch=?`,product,warehouse,batch);
  return {...row,quantity:scaledQuantity(row.quantity)};
}
function stockPosting(s,doc,effect,reference) {
  let cost = 0;
  const {movingSource}=getSystemSettings(s);
  const lines=doc.type==='purchaseExchange'?[...doc.lines].sort((a,b)=>Number(b.data.direction==='return')-Number(a.data.direction==='return')):doc.lines;
  for (const line of lines) {
    const product = getMaster(s,line.product,'products');
    if (product.data.type === 'service') continue;
    const individual=product.data.method==='individual';
    const batch=line.data.batch;
    if (individual) check(batch,'请输入'+product.name+'的批次号');
    const current=individual?batchBalance(s,line.product,doc.warehouse,batch):balance(s,line.product,doc.warehouse);
    const quantity = line.quantity;
    const average = current.quantity ? current.value / current.quantity : 0;
    const out = amount => {
      if (individual) check(current.quantity>=amount,product.name+'批次库存不足');
      const value=individual&&current.quantity===amount?current.value:Math.round(average*amount);
      return adjustStock(s,doc,line,doc.warehouse,-amount,-value,false,product);
    };
    const linkedRows = reference ? s.all('SELECT quantity,value FROM movements WHERE doc=? AND product=? AND quantity<0 AND (?=0 OR batch=?)',reference.id,line.product,individual?1:0,batch) : [];
    const linkedQuantity = linkedRows.reduce((n,r)=>n-r.quantity,0);
    const documentCost=unitPrice(line)*100/1000/(line.data.unitFactor||1);
    const receiptCost=product.data.method!=='monthly'&&!individual&&movingSource==='document' ? documentCost : average||documentCost;
    const fallbackReturnCost=individual ? average||documentCost : product.data.method!=='monthly'&&movingSource==='document' ? documentCost : average;
    const returnCost = linkedQuantity ? Math.round(linkedRows.reduce((n,r)=>n-r.value,0)*quantity/linkedQuantity) : Math.round(fallbackReturnCost*quantity);
    const value = effect === 'in' && doc.type === 'salesReturn' || (doc.type==='exchange' && line.data.direction === 'return')
      ? returnCost : line.net;
    if (effect === 'transfer') {
      const moved = -out(quantity);
      adjustStock(s,doc,line,doc.target,quantity,moved,true,product);
    } else if (effect === 'out' || (effect==='exchange'&&(doc.type==='purchaseExchange'?line.data.direction==='return':line.data.direction!=='return'))) {
      cost -= out(quantity);
    } else if (['in','exchange'].includes(effect)) {
      cost -= adjustStock(s,doc,line,doc.warehouse,quantity,value,true,product);
    } else if (effect === 'count') {
      const difference = scaledQuantity(quantity-current.quantity);
      if (difference < 0) out(-difference);
      if (difference > 0) adjustStock(s,doc,line,doc.warehouse,difference,Math.round(receiptCost*difference),true,product);
    } else if (effect === 'revalue') {
      check(current.quantity > 0,'无库存可调价');
      adjustStock(s,doc,line,doc.warehouse,0,Math.round(current.quantity*documentCost)-current.value,true,product);
    }
  }
  return cost;
}
function ledger(s,doc,category,entity,amount,reference=null) {
  if (amount) s.run('INSERT INTO ledger(doc,date,category,entity,amount,reference) VALUES (?,?,?,?,?,?)',doc.id,doc.date,category,entity,amount,reference);
}
function checkLimit(condition,message) {
  if (!condition) throw Object.assign(new Error(message),{status:400,code:'DOCUMENT_LIMIT'});
}

function validateLinkedQuantities(s,doc,reference) {
  const {type}=doc;
  if (reference && ['purchase','sale','transfer','purchaseReturn','purchaseExchange','salesReturn','exchange'].includes(type)) {
    const candidates = ['salesReturn','exchange'].includes(type)?['salesReturn','exchange']:
      ['purchaseReturn','purchaseExchange'].includes(type)?['purchaseReturn','purchaseExchange']:[type];
    const consumed = s.all(`SELECT l.product,l.quantity,d.type,json_extract(l.data,'$.direction') direction
      FROM documents d JOIN lines l ON d.id=l.doc
      WHERE d.status IN ('posted','settled') AND json_extract(d.data,'$.reference')=?
      AND d.type IN (${candidates.map(()=>'?').join(',')})`,reference.id,...candidates);
    const available=new Map();
    for (const line of reference.lines) available.set(line.product,scaledQuantity((available.get(line.product)||0)+line.quantity));
    for (const line of [...consumed,...doc.lines.map(l=>({...l,type,direction:l.data.direction}))]) {
      if (['exchange','purchaseExchange'].includes(line.type)&&line.direction!=='return') continue;
      const remaining=scaledQuantity((available.get(line.product)||0)-line.quantity);
      checkLimit(remaining>=0,'本次及已处理数量超过关联单据数量');
      available.set(line.product,remaining);
    }
  }
}

function settlementBalance(s,doc,reference) {
  const category=doc.type==='receipt'?'ar':'ap';
  return reference?documentBalance(s,reference.id,doc.partner,category):
    s.one('SELECT COALESCE(SUM(amount),0) total FROM ledger WHERE category=? AND entity=?',category,doc.partner).total;
}

function validateDocumentLimits(s,doc,reference) {
  const {type,total,warehouse}=doc;
  if (['receipt','payment'].includes(type)) {
    const remaining=settlementBalance(s,doc,reference);
    checkLimit(remaining>=total,'结算金额超出未结金额（当前未结 ¥'+(remaining/100).toFixed(2)+'）');
  }
  if (['purchaseReturn','purchaseExchange','salesReturn','exchange'].includes(type)) validateLinkedQuantities(s,doc,reference);
  const effect=families[type][4];
  if (!['out','transfer','exchange'].includes(effect)) return;
  const running=new Map();
  const lots=new Map();
  // Match the posting order and stock direction without changing any inventory.
  const lines=type==='purchaseExchange'?[...doc.lines].sort((a,b)=>Number(b.data.direction==='return')-Number(a.data.direction==='return')):doc.lines;
  for (const line of lines) {
    const product=getMaster(s,line.product,'products');
    if (product.data.type==='service') continue;
    const outgoing=effect!=='exchange'||(type==='purchaseExchange'?line.data.direction==='return':line.data.direction!=='return');
    const delta=outgoing?-line.quantity:line.quantity;
    const remaining=running.get(line.product)??balance(s,line.product,warehouse).quantity;
    checkLimit(scaledQuantity(remaining+delta)>=0,product.name+'库存不足（当前可出库 '+remaining/1000+'）');
    running.set(line.product,scaledQuantity(remaining+delta));
    if (!product.data.batch||!line.data.batch) continue;
    const key=JSON.stringify([line.product,line.data.batch]);
    const lot=lots.get(key)??s.one('SELECT quantity FROM lots WHERE product=? AND warehouse=? AND batch=?',
      line.product,warehouse,line.data.batch)?.quantity??0;
    checkLimit(scaledQuantity(lot+delta)>=0,product.name+'批次库存不足（当前可出库 '+lot/1000+'）');
    lots.set(key,scaledQuantity(lot+delta));
  }
}

function post(s,user,doc) {
  openPeriod(s,doc.date);
  const [, , , ,effect] = families[doc.type];
  const {type,data,partner,total} = doc;
  const reference = data.reference ? getDocument(s,user,data.reference) : null;
  if (reference&&!posted.includes(reference.status)) {
    throw Object.assign(new Error(families[reference.type][0]+' '+reference.number+' 尚未记账。'),{
      status:409,code:'SOURCE_NOT_POSTED',documentId:reference.id
    });
  }
  if (reference&&orderFulfillment[reference.type]===type) {
    check(reference.execution.state!=='closed','关联订单已终止');
  }
  validateLinkedQuantities(s,doc,reference);
  const cost = stockEffects.includes(effect) ? stockPosting(s,doc,effect,reference) : 0;
  const entry = (category,entity,amount,ref) => ledger(s,doc,category,entity,amount,ref);
  const cash = (id,amount) => { if (amount) entry('cash',getMaster(s,id,'accounts').id,amount); };
  if (['purchase','purchaseReturn','purchaseExchange'].includes(type)) {
    const payable=type==='purchaseReturn'?-total:total;
    entry('ap',partner,payable,type==='purchase'||type==='purchaseExchange'&&payable>0?doc.id:reference?.id||null);
  }
  if (['sale','salesReturn','exchange','purchase'].includes(type)) {
    const sale = type !== 'purchase';
    const key = sale ? 'ar' : 'ap';
    const advanceKey = sale ? 'advanceIn' : 'advanceOut';
    if (sale) {
      const amount = type === 'salesReturn' ? -total : total;
      const tax = doc.lines.reduce((sum,line) => sum + (type === 'salesReturn' || (type === 'exchange' && line.data.direction === 'return') ? -1 : 1)*line.tax,0);
      entry(key,partner,amount,type==='sale' || (type==='exchange' && amount>0) ? doc.id : reference?.id || null);
      entry('sales',partner,amount-tax);
      entry('tax',partner,tax);
      entry('cogs',null,cost);
    }
    const receipts=data.receipts||[];
    const collected=receipts.reduce((sum,row)=>sum+row.amount,0);
    if (data.advance || data.paid || collected) {
      check(['sale','purchase'].includes(type) && data.advance+data.paid+collected<=total,'结算金额不得超过本单金额');
      if (data.advance) {
        const balance = s.one('SELECT COALESCE(SUM(amount),0) amount FROM ledger WHERE category=? AND entity=?',advanceKey,partner).amount;
        check(balance >= data.advance,'预收或预付余额不足');
        entry(advanceKey,partner,-data.advance);
      }
      cash(data.account,(sale ? 1 : -1)*data.paid);
      for (const item of receipts) cash(item.account,(sale?1:-1)*item.amount);
      entry(key,partner,-(data.advance+data.paid+collected),doc.id);
    }
  }
  if (['sale','purchase'].includes(type)) for (const row of data.saleExpenses||[]) {
    entry(type==='sale'?'salesFee':'expense',row.subject,row.amount,doc.id);
    entry('ap',row.partner,row.amount-row.paid,doc.id);
    cash(row.account,-row.paid);
  }
  if (type === 'receipt' || type === 'payment') {
    const receiving = type === 'receipt';
    const category = receiving ? 'ar' : 'ap';
    check(settlementBalance(s,doc,reference)>=total,'结算金额超出未结金额');
    entry(category,partner,-total,reference?.id || null);
    cash(data.account,receiving ? total : -total);
  }
  if (type === 'advanceIn' || type === 'advanceOut') {
    entry(type,partner,total);
    cash(data.account,type === 'advanceIn' ? total : -total);
  }
  if (type === 'cashTransfer') {
    check(Number(data.account)!==Number(data.targetAccount),'转入账户必须不同');
    cash(data.account,-total);
    cash(data.targetAccount,total);
  }
  if (['expense','income','deferred'].includes(type)) {
    entry(type,data.subject ? getMaster(s,data.subject,'expenses').id : null,total);
    cash(data.account,type==='income' ? total : -total);
  }
  if (type === 'openingStock') entry('openingInventory',null,-cost);
  if (type === 'openingAR') entry('ar',partner,total,doc.id);
  if (type === 'openingAP') entry('ap',partner,total,doc.id);
  if (type === 'openingCash') cash(data.account,total);
  if (effect === 'journal') for (const line of doc.lines) entry('journal',line.data.ledgerAccount,line.data.debit-line.data.credit);
  if (type === 'salesFee') {
    entry('salesFee',partner,total,reference?.id);
    cash(data.account,-total);
  }
  if (type === 'purchaseFee') {
    check(reference && doc.warehouse === reference.warehouse,'采购费用分摊请选择同仓已入库单据');
    const denominator = doc.lines.reduce((sum,line) => sum+line.quantity,0);
    check(denominator>0,'请按商品填写分摊数量');
    let allocated = 0;
    let cumulative = 0;
    for (const line of doc.lines) {
      check(reference.lines.some(r => r.product===line.product),'分摊商品不在关联入库单中');
      check(balance(s,line.product,doc.warehouse).quantity>=line.quantity,'剩余库存不足以分摊到当前库存');
      cumulative += line.quantity;
      const next = Math.round(total*cumulative/denominator);
      const product=getMaster(s,line.product,'products');
      if (product.data.method==='individual') {
        check(line.data.batch&&reference.lines.some(row=>row.product===line.product&&row.data.batch===line.data.batch),'请选择关联入库单中的批次');
        check(batchBalance(s,line.product,doc.warehouse,line.data.batch).quantity>=line.quantity,'批次剩余库存不足');
      }
      adjustStock(s,doc,line,doc.warehouse,0,next-allocated,true,product);
      allocated = next;
    }
    cash(data.account,-total);
  }
}
export function transition(s,user,id,action) {
  return s.tx(()=>changeDocumentStatus(s,user,id,action));
}

export function transitionDocuments(s,user,ids,action) {
  check(['submit','approve','unapprove','post','delete'].includes(action),'不支持此批量操作');
  return s.tx(()=>ids.map(id=>changeDocumentStatus(s,user,id,action)));
}

function changeDocumentStatus(s,user,id,action) {
  const doc = getDocument(s,user,id);
  check(permits(user,'d:'+doc.type,action),'没有此操作权限',403);
  if (['delete','restore','submit','approve','unapprove','reject','stop'].includes(action)) openPeriod(s,doc.date);
  const next = transitions[doc.status]?.[action];
  check(typeof next === 'string','当前状态无法执行该操作',409);
  if (action==='approve') validateDocumentLimits(s,doc,doc.data.reference?getDocument(s,user,doc.data.reference):null);
  if (action === 'post') {
    post(s,user,doc);
    generateJournal(s,doc);
  }
  if (action === 'settle' && ['purchase','purchaseExchange','sale','exchange','openingAR','openingAP'].includes(doc.type)) {
    check(s.one('SELECT COALESCE(SUM(amount),0) total FROM ledger WHERE reference=? AND category IN (\'ar\',\'ap\')',doc.id).total === 0,'本单还有未结金额');
  }
  s.run('UPDATE documents SET status=? WHERE id=?',next,doc.id);
  log(s,user,action,doc.number);
  return getDocument(s,user,id);
}
export function closeMonth(s,user,month) {
  check(user.role==='admin','只有管理员可以月结',403);
  check(getSystemSettings(s).manualClose,'请先在系统配置中启用手工月结存');
  check(/^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month < today().slice(0,7),'只能月结已结束的月份');
  return s.tx(() => {
    openPeriod(s,month+'-01');
    check(!s.one("SELECT id FROM documents WHERE substr(date,1,7)<=? AND status IN ('draft','pending','approved','rejected')",month),'请先处理本期及以前未记账的单据');
    const nextOpen = s.one(`SELECT MIN(substr(date,1,7)) month FROM movements
      WHERE substr(date,1,7)>COALESCE((SELECT MAX(month) FROM closes),'')`).month;
    check(!nextOpen || nextOpen>=month,'请先结存更早的库存期间');
    const monthRows = s.all('SELECT * FROM movements WHERE substr(date,1,7)=? ORDER BY id',month);
    const pairs = new Map();
    for (const row of monthRows) {
      const key = row.product+':'+row.warehouse;
      if (!pairs.has(key)) pairs.set(key,[]);
      pairs.get(key).push(row);
    }
    for (const rows of pairs.values()) {
      if (!rows.some(r => r.cost_method==='monthly' && r.quantity<0)) continue;
      const {product,warehouse} = rows[0];
      check(rows.every(r=>r.cost_method==='monthly'),'同商品本期切换过成本算法，需先核对成本');
      check(!s.one('SELECT id FROM movements WHERE product=? AND warehouse=? AND substr(date,1,7)>? LIMIT 1',product,warehouse,month),'存在跨期后续库存流水，请先核对后续期间');
      check(!s.one(`SELECT m.id FROM movements m JOIN documents d ON d.id=m.doc
        WHERE m.product=? AND m.warehouse=? AND substr(m.date,1,7)=? AND d.type IN ('transfer','salesReturn','exchange','purchaseExchange') LIMIT 1`,product,warehouse,month),
      '含调拨或销售退换货的全月加权商品需要人工核对');
      const previous = s.one('SELECT COALESCE(SUM(quantity),0) quantity,COALESCE(SUM(value),0) value FROM movements WHERE product=? AND warehouse=? AND substr(date,1,7)<?',product,warehouse,month);
      const incoming = rows.filter(r=>r.incoming);
      const units = scaledQuantity(previous.quantity+incoming.reduce((n,r)=>n+r.quantity,0));
      const amount = previous.value+incoming.reduce((n,r)=>n+r.value,0);
      check(units>0 && amount>=0,'全月成本基数无效');
      let outgoing = 0;
      let valuation = 0;
      let change = 0;
      for (const row of rows.filter(r=>r.quantity<0)) {
        outgoing = scaledQuantity(outgoing-row.quantity);
        const resulting = Math.round(amount*outgoing/units);
        const value = valuation-resulting;
        valuation = resulting;
        const difference = value-row.value;
        s.run('UPDATE movements SET value=? WHERE id=?',value,row.id);
        change += difference;
        const doc = s.one('SELECT * FROM documents WHERE id=?',row.doc);
        if (doc.type==='sale') ledger(s,doc,'cogs',null,-difference);
        adjustJournalForClosing(s,doc,difference);
      }
      s.run('UPDATE stock SET value=value+? WHERE product=? AND warehouse=?',change,product,warehouse);
    }
    s.run('INSERT INTO closes(month,user_id) VALUES (?,?)',month,user.id);
    log(s,user,'月结存',month);
    return {month};
  });
}
