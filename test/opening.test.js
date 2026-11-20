import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.js';
import {saveDocument,transition,getDocument,today} from '../src/engine.js';
import {openingData,saveOpening,changeOpening,openingBalanceSheet} from '../src/opening.js';
import {openingState} from '../src/opening-state.js';
import {report} from '../src/reports.js';
import {xlsx} from '../src/xlsx.js';
import {readWorkbookRows} from '../src/xlsx-import.js';

const password='Opening-Tests-2026';
function request(server,url,{data,cookie}={}) {
  const req=Readable.from(data===undefined?[]:[Buffer.from(JSON.stringify(data))]);
  Object.assign(req,{url,method:data===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},socket:{remoteAddress:'test'}});
  return new Promise(resolve=>{
    const headers={};
    const response={headersSent:false,status:200,
      setHeader:(key,value)=>{headers[key.toLowerCase()]=value;},
      writeHead:(status,items)=>{response.status=status;response.headersSent=true;for (const [key,value] of Object.entries(items)) response.setHeader(key,value);},
      end:raw=>resolve({status:response.status,headers,raw,json:()=>JSON.parse(raw)})};
    server.emit('request',req,response);
  });
}
function fixture(t) {
  const {server,store:s}=createApp({password,demo:true});
  t.after(()=>s.db.close());
  const user=s.one("SELECT * FROM users WHERE role='admin'");
  const id=code=>s.one('SELECT id FROM master WHERE code=?',code).id;
  const save=(kind,rows,extra={})=>saveOpening(s,user,kind,{revision:openingState(s).revision,rows,...extra});
  const control=(action,extra={})=>changeOpening(s,user,{revision:openingState(s).revision,action,...extra});
  const doc=(type,extra={})=>saveDocument(s,user,{type,warehouse:id('WH-01'),...extra});
  const post=doc=>['submit','approve','post'].reduce((doc,action)=>transition(s,user,doc.id,action),doc);
  return {server,s,user,id,save,control,doc,post};
}
test('未开账业务只能保存草稿，期初覆盖录入立即影响库存与往来，开账后锁定',t=>{
  const {s,user,id,save,control,doc,post}=fixture(t);
  assert.equal(openingState(s).opened,false);
  const draft=doc('purchase',{partner:id('S-001'),lines:[{product:id('P-1001'),quantity:1,price:20}]});
  for (const action of ['submit','approve','post']) assert.throws(()=>transition(s,user,draft.id,action),/系统尚未开账/);
  save('stock',[{id:id('P-1001'),quantity:10,price:20}],{warehouse:id('WH-01')});
  const stock=s.one('SELECT quantity,value FROM stock WHERE product=? AND warehouse=?',id('P-1001'),id('WH-01'));
  assert.deepEqual({...stock},{quantity:10000,value:20000});
  assert.equal(openingData(s,user,'stock',id('WH-01')).rows.find(row=>row.id===id('P-1001')).price,20);
  const inventory=report(s,user,'库存状况查询',{warehouse:id('WH-01')});
  assert.ok(inventory.rows.some(row=>row[0]==='P-1001'&&row.includes('200.00')));
  save('stock',[{id:id('P-1001'),quantity:8,price:25}],{warehouse:id('WH-01')});
  assert.deepEqual({...s.one('SELECT quantity,value FROM stock WHERE product=? AND warehouse=?',id('P-1001'),id('WH-01'))},{quantity:8000,value:20000});
  save('partners',[{id:id('C-001'),ar:300},{id:id('S-001'),ap:500}]);
  const balances=report(s,user,'往来单位应收应付',{});
  assert.equal(balances.rows.find(row=>row[0]==='晨光社区门店')[1],'300.00');
  assert.equal(balances.summary.rows.find(row=>row[0]==='青禾日用品供应商')[2],'500.00');
  const statement=report(s,user,'对账',{from:today(),partner:id('C-001')});
  assert.deepEqual(statement.summary.rows.find(row=>row[1]==='应收').slice(2),['300.00','0.00','0.00','300.00']);
  save('accounts',[{id:id('A-01'),cash:50}]);
  assert.equal(openingBalanceSheet(s).totals.difference,5000);
  assert.throws(()=>control('open'),/差额 ¥50.00/);
  control('open',{autoCapital:true});
  assert.equal(openingState(s).opened,true);
  assert.equal(openingBalanceSheet(s).balanced,true);
  assert.equal(openingBalanceSheet(s).rows.find(row=>row.code==='4001').amount,5000);
  assert.throws(()=>save('stock',[{id:id('P-1001'),quantity:99,price:1}],{warehouse:id('WH-01')}),/期初数据只读/);
  assert.throws(()=>doc('openingCash',{data:{account:id('A-01'),amount:1}}),/期初数据只读/);
  control('close');
  assert.equal(openingState(s).opened,false);
  control('open');
  post(draft);
  assert.throws(()=>control('close'),/已有已记账业务单据/);
  assert.equal(s.one("SELECT COUNT(*) count FROM audit WHERE action IN ('开账','反开账')").count,3);
});
test('期初手工科目与预收预付平衡校验，互斥、并发和权限限制',t=>{
  const {s,user,id,save}=fixture(t);
  const stale=openingState(s).revision;
  assert.throws(()=>save('partners',[{id:id('C-001'),ar:1,ap:1}]),/不能同时填应收和应付/);
  assert.throws(()=>save('partners',[{id:id('C-001'),advanceIn:1,advanceOut:1}]),/不能同时填预收和预付/);
  save('partners',[{id:id('C-001'),advanceIn:100},{id:id('S-001'),advanceOut:200}]);
  const sheet=openingBalanceSheet(s);
  assert.equal(sheet.totals.asset,20000);
  assert.equal(sheet.totals.liability,10000);
  assert.throws(()=>saveOpening(s,user,'accounts',{revision:stale,rows:[]}),/已变更/);
  assert.throws(()=>saveOpening(s,{...user,role:'clerk'},'accounts',{revision:openingState(s).revision,rows:[]}),/只有管理员/);
  const asset=sheet.rows.find(row=>row.code==='1405');
  assert.throws(()=>save('balance',[{id:asset.id,amount:1}]),/自动汇总科目/);
  const capital=Number(s.run("INSERT INTO master(kind,code,name,data) VALUES('ledgerAccounts','4001','实收资本',?)",JSON.stringify({category:'equity'})).lastInsertRowid);
  save('balance',[{id:capital,amount:100}]);
  assert.equal(openingBalanceSheet(s).balanced,true);
});
test('期初 Excel 模板、跨仓导入原子性、错误行和往来资料内录入',async t=>{
  const {server,s,user,id,save,control}=fixture(t);
  const login=await request(server,'/api/login',{data:{username:'admin',password}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const call=(path,data)=>request(server,path,{cookie,data});
  const template=await call('/api/opening/template?kind=stock');
  assert.deepEqual(readWorkbookRows(template.raw,10)[0],['商品编号','仓库','数量','成本单价','批号','生产日期']);
  const workbook=xlsx(['商品编号','仓库','数量','成本单价'],[
    ['P-1001','WH-01',10,20],['NO-SUCH','WH-02',1,2],['P-1002','WH-02',-1,2]
  ]).toString('base64');
  const failed=await call('/api/opening/import',{kind:'stock',workbook,revision:openingState(s).revision});
  assert.equal(failed.status,400);
  assert.match(failed.json().message,/第 3 行/);
  assert.match(failed.json().message,/第 4 行/);
  assert.equal(s.one('SELECT COUNT(*) count FROM stock').count,0);
  const valid=xlsx(['商品编号','仓库','数量','成本单价'],[['P-1001','WH-01',10,20],['P-1002','WH-02',2,3]]).toString('base64');
  const result=await call('/api/opening/import',{kind:'stock',workbook:valid,revision:openingState(s).revision});
  assert.equal(result.status,200);
  assert.equal(result.json().count,2);
  const revision=openingState(s).revision;
  const invalidSecondWarehouse=xlsx(['商品编号','仓库','数量','成本单价'],
    [['P-1001','WH-01',9,20],['P-1002','WH-02',1,1000000000]]).toString('base64');
  assert.equal((await call('/api/opening/import',{kind:'stock',workbook:invalidSecondWarehouse,revision})).status,400);
  assert.equal(openingState(s).revision,revision);
  assert.equal(s.one('SELECT quantity FROM stock WHERE product=? AND warehouse=?',id('P-1001'),id('WH-01')).quantity,10000);
  const partner=s.one("SELECT * FROM master WHERE code='C-001'");
  const changed=await call('/api/master/partners',{id:partner.id,code:partner.code,name:partner.name,data:JSON.parse(partner.data),
    openingRevision:openingState(s).revision,openingBalances:{ar:300}});
  assert.equal(changed.status,200);
  assert.equal(openingData(s,user,'partners').rows.find(row=>row.id===partner.id).ar,30000);
  const partnerSheet=xlsx(['单位编号','期初应收','期初应付','期初预收','期初预付'],[['S-001',0,500,0,0]]).toString('base64');
  assert.equal((await call('/api/opening/import',{kind:'partners',workbook:partnerSheet,revision:openingState(s).revision})).status,200);
  save('accounts',[{id:id('A-01'),cash:100}]);
  const accounts=(await call('/api/master/accounts')).json().rows;
  assert.equal(accounts.find(row=>row.id===id('A-01')).openingBalance,10000);
  assert.equal(accounts.find(row=>row.id===id('A-01')).balance,10000);
  control('open',{autoCapital:true});
  const blocked=await call('/api/master/partners',{id:partner.id,code:partner.code,name:'不应保存',data:JSON.parse(partner.data),
    openingRevision:openingState(s).revision,openingBalances:{ar:9}});
  assert.equal(blocked.status,409);
  assert.equal(s.one('SELECT name FROM master WHERE id=?',partner.id).name,partner.name);
});
test('期初录入单允许负数冲减并保留初始成本，开账后阻止所有状态变更',t=>{
  const {s,user,id,save,doc,post,control}=fixture(t);
  save('stock',[{id:id('P-1001'),quantity:10,price:20}],{warehouse:id('WH-01')});
  const decrease=post(doc('openingStock',{data:{discount:0.5,freight:100,reduction:50},lines:[{product:id('P-1001'),quantity:-2,price:20}]}));
  assert.equal(decrease.total,-4000);
  assert.deepEqual({...s.one('SELECT quantity,value FROM stock WHERE product=? AND warehouse=?',id('P-1001'),id('WH-01'))},{quantity:8000,value:16000});
  const draft=doc('openingStock',{lines:[{product:id('P-1001'),quantity:1,price:20}]});
  assert.throws(()=>control('open',{autoCapital:true}),/未记账的期初/);
  transition(s,user,draft.id,'delete');
  control('open',{autoCapital:true});
  for (const action of ['unapprove','delete','restore','post']) assert.throws(()=>transition(s,user,draft.id,action),/期初数据只读/);
  assert.equal(getDocument(s,user,decrease.id).openingReadOnly,true);
});
test('存量业务账套自动视为已开账，并清理指定零额期初演示单',t=>{
  const directory=mkdtempSync(join(tmpdir(),'gjp-opening-'));
  const path=join(directory,'legacy.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const first=createApp({path,password,demo:true});
  const s=first.store;
  s.run('DELETE FROM opening_state');
  const user=s.one("SELECT * FROM users WHERE role='admin'");
  const warehouse=s.one("SELECT id FROM master WHERE code='WH-01'").id;
  const supplier=s.one("SELECT id FROM master WHERE code='S-001'").id;
  const product=s.one("SELECT id FROM master WHERE code='P-1001'").id;
  saveDocument(s,user,{type:'purchaseOrder',warehouse,partner:supplier,lines:[{product,quantity:1,price:1}]});
  s.run("INSERT INTO documents(number,type,date,status,department,creator,total,data) VALUES('QZ-20261114-00001','openingCash','2026-11-14','posted','',?,0,'{}')",user.id);
  s.db.close();
  const second=createApp({path,password,demo:true});
  t.after(()=>second.store.db.close());
  assert.equal(openingState(second.store).opened,true);
  assert.equal(second.store.one("SELECT id FROM documents WHERE number='QZ-20261114-00001'"),undefined);
});

test('期初批次覆盖同步数量和成本，追加保留独立批次',t=>{
  const {s,user,id,save,doc,post}=fixture(t);
  const product=Number(s.run("INSERT INTO master(kind,code,name,data) VALUES('products','OPEN-LOT','批次期初',?)",
    JSON.stringify({unit:'件',batch:true,method:'individual'})).lastInsertRowid);
  const warehouse=id('WH-01');
  save('stock',[{id:product,quantity:10,price:20,batch:'LOT-A',production:'2026-01-01'}],{warehouse});
  post(doc('openingStock',{lines:[{product,quantity:5,price:30,batch:'LOT-B'}]}));
  save('stock',[{id:product,quantity:20,price:15,batch:'LOT-C',production:'2026-02-01'}],{warehouse});
  const lots=s.all('SELECT batch,SUM(quantity) quantity,SUM(value) value FROM movements WHERE product=? GROUP BY batch ORDER BY batch',product);
  assert.deepEqual(lots.map(row=>({...row})),[
    {batch:'LOT-A',quantity:0,value:0},{batch:'LOT-B',quantity:0,value:0},{batch:'LOT-C',quantity:20000,value:30000}
  ]);
  const row=openingData(s,user,'stock',warehouse).rows.find(row=>row.id===product);
  assert.equal(row.batch,'LOT-C');
  assert.equal(row.production,'2026-02-01');
  assert.equal(row.quantity,20);
  assert.equal(row.price,15);
  assert.equal(s.one('SELECT SUM(value) value FROM movements WHERE product=?',product).value,30000);
});

test('辉煌版完整流程：移动成本、净采购销售、利润权益勾稽与随单结算',async t=>{
  const {s,server,user,id,save,control,doc,post}=fixture(t);
  const add=(code,name,data)=>Number(s.run("INSERT INTO master(kind,code,name,data) VALUES('products',?,?,?)",code,name,JSON.stringify(data)).lastInsertRowid);
  const a=add('FLOW-A','流程A',{unit:'件',method:'moving',retail:35,referenceCost:20});
  const b=add('FLOW-B','流程B',{unit:'件',method:'moving',retail:99,referenceCost:50});
  const warehouse=id('WH-01'),target=id('WH-02'),account=id('A-02'),supplier=id('S-001'),customer=id('C-001');
  save('stock',[{id:a,quantity:100,price:20},{id:b,quantity:20,price:50}],{warehouse});
  save('partners',[{id:customer,ar:300},{id:supplier,ap:500}]);
  save('accounts',[{id:account,cash:5000}]);
  control('open',{autoCapital:true});
  const purchase=post(doc('purchase',{partner:supplier,lines:[{product:a,quantity:50,price:20,tax:13}],
    data:{reduction:10,account,paid:500}}));
  const sale=post(doc('sale',{partner:customer,lines:[{product:a,quantity:30,price:35,tax:13}],data:{account,paid:1000}}));
  assert.equal(purchase.autoSettlements.length,1);
  assert.equal(sale.autoSettlements.length,1);
  assert.ok(getDocument(s,user,purchase.id,true).relations.some(row=>row.number===purchase.autoSettlements[0].number));
  const child=getDocument(s,user,purchase.autoSettlements[0].id);
  assert.equal(child.data.settlementSource,purchase.id);
  assert.throws(()=>transition(s,user,child.id,'delete'),/随单结算/);
  post(doc('payment',{partner:supplier,data:{account,amount:620,reference:purchase.id}}));
  post(doc('receipt',{partner:customer,data:{account,amount:300}}));
  post(doc('salesReturn',{partner:customer,lines:[{product:a,quantity:5,price:35,tax:13}],data:{reference:sale.id}}));
  post(doc('purchaseReturn',{partner:supplier,lines:[{product:a,quantity:2,price:20,tax:13}],data:{reference:purchase.id}}));
  const transfer=post(doc('transfer',{target,lines:[{product:b,quantity:5,price:999}]}));
  const loss=post(doc('loss',{lines:[{product:b,quantity:1,price:999}]}));
  const gain=post(doc('gain',{lines:[{product:a,quantity:1,price:35}]}));
  assert.equal(transfer.lines[0].net,25000);
  assert.equal(loss.lines[0].net,5000);
  assert.equal(gain.lines[0].net,2000);
  const stock=s.one('SELECT SUM(quantity) quantity,SUM(value) value FROM stock WHERE product=?',a);
  assert.equal(stock.quantity,124000);
  assert.equal(stock.value/stock.quantity*10,20);
  assert.equal(s.one('SELECT SUM(value) value FROM stock').value,343000);
  const profits=Object.fromEntries(report(s,user,'利润表',{}).rows);
  assert.equal(profits['优惠收入'],'10.00');
  assert.equal(profits['报溢收入'],'20.00');
  assert.equal(profits['报损损失'],'50.00');
  assert.equal(profits['净利润'],'355.00');
  const sheet=report(s,user,'资产负债表',{}).rows;
  assert.equal(sheet.find(row=>row[2]==='累计损益')[3],profits['净利润']);
  assert.equal(sheet.filter(row=>row[0]==='权益'&&row[2]!=='累计损益').length,1);
  const sum=category=>sheet.filter(row=>row[0]===category).reduce((sum,row)=>sum+Math.round(Number(row[3])*100),0);
  assert.equal(sum('资产'),sum('负债')+sum('权益'));
  const operations=Object.fromEntries(report(s,user,'经营报告',{}).sections[1].values);
  assert.equal(operations['采购金额'],'1074.80');
  assert.equal(operations['销售金额'],'988.75');
  const statement=report(s,user,'对账',{partner:customer,from:today()});
  assert.equal(statement.rows[0][1],'期初余额');
  assert.equal(statement.rows[0][5],statement.summary.rows.reduce((sum,row)=>sum+Number(row[2]),0).toFixed(2));
  const login=await request(server,'/api/login',{data:{username:'admin',password}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const source=(await request(server,'/api/document-sources?target=payment&type=purchase',{cookie})).json();
  assert.ok(!source.rows.some(row=>row.id===purchase.id));
  const list=(await request(server,'/api/documents',{cookie})).json().rows;
  for (const row of list.filter(row=>['transfer','receipt','payment'].includes(row.type))) assert.equal(row.outstanding,null);
});

test('库存类单据取仓库成本和无库存回退价，多单位和源单未结过滤正确',async t=>{
  const {s,server,id,user,save,control,doc,post}=fixture(t);
  const product=Number(s.run("INSERT INTO master(kind,code,name,data) VALUES('products','COST-A','成本商品',?)",
    JSON.stringify({unit:'件',method:'moving',referenceCost:20,purchase:10,retail:99,unitRows:[{name:'箱',factor:10}]})).lastInsertRowid);
  const warehouse=id('WH-01'),target=id('WH-02'),partner=id('S-001'),account=id('A-02');
  save('stock',[{id:product,quantity:124,price:20}],{warehouse});
  save('partners',[{id:id('C-001'),ar:1}]);
  control('open',{autoCapital:true});
  const login=await request(server,'/api/login',{data:{username:'admin',password}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const call=url=>request(server,url,{cookie});
  assert.equal((await call('/api/price?type=gain&product='+product+'&warehouse='+warehouse)).json().price,20);
  assert.equal((await call('/api/price?type=miscIn&product='+product+'&warehouse='+target)).json().price,20);
  const gained=post(doc('gain',{lines:[{product,quantity:1,price:99}]}));
  assert.equal(gained.lines[0].data.unitPrice,20);
  assert.equal(gained.total,2000);
  assert.deepEqual({...s.one('SELECT quantity,value FROM stock WHERE product=? AND warehouse=?',product,warehouse)},{quantity:125000,value:250000});
  const moved=post(doc('transfer',{target,lines:[{product,quantity:1,unit:'箱',price:999}]}));
  assert.equal(moved.total,20000);
  assert.equal(moved.lines[0].data.unitPrice,200);
  const incoming=post(doc('purchase',{partner,lines:[{product,quantity:2,price:20}],data:{account,paid:10}}));
  const sources=(await call('/api/document-sources?target=payment&type=purchase')).json();
  const selected=sources.rows.find(row=>row.id===incoming.id);
  assert.equal(selected.total,4000);
  assert.equal(selected.settled,1000);
  assert.equal(selected.outstanding,3000);
  assert.equal(sources.count,1);
  const {settlementNotice}=await import('../public/system-settings.js');
  assert.match(settlementNotice(incoming),new RegExp('已自动生成付款单 '+incoming.autoSettlements[0].number));
  for (const type of ['receipt','payment','advanceIn','advanceOut']) {
    const customer=id('C-001');
    const created=doc(type,{partner:['payment','advanceOut'].includes(type)?partner:customer,data:{account,amount:1}});
    const list=(await call('/api/documents?type='+type)).json();
    assert.equal(list.rows.find(row=>row.id===created.id).outstanding,null);
  }
});

test('旧期初权益分录修复可重复运行，销售优惠单独计入利润且与权益勾稽',async t=>{
  const {s,user,id,save,control,doc,post}=fixture(t);
  save('stock',[{id:id('P-1001'),quantity:10,price:20}],{warehouse:id('WH-01')});
  control('open',{autoCapital:true});
  s.run("DELETE FROM journal_entries WHERE code='3100' AND doc IN (SELECT id FROM documents WHERE type='openingBalance' AND json_extract(data,'$.openingManaged')=1)");
  const {repairOpeningEquity}=await import('../src/accounting.js');
  repairOpeningEquity(s);
  const count=s.one('SELECT COUNT(*) count FROM journal_entries').count;
  repairOpeningEquity(s);
  assert.equal(s.one('SELECT COUNT(*) count FROM journal_entries').count,count);
  post(doc('sale',{partner:id('C-001'),lines:[{product:id('P-1001'),quantity:1,price:35}],data:{reduction:5}}));
  const profit=Object.fromEntries(report(s,user,'利润表',{}).rows);
  assert.equal(profit['优惠支出'],'5.00');
  assert.equal(profit['净利润'],'10.00');
  const sheet=report(s,user,'资产负债表',{}).rows;
  assert.equal(sheet.filter(row=>row[0]==='权益'&&row[2]!=='累计损益').length,1);
  assert.equal(sheet.find(row=>row[2]==='累计损益')[3],profit['净利润']);
  const summary=Object.fromEntries(report(s,user,'资产负债表',{}).summary.rows);
  assert.equal(Number(summary['资产合计']),Number(summary['负债合计'])+Number(summary['权益合计']));
  const carry=Object.fromEntries(report(s,user,'利润表',{from:'9999-01-01'}).rows);
  assert.equal(carry['本期净利润'],'0.00');
  assert.equal(carry['净利润'],profit['净利润']);
});

test('原单反审核一并撤销随单结算，独立结算及后续库存阻止撤销',t=>{
  const {s,user,id,save,control,doc,post}=fixture(t);
  const warehouse=id('WH-01'),product=id('P-1001'),supplier=id('S-001'),customer=id('C-001'),account=id('A-02');
  save('accounts',[{id:account,cash:500}]);
  control('open',{autoCapital:true});
  const purchase=post(doc('purchase',{partner:supplier,lines:[{product,quantity:10,price:20}],data:{account,paid:50}}));
  const child=purchase.autoSettlements[0];
  assert.throws(()=>transition(s,user,child.id,'unapprove'),/随单结算/);
  const draft=transition(s,user,purchase.id,'unapprove');
  assert.equal(draft.status,'draft');
  assert.equal(getDocument(s,user,child.id).status,'deleted');
  assert.equal(s.one('SELECT quantity FROM stock WHERE product=? AND warehouse=?',product,warehouse).quantity,0);
  assert.equal(s.one("SELECT SUM(amount) amount FROM ledger WHERE category='cash' AND entity=?",account).amount,50000);
  assert.equal(s.one("SELECT COALESCE(SUM(amount),0) amount FROM ledger WHERE category='ap' AND entity=?",supplier).amount,0);
  const again=post(draft);
  const sale=post(doc('sale',{partner:customer,lines:[{product,quantity:2,price:35}],data:{account,paid:10}}));
  assert.throws(()=>transition(s,user,again.id,'unapprove'),/后续库存流水/);
  const originalQuantity=s.one('SELECT quantity FROM stock WHERE product=? AND warehouse=?',product,warehouse).quantity;
  const receipt=post(doc('receipt',{partner:customer,data:{account,amount:1,reference:sale.id}}));
  assert.throws(()=>transition(s,user,sale.id,'unapprove'),/独立收付款或后续单据/);
  assert.equal(getDocument(s,user,receipt.id).status,'posted');
  assert.equal(s.one('SELECT quantity FROM stock WHERE product=? AND warehouse=?',product,warehouse).quantity,originalQuantity);
});
