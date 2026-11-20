import {check,number,cents,qty,today,log,parse} from './engine.js';
import {assertOpeningEditable,openingState} from './opening-state.js';
import {generateJournal} from './accounting.js';

const kinds={stock:'products',partners:'partners',accounts:'accounts'};
const openingFilter="d.type LIKE 'opening%'";
const protectedCodes=new Set(['1000','1122','1123','1405','2202','2203']);
const labels={stock:'期初库存商品',partners:'期初应收应付',accounts:'期初收支账户'};
const sums=s=>Object.fromEntries(s.all(`SELECT category,SUM(amount) amount FROM ledger l JOIN documents d ON d.id=l.doc
  WHERE ${openingFilter} GROUP BY category`).map(row=>[row.category,row.amount]));
function authorize(user) {check(user.role==='admin','只有管理员可以维护期初建账',403);}
function bump(s) {s.run('UPDATE opening_state SET revision=revision+1 WHERE id=1');}
function editable(s,user,input) {
  authorize(user);
  assertOpeningEditable(s);
  check(input.revision===openingState(s)?.revision,'期初数据已变更，请刷新后重试',409);
}
function record(s,user,type,warehouse,partner,account) {
  const date=openingState(s).date;
  const seq=s.one(`INSERT INTO sequences VALUES ('QCJ',?,1) ON CONFLICT(prefix,date)
    DO UPDATE SET value=value+1 RETURNING value`,date).value;
  const data={openingManaged:true,account,summary:'期初建账',revision:1};
  const id=Number(s.run(`INSERT INTO documents(number,type,date,status,warehouse,partner,department,creator,total,data)
    VALUES (?,?,?,'posted',?,?, '',?,0,?)`,'QCJ-'+date.replaceAll('-','')+'-'+seq,type,date,warehouse,partner,user.id,JSON.stringify(data)).lastInsertRowid);
  return {id,date,type,data,warehouse,partner};
}
function entry(s,doc,category,entity,amount,reference=null) {
  if (amount) s.run('INSERT INTO ledger(doc,date,category,entity,amount,reference) VALUES(?,?,?,?,?,?)',doc.id,doc.date,category,entity,amount,reference);
}
export function openingBalanceSheet(s) {
  const balances=sums(s);
  const stock=s.one(`SELECT COALESCE(SUM(value),0) amount FROM movements m JOIN documents d ON d.id=m.doc WHERE ${openingFilter}`).amount;
  const automatic={'1000':balances.cash||0,'1122':balances.ar||0,'1123':balances.advanceOut||0,
    '1405':stock,'2202':balances.ap||0,'2203':balances.advanceIn||0};
  const rows=s.all(`SELECT m.id,m.code,m.name,m.data,COALESCE((SELECT SUM(l.amount) FROM ledger l JOIN documents d ON d.id=l.doc WHERE d.type='openingBalance' AND l.category='journal' AND l.entity=m.id)*
      CASE WHEN json_extract(m.data,'$.category') IN ('liability','equity') THEN -1 ELSE 1 END,0) amount
    FROM master m WHERE m.kind='ledgerAccounts' ORDER BY m.code`)
    .map(row=>({...row,category:parse(row.data).category,automatic:protectedCodes.has(row.code),amount:automatic[row.code]??row.amount}));
  const totals={asset:0,liability:0,equity:0};
  for (const row of rows) if (Object.hasOwn(totals,row.category)) totals[row.category]+=row.amount;
  totals.difference=totals.asset-totals.liability-totals.equity;
  return {rows:rows.filter(row=>Object.hasOwn(totals,row.category)),totals,balanced:totals.difference===0};
}
export function openingData(s,user,kind,warehouse) {
  authorize(user);
  const state=openingState(s);
  const sheet=openingBalanceSheet(s);
  const warehouses=s.all("SELECT id,code,name FROM master WHERE kind='warehouses' ORDER BY code");
  if (!Object.hasOwn(kinds,kind)) return {state,...sheet,warehouses};
  const rows=s.all('SELECT id,code,name,active,data FROM master WHERE kind=? ORDER BY code',kinds[kind]).map(row=>({...row,data:parse(row.data)}));
  if (kind==='stock') {
    check(!warehouse||warehouses.some(row=>row.id===Number(warehouse)),'请选择有效仓库');
    const balances=new Map(s.all(`SELECT product,SUM(quantity) quantity,SUM(value) amount FROM movements m JOIN documents d ON d.id=m.doc
      WHERE ${openingFilter} AND m.warehouse=? GROUP BY product`,Number(warehouse)||0).map(row=>[row.product,row]));
    for (const row of rows) {
      const balance=balances.get(row.id)||{quantity:0,amount:0};
      const batches=s.all('SELECT batch,quantity FROM lots WHERE product=? AND warehouse=? ORDER BY batch',row.id,Number(warehouse)||0).filter(lot=>lot.quantity);
      const recent=s.one("SELECT l.data FROM lines l JOIN documents d ON d.id=l.doc WHERE l.product=? AND d.warehouse=? AND d.type='openingStock' ORDER BY d.id DESC LIMIT 1",row.id,Number(warehouse)||0);
      const metadata=recent?parse(recent.data):{};
      Object.assign(row,{production:metadata.production||'',quantity:balance.quantity/1000,amount:balance.amount,price:balance.quantity?balance.amount/100/(balance.quantity/1000):0,
        batch:batches.length===1?batches[0].batch:''});
    }
  } else {
    const categories=kind==='accounts'?['cash']:['ar','ap','advanceIn','advanceOut'];
    const balances=new Map(s.all(`SELECT entity,category,SUM(amount) amount FROM ledger l JOIN documents d ON d.id=l.doc
      WHERE ${openingFilter} GROUP BY entity,category`).map(row=>[row.entity+'|'+row.category,row.amount]));
    for (const row of rows) for (const key of categories) row[key]=balances.get(row.id+'|'+key)||0;
  }
  return {state,rows,warehouses};
}
function stockRows(s,user,input) {
  const warehouse=Number(input.warehouse);
  check(s.one("SELECT id FROM master WHERE kind='warehouses' AND id=?",warehouse),'请先选择仓库');
  check(Array.isArray(input.rows)&&input.rows.length<=10000,'期初明细无效');
  const seen=new Set();
  // Validate every row before making changes.
  const rows=input.rows.map((row,index)=>{
    try {
      const product=s.one("SELECT * FROM master WHERE kind='products' AND id=?",Number(row.id));
      check(product,'商品不存在');
      check(!seen.has(product.id),'商品重复，请合并后录入');
      seen.add(product.id);
      const data=parse(product.data);
      const quantity=qty(row.quantity,4);
      check(data.type!=='service'||!quantity,'服务商品不能录入期初库存');
      const price=number(row.price);
      const before=s.one('SELECT quantity,value FROM stock WHERE product=? AND warehouse=?',product.id,warehouse)||{quantity:0,value:0};
      check(!data.serial||quantity===before.quantity&&Math.round(quantity/1000*price*100)===before.value,'序列号商品请使用期初录入单并填写序列号');
      const batch=String(row.batch||'').trim();
      check(!data.batch&&!['individual'].includes(data.method)||!quantity||batch,'批次商品请填写批号');
      const production=String(row.production||'');
      check(!production||/^\d{4}-\d{2}-\d{2}$/.test(production)&&!isNaN(Date.parse(production)),'生产日期无效');
      return {product,data,quantity,price,batch,production,amount:Math.round(quantity/1000*price*100)};
    } catch (error) {throw Object.assign(new Error('第 '+(row.excelRow??index+1)+' 行：'+error.message),{status:400});}
  });
  for (const row of rows) {
    const before=s.one('SELECT quantity,value FROM stock WHERE product=? AND warehouse=?',row.product.id,warehouse)||{quantity:0,value:0};
    const quantity=row.quantity-before.quantity,value=row.amount-before.value;
    const batchManaged=row.data.batch||row.data.method==='individual';
    const batches=batchManaged?s.all('SELECT batch,SUM(quantity) quantity,SUM(value) value FROM movements WHERE product=? AND warehouse=? GROUP BY batch',
      row.product.id,warehouse):[];
    const oldBatch=batches.find(batch=>batch.batch===row.batch)||{quantity:0,value:0};
    const prior=s.one('SELECT l.data FROM lines l JOIN documents d ON d.id=l.doc WHERE l.product=? AND d.warehouse=? ORDER BY d.id DESC,l.position DESC LIMIT 1',row.product.id,warehouse);
    const previous=prior?parse(prior.data):{};
    if (!quantity&&!value&&(!batchManaged||oldBatch.quantity===row.quantity&&oldBatch.value===row.amount)&&
        (previous.production||'')===row.production) continue;
    const doc=record(s,user,'openingStock',warehouse,null,null);
    const lineData={unit:row.data.unit||'',enteredQuantity:quantity,unitPrice:row.price,discount:1,tax:0,
      batch:row.batch,production:row.production,expiry:'',serials:[]};
    s.run('INSERT INTO lines VALUES (?,?,?,?,?,?,0,?)',doc.id,1,row.product.id,quantity,Math.round(row.price*100),value,JSON.stringify(lineData));
    s.run('UPDATE documents SET total=? WHERE id=?',value,doc.id);
    s.run(`INSERT INTO stock VALUES(?,?,?,?) ON CONFLICT(product,warehouse)
      DO UPDATE SET quantity=excluded.quantity,value=excluded.value`,row.product.id,warehouse,row.quantity,row.amount);
    s.run(`INSERT INTO movements(doc,position,date,product,warehouse,quantity,value,incoming,cost_method,batch,expiry,serials)
      VALUES(?,1,?,?,?,?,?,1,?,?,'','[]')`,doc.id,doc.date,row.product.id,warehouse,batchManaged?row.quantity-oldBatch.quantity:quantity,batchManaged?row.amount-oldBatch.value:value,row.data.method||'moving',row.batch);
    if (row.data.batch||row.data.method==='individual') {
      // The warehouse editor replaces all opening batches of this product as one batch.
      for (const lot of batches) {
        if (lot.batch===row.batch) continue;
        if (lot.quantity||lot.value) s.run(`INSERT INTO movements(doc,position,date,product,warehouse,quantity,value,incoming,cost_method,batch,expiry,serials)
          VALUES(?,1,?,?,?, ?,?,1,?,?,'','[]')`,doc.id,doc.date,row.product.id,warehouse,-lot.quantity,-lot.value,row.data.method||'moving',lot.batch);
      }
      s.run('DELETE FROM lots WHERE product=? AND warehouse=?',row.product.id,warehouse);
      if (row.quantity) s.run('INSERT INTO lots VALUES(?,?,?,\'\',?)',row.product.id,warehouse,row.batch,row.quantity);
    }
    generateJournal(s,doc);
  }
}
function manualBalance(s,user,account,amount) {
  const previous=openingBalanceSheet(s).rows.find(row=>row.id===account.id)?.amount||0;
  s.run('INSERT INTO opening_manual VALUES(?,?) ON CONFLICT(account) DO UPDATE SET amount=excluded.amount',account.id,amount);
  const delta=amount-previous;
  if (!delta) return;
  const doc=record(s,user,'openingBalance',null,null,null);
  entry(s,doc,'journal',account.id,delta*(account.category==='asset'?1:-1));
  generateJournal(s,doc);
}
export function saveOpening(s,user,kind,input,{withinTransaction=false}={}) {
  const action=()=>{
    editable(s,user,input);
    if (kind==='stock') stockRows(s,user,input);
    else if (kind==='partners'||kind==='accounts') {
      check(Array.isArray(input.rows)&&input.rows.length<=10000,'期初明细无效');
      const current=new Map(openingData(s,user,kind).rows.map(row=>[row.id,row]));
      const seen=new Set();
      for (const [index,row] of input.rows.entries()) {
        const before=current.get(Number(row.id));
        check(before&&!seen.has(before.id),'第 '+(index+1)+' 行：资料不存在或重复');
        seen.add(before.id);
        const keys=kind==='accounts'?['cash']:['ar','ap','advanceIn','advanceOut'];
        const amounts=Object.fromEntries(keys.map(key=>[key,kind==='accounts'?Math.round(number(Math.abs(Number(row[key]||0)))*100)*Math.sign(Number(row[key]||0)):cents(row[key])]));
        if (kind==='partners') {
          check(!(amounts.ar&&amounts.ap),'第 '+(index+1)+' 行：同一单位不能同时填应收和应付');
          check(!(amounts.advanceIn&&amounts.advanceOut),'第 '+(index+1)+' 行：同一单位不能同时填预收和预付');
        }
        for (const key of keys) {
          const delta=amounts[key]-before[key];
          if (!delta) continue;
          const type=key==='cash'?'openingCash':key==='ap'||key==='advanceOut'?'openingAP':'openingAR';
          const doc=record(s,user,type,null,kind==='partners'?before.id:null,kind==='accounts'?before.id:null);
          s.run('UPDATE documents SET total=? WHERE id=?',delta,doc.id);
          entry(s,doc,key,before.id,delta,doc.id);
          generateJournal(s,doc);
        }
      }
    } else if (kind==='balance') {
      check(Array.isArray(input.rows),'科目余额无效');
      const sheet=new Map(openingBalanceSheet(s).rows.map(row=>[row.id,row]));
      for (const row of input.rows) {
        const account=sheet.get(Number(row.id));
        check(account&&!account.automatic,'自动汇总科目不能手工修改');
        const value=Number(row.amount||0);
        check(Number.isFinite(value)&&Math.abs(value)<=1e8,'科目余额无效');
        manualBalance(s,user,account,Math.round(value*100));
      }
    } else check(false,'无效期初类型');
    bump(s);
    log(s,user,'保存期初',labels[kind]||'期初资产负债表');
    return openingData(s,user,kind,input.warehouse);
  };
  return withinTransaction?action():s.tx(action);
}
export function changeOpening(s,user,input) {
  return s.tx(()=>{
    authorize(user);
    const state=openingState(s);
    check(input.revision===state.revision,'建账状态已变更，请刷新重试',409);
    check(['open','close'].includes(input.action),'无效开账操作');
    if (input.action==='close') {
      check(state.opened,'系统尚未开账');
      check(!s.one("SELECT id FROM documents WHERE type NOT LIKE 'opening%' AND status IN ('posted','settled') LIMIT 1"),
        '已有已记账业务单据，不能反开账',409);
      s.run('UPDATE opening_state SET opened=0,revision=revision+1 WHERE id=1');
      log(s,user,'反开账',state.date);
    } else {
      assertOpeningEditable(s);
      check(!s.one("SELECT id FROM documents WHERE type LIKE 'opening%' AND status NOT IN ('posted','settled','deleted','stopped') LIMIT 1"),
        '存在未记账的期初录入单，请先记账或删除');
      const date=String(input.date||state.date);
      check(/^\d{4}-\d{2}-\d{2}$/.test(date)&&!isNaN(Date.parse(date))&&date<=today(),'请输入不晚于今天的有效建账日期');
      const sheet=openingBalanceSheet(s);
      if (!sheet.balanced&&input.autoCapital) {
        let capital=s.one("SELECT id FROM master WHERE kind='ledgerAccounts' AND code='4001'");
        if (!capital) capital={id:Number(s.run("INSERT INTO master(kind,code,name,data) VALUES('ledgerAccounts','4001','实收资本',?)",JSON.stringify({category:'equity'})).lastInsertRowid)};
        const previous=openingBalanceSheet(s).rows.find(row=>row.id===capital.id)?.amount||0;
        manualBalance(s,user,{...capital,category:'equity'},previous+sheet.totals.difference);
      }
      check(openingBalanceSheet(s).balanced,'期初资产负债表不平衡，差额 ¥'+(sheet.totals.difference/100).toFixed(2));
      // Opening is always before the first period in statement reporting.
      s.run("UPDATE documents SET date=? WHERE type LIKE 'opening%'",date);
      for (const table of ['ledger','movements','journal_entries'])
        s.run("UPDATE "+table+" SET date=? WHERE doc IN (SELECT id FROM documents WHERE type LIKE 'opening%')",date);
      s.run('UPDATE opening_state SET opened=1,date=?,revision=revision+1 WHERE id=1',date);
      log(s,user,'开账',date);
    }
    return openingData(s,user,'balance');
  });
}
export function migrateOpening(s) {
  // Remove only the identified zero-value demo entry when it has no nonzero effects or references.
  const row=s.one("SELECT id FROM documents WHERE number='QZ-20261114-00001' AND total=0 AND type='openingCash'");
  if (!row) return;
  const used=s.one("SELECT id FROM documents WHERE json_extract(data,'$.reference')=? LIMIT 1",row.id);
  const nonzero=s.one('SELECT id FROM ledger WHERE doc=? AND amount<>0 LIMIT 1',row.id);
  if (used||nonzero||s.one('SELECT id FROM journal_entries WHERE doc=? AND amount<>0 LIMIT 1',row.id)) return;
  s.tx(()=>{
    for (const table of ['attachments','journal_entries','ledger','movements','lines']) s.run('DELETE FROM '+table+' WHERE doc=?',row.id);
    s.run('DELETE FROM documents WHERE id=?',row.id);
  });
}
