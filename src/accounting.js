export const standardAccounts = {
  cash:['1000','现金银行','asset'], ar:['1122','应收账款','asset'],
  advanceOut:['1123','预付账款','asset'], inventory:['1405','库存商品','asset'],
  deferred:['1801','待摊费用','asset'], ap:['2202','应付账款','liability'],
  advanceIn:['2203','预收账款','liability'], tax:['2221','应交税费','liability'],
  opening:['3100','期初权益','equity'], sales:['6001','主营业务收入','income'],
  income:['6051','其他业务收入','income'], cogs:['6401','主营业务成本','expense'],
  salesFee:['6601','销售费用','expense'], expense:['6602','费用支出','expense'],
  discount:['6603','优惠','expense'], gain:['6711','存货调整损益','expense']
};
const creditNormal = new Set(['ap','advanceIn','tax','sales','income']);
const inventoryOpening = new Set(['openingStock','openingAR','openingAP','openingCash']);
const standardCategories = Object.keys(standardAccounts);

function addAutomatic(s,doc,date,kind,net,entity=null) {
  if (net===0) return;
  const [code,name,category]=standardAccounts[kind];
  s.run(`INSERT INTO journal_entries(doc,date,code,name,category,entity,amount)
    VALUES (?,?,?,?,?,?,?)`,doc,date,code,name,category,entity,net);
}
export function generateJournal(s,doc) {
  const raw=s.all('SELECT category,entity,amount FROM ledger WHERE doc=?',doc.id);
  if (['voucher','openingBalance'].includes(doc.type)) {
    for (const row of raw) {
      const account=s.one('SELECT id,code,name,data FROM master WHERE id=?',row.entity);
      const category=JSON.parse(account.data).category;
      s.run(`INSERT INTO journal_entries(doc,date,code,name,category,entity,amount)
        VALUES (?,?,?,?,?,?,?)`,doc.id,doc.date,account.code,account.name,category||'other',account.id,row.amount);
    }
    if (doc.type==='openingBalance'&&doc.data?.openingManaged) {
      const amount=raw.reduce((sum,row)=>sum+row.amount,0);
      addAutomatic(s,doc.id,doc.date,'opening',-amount);
    }
    return;
  }
  let balance=0;
  for (const row of raw) {
    if (!standardCategories.includes(row.category)) continue;
    if (row.category==='discount') {
      const purchase=doc.type.startsWith('purchase');
      const direction=doc.type.endsWith('Return')?-1:1;
      const amount=row.amount*direction;
      addAutomatic(s,doc.id,doc.date,'discount',purchase?-amount:amount,row.entity);
      addAutomatic(s,doc.id,doc.date,purchase?'expense':'sales',purchase?amount:-amount);
      continue;
    }
    const amount=creditNormal.has(row.category)?-row.amount:row.amount;
    addAutomatic(s,doc.id,doc.date,row.category,amount,row.entity);
    balance+=amount;
  }
  const inventory=s.one('SELECT COALESCE(SUM(value),0) amount FROM movements WHERE doc=?',doc.id).amount;
  addAutomatic(s,doc.id,doc.date,'inventory',inventory);
  balance+=inventory;
  if (['purchase','purchaseReturn','purchaseExchange'].includes(doc.type)) {
    const tax=doc.lines.reduce((total,line)=>total+line.tax*(doc.type==='purchaseReturn'||line.data.direction==='return'?-1:1),0);
    addAutomatic(s,doc.id,doc.date,'tax',tax);
    balance+=tax;
  }
  if (balance) addAutomatic(s,doc.id,doc.date,inventoryOpening.has(doc.type)?'opening':doc.type==='purchase'?'expense':'gain',-balance);
}
export function adjustJournalForClosing(s,doc,difference) {
  if (!difference) return;
  addAutomatic(s,doc.id,doc.date,'inventory',difference);
  addAutomatic(s,doc.id,doc.date,doc.type==='sale'?'cogs':'gain',-difference);
}

export function repairOpeningEquity(s) {
  const docs=s.all("SELECT d.id,d.date,SUM(j.amount) amount FROM documents d JOIN journal_entries j ON j.doc=d.id WHERE d.type='openingBalance' AND json_extract(d.data,'$.openingManaged')=1 GROUP BY d.id HAVING SUM(j.amount)<>0");
  s.tx(()=>{
    for (const doc of docs) {
      addAutomatic(s,doc.id,doc.date,'opening',-doc.amount);
      s.run("INSERT INTO audit(user_id,action,detail) VALUES(NULL,'修复期初权益',?)",String(doc.id));
    }
  });
}
