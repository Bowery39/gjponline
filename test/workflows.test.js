import { readWorkbookRows } from '../src/xlsx-import.js';
import { loadDocumentSource, mergeReturnLine, uniqueSourceLines } from '../public/document-settings.js';

import { xlsx } from '../src/xlsx.js';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from '../src/server.js';
import { getDocument, lookupPrice, saveDocument, today, transition, closeMonth } from '../src/engine.js';
import { listDocuments, report } from '../src/reports.js';
import { reports } from '../public/catalog.js';

const testPassword='Test-Inventory-2026';
function fixture(t) {
  const {server,store:s}=createApp({password:testPassword,demo:true});
  // Legacy calculation regressions use the pre-opening-control storage format.
  s.run('DELETE FROM opening_state');
  t.after(()=>s.db.close());
  const user=s.one("SELECT * FROM users WHERE role='admin'");
  const accounts=s.all("SELECT id FROM master WHERE kind='accounts' ORDER BY code");
  const [supplier,customer]=['S-001','C-001'].map(code=>s.one('SELECT id FROM master WHERE code=?',code).id);
  const [warehouse,otherWarehouse]=s.all("SELECT id FROM master WHERE kind='warehouses' ORDER BY code").map(r=>r.id);
  const [product,monthly]=s.all("SELECT id FROM master WHERE kind='products' ORDER BY code").map(r=>r.id);
  const doc=(type,params={})=>saveDocument(s,user,{type,warehouse,...params});
  const move=(d,action)=>transition(s,user,d.id,action);
  const post=d=>['submit','approve','post'].reduce(move,d);
  const amount=(category,entity)=>s.one('SELECT COALESCE(SUM(amount),0) total FROM ledger WHERE category=? AND (? IS NULL OR entity=?)',category,entity??null,entity??null).total;
  const stock=(item,place=warehouse)=>({...s.one('SELECT quantity,value FROM stock WHERE product=? AND warehouse=?',item,place)});
  const add=(kind,code,name,data={})=>Number(s.run('INSERT INTO master(kind,code,name,data) VALUES (?,?,?,?)',kind,code,name,JSON.stringify(data)).lastInsertRowid);
  return {s,user,server,supplier,customer,warehouse,otherWarehouse,product,monthly,doc,move,post,amount,stock,add,account:accounts[0].id};
}
test('采购、付款、报价、销售、收款与经营报告一致',t=>{
  const {s,user,supplier,customer,product,warehouse,doc,post,move,amount,stock,account,add}=fixture(t);
  const created=add('products','T-100','测试收纳盒',{method:'moving',unit:'个',retail:15});
  const order=post(doc('purchaseOrder',{partner:supplier,lines:[{product:created,quantity:100,price:8}]}));
  const purchase=post(doc('purchase',{partner:supplier,data:{reference:order.id},lines:[{product:created,quantity:100,price:8}]}));
  assert.deepEqual(stock(created),{quantity:100000,value:80000});
  assert.equal(amount('ap',supplier),80000);
  post(doc('openingCash',{data:{account,amount:1000}}));
  post(doc('payment',{partner:supplier,data:{reference:purchase.id,account,amount:800}}));
  move(purchase,'settle');
  assert.equal(amount('ap',supplier),0);
  assert.equal(amount('cash',account),20000);
  const quote=post(doc('quote',{partner:customer,lines:[{product:created,quantity:10,price:15}]}));
  const saleOrder=post(doc('salesOrder',{partner:customer,data:{reference:quote.id},lines:[{product:created,quantity:10,price:15}]}));
  const sale=post(doc('sale',{partner:customer,data:{reference:saleOrder.id},lines:[{product:created,quantity:10,price:15}]}));
  assert.deepEqual(stock(created),{quantity:90000,value:72000});
  assert.equal(amount('ar',customer),15000);
  assert.equal(amount('cogs'),8000);
  const inventory=report(s,user,'库存状况查询',{warehouse});
  assert.equal(inventory.rows.find(r=>r[0]==='T-100')[8],'720.00');
  assert.equal(inventory.rows.find(r=>r[0]==='T-100')[11],'46.67%');
  post(doc('receipt',{partner:customer,data:{reference:sale.id,account,amount:150}}));
  move(sale,'settle');
  assert.equal(amount('ar',customer),0);
  assert.equal(amount('cash',account),35000);
  assert.equal(report(s,user,'经营报告',{mode:'month'}).rows[0][1],'150.00');
  assert.equal(report(s,user,'经营报告',{}).sections[2].values[3][1],'70.00');
  assert.equal(report(s,user,'销售及毛利统计',{}).rows[0][5],'70.00');
  assert.throws(()=>move(sale,'post'),/无法执行/);
  assert.throws(()=>doc('sale',{id:sale.id,partner:customer,lines:[{product,quantity:1,price:20}]}),/仅草稿/);
  for (const name of Object.values(reports).flat()) assert.ok(Array.isArray(report(s,user,name,{}).rows),name);
});
test('移动加权与已结月份的一次加权按手工账核对',t=>{
  const {s,user,supplier,customer,product,monthly,doc,post,amount,stock}=fixture(t);
  const calendar=new Date(today()+'T12:00:00Z');
  calendar.setUTCDate(0);
  const month=calendar.toISOString().slice(0,7);
  for (const item of [product,monthly]) {
    post(doc('purchase',{date:month+'-01',partner:supplier,lines:[{product:item,quantity:10,price:10}]}));
    post(doc('sale',{date:month+'-02',partner:customer,lines:[{product:item,quantity:5,price:30}]}));
    post(doc('purchase',{date:month+'-03',partner:supplier,lines:[{product:item,quantity:10,price:20}]}));
    assert.deepEqual(stock(item),{quantity:15000,value:25000});
  }
  closeMonth(s,user,month);
  assert.deepEqual(stock(monthly),{quantity:15000,value:22500});
  assert.deepEqual(stock(product),{quantity:15000,value:25000});
  assert.equal(amount('cogs'),12500);
  assert.throws(()=>doc('loss',{date:month+'-04',lines:[{product,quantity:1}]}),/已月结/);
  post(doc('sale',{partner:customer,lines:[{product,quantity:3,price:30}]}));
  assert.deepEqual(stock(product),{quantity:12000,value:20000});
});
test('单据编号、并发编辑保护、越权访问和失败回滚',t=>{
  const {s,user,customer,product,warehouse,otherWarehouse,doc,move,post,stock}=fixture(t);
  s.run('INSERT INTO stock VALUES (?,?,?,?)',product,warehouse,3000,1500);
  s.run('INSERT INTO stock VALUES (?,?,?,?)',product,otherWarehouse,1000,500);
  const first=doc('sale',{partner:customer,lines:[{product,quantity:1,price:10}]});
  const second=doc('sale',{partner:customer,warehouse:otherWarehouse,lines:[{product,quantity:1,price:10}]});
  assert.match(first.number,/^XS-\d{8}-00001$/);
  assert.match(second.number,/^XS-\d{8}-00002$/);
  doc('sale',{id:first.id,revision:1,partner:customer,lines:[{product,quantity:2,price:10}]});
  assert.throws(()=>doc('sale',{id:first.id,revision:1,partner:customer,lines:[{product,quantity:3,price:10}]}),/其他用户修改/);
  const clerk={...user,role:'clerk',department:'门店',warehouses:JSON.stringify([warehouse])};
  assert.deepEqual(listDocuments(s,clerk,{}).rows.map(r=>r.number),[first.number]);
  assert.throws(()=>getDocument(s,clerk,second.id),/无访问权限/);
  assert.throws(()=>transition(s,clerk,first.id,'approve'),/没有此操作权限/);
  assert.throws(()=>saveDocument(s,clerk,{type:'sale',warehouse:otherWarehouse,partner:customer,lines:[{product,quantity:1,price:10}]}),/超出/);
  move(first,'submit');
  move(first,'approve');
  s.run('UPDATE stock SET quantity=0,value=0 WHERE product=? AND warehouse=?',product,warehouse);
  assert.throws(()=>move(first,'post'),/库存不足/);
  assert.deepEqual(stock(product),{quantity:0,value:0});
  assert.equal(getDocument(s,user,first.id).status,'approved');
  assert.throws(()=>move(first,'delete'),/无法执行/);
  assert.equal(move(first,'unapprove').status,'draft');
  assert.equal(move(first,'delete').status,'deleted');
});
test('收货批次和序列号随调拨转移，越库发货时整体回滚',t=>{
  const {s,user,customer,supplier,warehouse,otherWarehouse,doc,post,stock,add}=fixture(t);
  const product=add('products','S-10','样品仪表',{serial:true,batch:true});
  const line={product,quantity:2,price:50,batch:'L5',expiry:'2030-12-31',serials:'S1 S2'};
  post(doc('purchase',{partner:supplier,lines:[line]}));
  post(doc('transfer',{target:otherWarehouse,lines:[{...line,quantity:1,serials:'S1'}]}));
  assert.deepEqual(stock(product),{quantity:1000,value:5000});
  assert.deepEqual(stock(product,otherWarehouse),{quantity:1000,value:5000});
  assert.equal(report(s,user,'库存状况查询',{warehouse:otherWarehouse,view:'serial'}).rows[0].at(-1),'S1');
  assert.equal(report(s,user,'批次号跟踪',{warehouse:otherWarehouse}).rows[0].at(-1),1);
  assert.throws(()=>post(doc('sale',{partner:customer,lines:[{...line,quantity:1,serials:'S1'}]})),/不属于当前仓库/);
  assert.deepEqual(stock(product),{quantity:1000,value:5000});
});
test('各价格层优先级与供应商采购参考价',t=>{
  const {s,product,customer,supplier,add}=fixture(t);
  assert.deepEqual(lookupPrice(s,product,customer,1,'customer'),{price:15.8,source:'零售价'});
  s.run(`UPDATE master SET data=json_set(data,'$.preset1',14) WHERE id=?`,product);
  assert.equal(lookupPrice(s,product,customer,1,'customer').price,14);
  add('tiers','TP','阶梯价',{product,minimum:50,price:12});
  assert.equal(lookupPrice(s,product,customer,50,'customer').price,12);
  add('customerPrices','CP','客户协议价',{product,partner:customer,price:11});
  add('supplierPrices','SP','供应商协议价',{product,partner:supplier,price:7});
  assert.equal(lookupPrice(s,product,customer,50,'customer').price,11);
  assert.equal(lookupPrice(s,product,supplier,50,'supplier').price,7);
});
function request(server,url,{data,cookie}={}) {
  const req=Readable.from(data===undefined?[]:[Buffer.from(JSON.stringify(data))]);
  Object.assign(req,{url,method:data===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},socket:{remoteAddress:'test'}});
  return new Promise(resolve=>{
    const headers={};
    const response={
      headersSent:false,status:200,
      setHeader:(key,value)=>{headers[key.toLowerCase()]=value;},
      writeHead:(status,items)=>{response.status=status;response.headersSent=true;for (const [key,value] of Object.entries(items)) response.setHeader(key,value);},
      end:value=>resolve({status:response.status,headers,raw:value,body:String(value??''),json:()=>JSON.parse(value)})
    };
    server.emit('request',req,response);
  });
}
test('会话认证、商品 Excel 导入及导出以及默认打印模板',async t=>{
  const {server}=fixture(t);
  assert.deepEqual((await request(server,'/api/me')).json(),{user:null});
  assert.equal((await request(server,'/favicon.ico')).status,200);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  assert.equal(login.status,200);
  assert.match(login.headers['set-cookie'],/HttpOnly; SameSite=Strict/);
  const cookie=login.headers['set-cookie'].split(';')[0];
  const withData=data=>({data,cookie});
  const create=await request(server,'/api/products/import',withData({mode:'new',workbook:xlsx(['商品编号','商品名称','零售价'],[['T-A','测试, 值',19.95]]).toString('base64')}));
  assert.equal(create.json().count,1);
  const update=await request(server,'/api/products/import',withData({mode:'update',workbook:xlsx(['商品编号','商品名称','零售价'],[['T-A','标准测试品',25]]).toString('base64')}));
  assert.equal(update.json().count,1);
  const exported=await request(server,'/api/master/products?export=1&keyword=T-A',{cookie});
  assert.match(exported.headers['content-type'],/spreadsheetml/);
  assert.match(exported.headers['content-disposition'],/\.xlsx/);
  const workbook=exported.raw;
  let offset=0;
  let sheet='';
  while (workbook.readUInt32LE(offset)===0x04034b50) {
    const size=workbook.readUInt32LE(offset+18);
    const nameLength=workbook.readUInt16LE(offset+26);
    const name=workbook.toString('utf8',offset+30,offset+30+nameLength);
    const start=offset+30+nameLength+workbook.readUInt16LE(offset+28);
    if (name==='xl/worksheets/sheet1.xml') sheet=inflateRawSync(workbook.subarray(start,start+size)).toString();
    offset=start+size;
  }
  assert.match(sheet,/<row r="2">.*>T-A<.*>标准测试品<.*<v>25<\/v>/);
  const details=await request(server,'/api/document-lines/import',withData({
    type:'sale',workbook:xlsx(['商品编号','数量','单价'],[['00123',2.5,25]]).toString('base64')
  }));
  assert.deepEqual(details.json().rows,[['商品编号','数量','单价'],['00123','2.5','25']]);
  const invalid=await request(server,'/api/document-lines/import',withData({type:'sale',workbook:'invalid'}));
  assert.equal(invalid.status,400);
  const templates=await request(server,'/api/master/templates?active=1',{cookie});
  assert.equal(templates.json().rows[0].data.title,'销售出库单');
  assert.equal((await request(server,'/api/logout',withData({}))).status,200);
  assert.deepEqual((await request(server,'/api/me',{cookie})).json(),{user:null});
});

test('部分出库保留剩余占用，多单位、预收、分账户收款及分录平衡',t=>{
  const {s,user,supplier,customer,warehouse,account,doc,post,amount,stock,add}=fixture(t);
  const item=add('products','BX-1','测试箱装商品',{unit:'个',units:'箱=12个',method:'moving'});
  const supplierCost=[{product:item,unit:'箱',quantity:10,price:60}];
  post(doc('purchase',{partner:supplier,lines:supplierCost}));
  assert.deepEqual(stock(item),{quantity:120000,value:60000});
  const order=post(doc('salesOrder',{partner:customer,lines:[{product:item,unit:'箱',quantity:3,price:120}]}));
  post(doc('advanceIn',{partner:customer,data:{account,amount:50}}));
  const sales=post(doc('sale',{partner:customer,lines:[{product:item,unit:'箱',quantity:1,price:120,tax:10}],
    data:{reference:order.id,advance:30,receipts:[{account,amount:30}],saleExpenses:[{partner:supplier,amount:5,paid:3,account}]}}));
  assert.equal(sales.total,13200);
  assert.equal(amount('ar',customer),7200);
  assert.equal(amount('advanceIn',customer),2000);
  assert.equal(amount('salesFee'),500);
  assert.deepEqual(stock(item),{quantity:108000,value:54000});
  const available=report(s,user,'可销售库存查询',{warehouse}).rows.find(row=>row[0]==='BX-1');
  assert.deepEqual(available.slice(3,6),[108,24,84]);
  assert.throws(()=>post(doc('sale',{partner:customer,lines:[{product:item,unit:'箱',quantity:3,price:120}],data:{reference:order.id}})),/超过关联/);
  assert.deepEqual(s.all('SELECT doc FROM journal_entries GROUP BY doc HAVING SUM(amount) <> 0'),[]);
  assert.ok(report(s,user,'会计分录查询',{}).rows.some(row=>row[1]===sales.number && row[3]==='应收账款'));
});

test('附件访问限单据权限，对账链接只分享指定单位的快照',async t=>{
  const {server,supplier,customer,product,doc,post}=fixture(t);
  const purchase=post(doc('purchase',{partner:supplier,lines:[{product,quantity:4,price:5}]}));
  const sale=post(doc('sale',{partner:customer,data:{summary:'测试'},attachments:[{name:'清单.txt',content:'YWJj'}],lines:[{product,quantity:1,price:10}]}));
  const attachment= '/api/attachments/'+sale.attachments[0].id;
  assert.equal((await request(server,attachment)).status,401);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  assert.equal((await request(server,attachment,{cookie})).body,'abc');
  const shared=(await request(server,'/api/statements',{cookie,data:{partner:customer}})).json();
  assert.match(shared.path,/^\/statement\/[a-f0-9]{64}$/);
  const statement=await request(server,shared.path);
  assert.equal(statement.status,200);
  assert.ok(statement.body.includes(sale.number));
  assert.ok(!statement.body.includes(purchase.number));
});

test('单据选择只返回权限范围内的已提交来源，支持搜索与分页',async t=>{
  const {server,s,doc,move,customer,product,otherWarehouse}=fixture(t);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  for (let i=0;i<27;i++) move(doc('quote',{partner:customer,lines:[{product,quantity:1,price:15.8}]}),'submit');
  const draft=doc('quote',{partner:customer,lines:[{product,quantity:1,price:15.8}]});
  const first=(await request(server,'/api/document-sources?target=salesOrder&type=quote',{cookie})).json();
  assert.equal(first.count,27);
  assert.equal(first.rows.length,25);
  assert.ok(first.rows.every(row=>row.status==='pending'));
  const second=(await request(server,'/api/document-sources?target=salesOrder&type=quote&page=2',{cookie})).json();
  assert.equal(second.rows.length,2);
  const found=(await request(server,'/api/document-sources?target=salesOrder&type=quote&keyword='+second.rows[0].number,{cookie})).json();
  assert.equal(found.rows[0].id,second.rows[0].id);
  assert.equal((await request(server,'/api/document-sources?target=purchase&type=quote',{cookie})).status,400);
  assert.throws(()=>doc('salesOrder',{partner:customer,lines:[{product,quantity:1,price:15.8}],data:{reference:draft.id}}),/尚未提交/);
  const linked=doc('salesOrder',{partner:customer,lines:[{product,quantity:1,price:15.8}],data:{reference:first.rows[0].id}});
  assert.equal(linked.data.reference,first.rows[0].id);
  await request(server,'/api/master/users',{cookie,data:{name:'制单员',username:'buyer',password:testPassword,role:'clerk',warehouses:[otherWarehouse]}});
  const clerk=(await request(server,'/api/login',{data:{username:'buyer',password:testPassword}})).headers['set-cookie'].split(';')[0];
  assert.equal((await request(server,'/api/document-sources?target=sale&type=quote',{cookie:clerk})).json().count,0);
  assert.ok((await request(server,'/api/document-directory',{cookie:clerk})).json().staff.every(row=>!row.hash));
  assert.equal(s.one("SELECT COUNT(*) count FROM master WHERE kind IN ('expenses','carriers') AND active=1").count,2);
});

test('采购入库的分账户付款及采购费用入账，销售订单结算信息只保存',t=>{
  const {s,doc,post,amount,supplier,customer,product,account}=fixture(t);
  const expense=s.one("SELECT id FROM master WHERE code='EXP-01'").id;
  const carrier=s.one("SELECT id FROM master WHERE code='LOG-01'").id;
  const plan=post(doc('salesOrder',{partner:customer,lines:[{product,quantity:1,price:15.8}],
    data:{receipts:[{account,amount:2}],paid:3,advance:2,carrier,settlementPartner:customer,delivery:'到店自提'}}));
  assert.equal(plan.data.receipts[0].amount,200);
  assert.equal(plan.data.carrier,carrier);
  assert.equal(amount('cash',account),0);
  post(doc('purchase',{partner:supplier,lines:[{product,quantity:5,price:8}],
    data:{receipts:[{account,amount:10},{account,amount:12}],saleExpenses:[{subject:expense,amount:3,paid:3,account}],carrier}}));
  assert.equal(amount('ap',supplier),1800);
  assert.equal(amount('expense',expense),300);
  assert.equal(amount('cash',account),-2500);
  assert.deepEqual(s.all('SELECT doc FROM journal_entries GROUP BY doc HAVING SUM(amount) <> 0'),[]);
});

test('分类移动会同步更新下级商品，结构化多单位按基本单位入库',async t=>{
  const {server,s,supplier,doc,post,stock}=fixture(t);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const category=data=>request(server,'/api/product-categories',{cookie,data});
  assert.equal((await category({action:'create',name:'食品'})).status,200);
  assert.equal((await category({action:'create',parent:'食品',name:'调味料'})).status,200);
  const create=await request(server,'/api/master/products',{cookie,data:{code:'MULTI-01',name:'多单位测试商品',
    data:{category:'食品/调味料',unit:'瓶',multiUnit:true,purchaseUnit:'箱',salesUnit:'瓶',unitRows:[{name:'箱',factor:12,barcode:'CASE-01'}]}}});
  assert.equal(create.status,200);
  assert.equal((await category({action:'delete',path:'食品/调味料'})).status,400);
  assert.equal((await category({action:'update',path:'食品',name:'零食'})).status,200);
  const paths=(await request(server,'/api/product-categories',{cookie})).json().paths;
  assert.ok(paths.includes('零食/调味料'));
  assert.ok(!paths.includes('食品/调味料'));
  const product=s.one("SELECT * FROM master WHERE kind='products' AND code='MULTI-01'");
  assert.equal(JSON.parse(product.data).category,'零食/调味料');
  const result=(await request(server,'/api/master/products?category='+encodeURIComponent('零食'),{cookie})).json();
  assert.equal(result.rows[0].id,product.id);
  post(doc('purchase',{partner:supplier,lines:[{product:product.id,unit:'箱',quantity:2,price:36}]}));
  assert.deepEqual(stock(product.id),{quantity:24000,value:7200});
  const details=report(s,s.one("SELECT * FROM users WHERE role='admin'"),'商品采购明细查询',{keyword:'MULTI-01'});
  assert.deepEqual(details.columns.slice(-4),['数量','单位','不含税单价','含税金额']);
  assert.deepEqual(details.rows[0].slice(-4),[2,'箱','36.00','72.00']);
});

test('往来单位导入、分类及查询显示实际应付应收，停用后可筛选',async t=>{
  const {server,s,doc,post,supplier,product}=fixture(t);
  post(doc('purchase',{partner:supplier,lines:[{product,quantity:2,price:8}]}));
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const inserted=await request(server,'/api/partners/import',{cookie,data:{workbook:xlsx(['单位编号','单位名称','类型','电话','分类'],[['CLIENT-01','双类型往来单位','客户和供应商','555123','地区/门店']]).toString('base64')}});
  assert.equal(inserted.status,200);
  const paths=(await request(server,'/api/partner-categories',{cookie})).json().paths;
  assert.ok(paths.includes('地区/门店'));
  const list=(await request(server,'/api/master/partners?partnerType=supplier',{cookie})).json().rows;
  assert.equal(list.find(row=>row.id===supplier).payable,1600);
  const target=list.find(row=>row.code==='CLIENT-01');
  assert.ok(target);
  const phone=(await request(server,'/api/master/partners?keyword=555123',{cookie})).json().rows;
  assert.deepEqual(phone.map(row=>row.id),[target.id]);
  assert.equal((await request(server,'/api/partners/status',{cookie,data:{ids:[target.id],active:0}})).status,200);
  const disabled=(await request(server,'/api/master/partners?active=0',{cookie})).json().rows;
  assert.deepEqual(disabled.map(row=>row.id),[target.id]);
  assert.equal(s.one('SELECT active FROM master WHERE id=?',supplier).active,1);
});

test('采购和销售订单按已记账数量计算执行进度并从可选来源移除完结订单',async t=>{
  const {server,s,user,doc,post,move,supplier,customer,product}=fixture(t);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const purchaseOrder=post(doc('purchaseOrder',{partner:supplier,lines:[{product,quantity:10,price:8}]}));
  const inbound=post(doc('purchase',{partner:supplier,lines:[{product,quantity:4,price:8}],data:{reference:purchaseOrder.id}}));
  const purchaseState=getDocument(s,user,purchaseOrder.id).execution;
  assert.equal(purchaseState.state,'partial');
  assert.equal(purchaseState.rows[0].remaining,6000);
  assert.equal(purchaseState.documents[0].id,inbound.id);
  assert.equal((await request(server,'/api/document-sources?target=purchase&type=purchaseOrder',{cookie})).json().count,1);
  post(doc('purchase',{partner:supplier,lines:[{product,quantity:6,price:8}],data:{reference:purchaseOrder.id}}));
  assert.equal(getDocument(s,user,purchaseOrder.id).execution.state,'complete');
  assert.equal((await request(server,'/api/document-sources?target=purchase&type=purchaseOrder',{cookie})).json().count,0);
  const salesOrder=post(doc('salesOrder',{partner:customer,lines:[{product,quantity:5,price:15.8}]}));
  const outgoing=move(move(doc('sale',{partner:customer,lines:[{product,quantity:1,price:15.8}],data:{reference:salesOrder.id}}),'submit'),'approve');
  move(salesOrder,'settle');
  assert.equal(getDocument(s,user,salesOrder.id).execution.state,'closed');
  assert.throws(()=>move(outgoing,'post'),/订单已终止/);
});

test('采购换货共同约束退货数量并同步记账差价及采购统计',t=>{
  const {s,user,doc,post,supplier,product,stock,amount}=fixture(t);
  const purchase=post(doc('purchase',{partner:supplier,lines:[{product,quantity:4,price:8}]}));
  const exchange=post(doc('purchaseExchange',{partner:supplier,data:{reference:purchase.id},
    lines:[{product,quantity:2,price:8,direction:'return'},{product,quantity:2,price:9}]}));
  assert.equal(exchange.total,200);
  assert.deepEqual(stock(product),{quantity:4000,value:3400});
  assert.equal(amount('ap',supplier),3400);
  assert.equal(getDocument(s,user,exchange.id).unpaid,200);
  assert.throws(()=>post(doc('purchaseReturn',{partner:supplier,data:{reference:purchase.id},lines:[{product,quantity:3,price:8}]})),/超过关联单据数量/);
  assert.equal(report(s,user,'采购波动分析',{mode:'month'}).rows[0][3],'34.00');
  assert.deepEqual(s.all('SELECT doc FROM journal_entries GROUP BY doc HAVING SUM(amount) <> 0'),[]);
});

test('报表明细保留原单 ID，并可在权限范围内调阅关联单据和操作日志',async t=>{
  const {server,s,user,doc,post,supplier,product}=fixture(t);
  const order=post(doc('purchaseOrder',{partner:supplier,lines:[{product,quantity:5,price:8}]}));
  const receipt=post(doc('purchase',{partner:supplier,lines:[{product,quantity:3,price:8}],data:{reference:order.id}}));
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const reportUrl='/api/report?name='+encodeURIComponent('商品采购明细查询')+'&keyword='+encodeURIComponent(receipt.number);
  const details=(await request(server,reportUrl,{cookie})).json();
  assert.deepEqual(details.documentIds,[receipt.id]);
  assert.equal(details.rows[0][1],receipt.number);
  const source=(await request(server,'/api/documents/'+details.documentIds[0]+'?detail=1',{cookie})).json();
  assert.equal(source.lines[0].quantity,3000);
  assert.equal(source.relations[0].id,order.id);
  assert.equal(source.history[0].action,'post');
  assert.equal((await request(server,reportUrl+'&page=2',{cookie})).json().documentIds.length,0);
  assert.equal(getDocument(s,user,order.id,true).relations[0].id,receipt.id);
});

test('开单默认与字段配置按账号和单据类型保存，可复制且校验必录字段',async t=>{
  const {server,customer,warehouse,product,doc,supplier,post}=fixture(t);
  post(doc('purchase',{partner:supplier,lines:[{product,quantity:2,price:8}]}));
  const login=async username=>(await request(server,'/api/login',{data:{username,password:testPassword}})).headers['set-cookie'].split(';')[0];
  const cookie=await login('admin');
  await request(server,'/api/master/users',{cookie,data:{name:'制单员',username:'buyer',password:testPassword,role:'clerk',warehouses:[warehouse]}});
  const clerk=await login('buyer');
  const path='/api/document-settings';
  assert.equal((await request(server,path+'?type=sale')).status,401);
  assert.deepEqual((await request(server,path,{cookie,data:{type:'sale',mode:'defaults',values:{partner:customer,warehouse,fuzzy:true,unknown:42}}})).json(),
    {defaults:{partner:customer,warehouse,fuzzy:true}});
  const fields={
    head:{partner:{visible:false,alias:'订货客户'},summary:{visible:false}},
    bodyCustom:{customLine1:{visible:false,required:true,alias:'货位编号'}}
  };
  const result=(await request(server,path,{cookie,data:{type:'sale',mode:'fields',values:fields,targets:['salesOrder','purchase','receipt']}})).json();
  assert.deepEqual(result.fields.head.partner,{alias:'订货客户',visible:true,required:false});
  assert.equal(result.updated.salesOrder.bodyCustom.customLine1.visible,true);
  assert.equal(result.updated.purchase.head.partner,undefined);
  assert.deepEqual(result.updated.receipt.bodyCustom,{});
  assert.deepEqual((await request(server,path+'?type=sale',{cookie:clerk})).json(),{defaults:{},fields:{}});
  assert.equal((await request(server,path+'?type=sale',{cookie})).json().defaults.partner,customer);
  assert.throws(()=>doc('sale',{partner:customer,lines:[{product,quantity:1}]}),/第 1 行：请填写货位编号/);
  const created=doc('sale',{partner:customer,data:{summary:'隐藏后仍保存'},lines:[{product,quantity:1,customLine1:'A1-07'}]});
  assert.equal(created.lines[0].data.customLine1,'A1-07');
  assert.equal(created.data.summary,'隐藏后仍保存');
  await request(server,path,{cookie,data:{type:'sale',mode:'fields',values:{}}});
  assert.doesNotThrow(()=>doc('sale',{partner:customer,lines:[{product,quantity:1}]}));
});

test('系统配置控制开单精度、含税金额、个别计价及手工月结',async t=>{
  const {s,user,server,supplier,customer,warehouse,otherWarehouse,doc,post,stock}=fixture(t);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const path='/api/system-settings';
  const defaults=(await request(server,path,{cookie})).json();
  const settings={...defaults,quantityDigits:4,priceDigits:4,discountDigits:2,purchaseTax:'inclusive',manualClose:false};
  assert.equal((await request(server,path,{cookie,data:{...settings,costMethods:[]}})).status,400);
  assert.equal((await request(server,path,{cookie,data:settings})).status,200);
  assert.deepEqual((await request(server,path,{cookie})).json(),settings);
  const saved=await request(server,'/api/master/products',{cookie,data:{code:'BATCH-TEST',name:'个别计价商品',data:{method:'individual',batch:true,unit:'个'}}});
  assert.equal(saved.status,200);
  const product=s.one('SELECT id FROM master WHERE kind=? AND code=?','products','BATCH-TEST').id;
  const line={product,quantity:1.0007,price:11.3013,tax:13,batch:'A'};
  const purchased=post(doc('purchase',{partner:supplier,lines:[line]}));
  assert.equal(purchased.lines[0].data.unitPrice,11.3013);
  assert.equal(purchased.lines[0].quantity,1000.7);
  assert.equal(purchased.lines[0].net,1001);
  assert.equal(purchased.total,1131);
  post(doc('purchase',{partner:supplier,lines:[{...line,batch:'B',quantity:1,price:30,tax:0}]}));
  post(doc('transfer',{target:otherWarehouse,lines:[{...line,price:0,tax:0}]}));
  assert.deepEqual(stock(product),{quantity:1000,value:3000});
  assert.deepEqual(stock(product,otherWarehouse),{quantity:1000.7,value:1001});
  post(doc('sale',{warehouse:otherWarehouse,partner:customer,lines:[{...line,price:25,tax:0}]}));
  assert.deepEqual(stock(product,otherWarehouse),{quantity:0,value:0});
  assert.throws(()=>closeMonth(s,user,'2020-01'),/启用手工月结/);
});

test('职员模块权限独立控制单据操作及资料和报表，并即时应用于已有会话',async t=>{
  const {server,doc,post,warehouse,customer,supplier,product}=fixture(t);
  const signIn=async username=>(await request(server,'/api/login',{data:{username,password:testPassword}})).headers['set-cookie'].split(';')[0];
  const admin=await signIn('admin');
  const createUser=await request(server,'/api/master/users',{cookie:admin,data:{
    username:'limited',name:'职员',role:'viewer',password:testPassword,warehouses:[warehouse]
  }});
  assert.equal(createUser.status,200);
  const cookie=await signIn('limited');
  const me=(await request(server,'/api/me',{cookie})).json();
  const endpoint='/api/staff-permissions/'+me.id;
  const purchase=post(doc('purchase',{partner:supplier,lines:[{product,quantity:1}]}));
  const settings={
    'd:sale':['view','create','submit'],
    'd:purchase':[],
    'm:products':['view'],
    'r:销售明细查询':[]
  };
  assert.equal((await request(server,endpoint,{cookie,data:{permissions:settings}})).status,403);
  assert.equal((await request(server,endpoint,{cookie:admin,data:{permissions:{'d:sale':['create']}}})).status,400);
  assert.equal((await request(server,endpoint,{cookie:admin,data:{permissions:settings}})).status,200);
  assert.deepEqual((await request(server,'/api/me',{cookie})).json().permissions,settings);
  assert.equal((await request(server,'/api/documents/'+purchase.id,{cookie})).status,404);
  assert.equal((await request(server,'/api/documents?type=purchase',{cookie})).status,403);
  assert.ok(!(await request(server,'/api/documents',{cookie})).json().rows.some(row=>row.type==='purchase'));
  assert.equal((await request(server,'/api/master/products?export=1',{cookie})).status,403);
  assert.equal((await request(server,'/api/report?name='+encodeURIComponent('销售明细查询'),{cookie})).status,403);
  const data={type:'sale',partner:customer,warehouse,lines:[{product,quantity:1,price:10}]};
  const created=await request(server,'/api/documents',{cookie,data});
  assert.equal(created.status,200);
  const sale=created.json();
  const salePath='/api/documents/'+sale.id;
  assert.equal((await request(server,'/api/documents',{cookie,data:{...data,id:sale.id,revision:sale.data.revision}})).status,403);
  assert.equal((await request(server,salePath+'/print-template',{cookie})).status,403);
  assert.equal((await request(server,salePath,{cookie,data:{action:'submit'}})).status,200);
  assert.equal((await request(server,salePath,{cookie,data:{action:'approve'}})).status,403);
  assert.equal((await request(server,endpoint,{cookie:admin,data:{permissions:{}}})).status,200);
  assert.equal((await request(server,'/api/documents/'+purchase.id,{cookie})).status,200);
  assert.equal((await request(server,'/api/documents',{cookie,data})).status,403);
});

test('商品停用后仍可查询，启用后重新可选，已有引用的商品不可删除',async t=>{
  const {server,doc,supplier,product,s}=fixture(t);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const status='/api/products/'+product+'/status';
  const list='/api/master/products?all=1';
  const visible=async filter=>(await request(server,list+filter,{cookie})).json().rows.some(row=>row.id===product);
  assert.equal((await request(server,status,{cookie,data:{active:0}})).status,200);
  assert.equal(await visible(''),true);
  assert.equal(await visible('&active=0'),true);
  assert.equal(await visible('&active=1'),false);
  assert.equal((await request(server,status,{cookie,data:{active:1}})).status,200);
  assert.equal(await visible('&active=1'),true);

  doc('purchase',{partner:supplier,lines:[{product,quantity:1}]});
  assert.equal((await request(server,'/api/products/'+product+'/delete',{cookie,data:{}})).status,409);
  const unused=Number(s.run("INSERT INTO master(kind,code,name) VALUES ('products','REMOVE-ME','无引用商品')").lastInsertRowid);
  assert.equal((await request(server,'/api/products/'+unused+'/delete',{cookie,data:{}})).status,200);
  assert.equal(s.one('SELECT id FROM master WHERE id=?',unused),undefined);
});

test('基础资料可切换状态和删除，单据引用与当前职员受保护',async t=>{
  const {server,user,doc,account,add,s}=fixture(t);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const id=add('carriers','TEST-REMOVE','测试物流');
  const carrier='/api/master/carriers/'+id;
  assert.equal((await request(server,carrier+'/status',{cookie,data:{active:0}})).status,200);
  assert.equal(s.one('SELECT active FROM master WHERE id=?',id).active,0);
  assert.equal((await request(server,carrier+'/status',{cookie,data:{active:1}})).status,200);
  assert.equal(s.one('SELECT active FROM master WHERE id=?',id).active,1);
  assert.equal((await request(server,carrier+'/delete',{cookie,data:{}})).status,200);
  doc('openingCash',{data:{amount:50,account}});
  const accountDeletion=await request(server,'/api/master/accounts/'+account+'/delete',{cookie,data:{}});
  assert.equal(accountDeletion.status,409);
  assert.match(accountDeletion.json().message,/当前资料已在单据中使用/);
  const partner=add('partners','USED-IN-DOCUMENT','单据供应商',{type:'supplier'});
  doc('purchaseOrder',{partner,lines:[{product:s.one("SELECT id FROM master WHERE kind='products' LIMIT 1").id,quantity:1}]});
  const partnerDeletion=await request(server,'/api/master/partners/'+partner+'/delete',{cookie,data:{}});
  assert.equal(partnerDeletion.status,409);
  assert.match(partnerDeletion.json().message,/当前资料已在单据中使用/);
  const own='/api/master/users/'+user.id;
  assert.equal((await request(server,own+'/status',{cookie,data:{active:0}})).status,400);
  assert.equal((await request(server,own+'/delete',{cookie,data:{}})).status,400);
});

test('超限在保存和审核时被拦截，部分收付款及退货保持库存往来口径',async t=>{
  const {server,supplier,customer,warehouse,account,add,doc,post,move,stock,amount}=fixture(t);
  const cookie=(await request(server,'/api/login',{data:{username:'admin',password:testPassword}})).headers['set-cookie'].split(';')[0];
  const a=add('products','BRIEF-A','商品 A',{unit:'个'});
  const b=add('products','BRIEF-B','商品 B',{unit:'个'});
  const inbound=post(doc('purchase',{partner:supplier,lines:[{product:a,quantity:100,price:10},{product:b,quantity:50,price:20}]}));
  const outgoing=post(doc('sale',{partner:customer,lines:[{product:a,quantity:30,price:15},{product:b,quantity:10,price:30}]}));
  const pay=(value)=>({partner:supplier,data:{reference:inbound.id,account,amount:value}});
  const receive=(value)=>({partner:customer,data:{reference:outgoing.id,account,amount:value}});
  const pendingPayment=move(doc('payment',pay(900)),'submit');
  const pendingReceipt=move(doc('receipt',receive(300)),'submit');
  const pendingSale=move(doc('sale',{partner:customer,lines:[{product:a,quantity:70,price:15}]}),'submit');
  post(doc('payment',pay(1200)));
  post(doc('receipt',receive(500)));
  assert.throws(()=>doc('payment',pay(900)),/当前未结 ¥800\.00/);
  assert.throws(()=>doc('receipt',receive(300)),/当前未结 ¥250\.00/);
  assert.throws(()=>move(pendingPayment,'approve'),/超出未结金额/);
  assert.throws(()=>move(pendingReceipt,'approve'),/超出未结金额/);
  assert.throws(()=>doc('sale',{partner:customer,lines:[{product:a,quantity:50},{product:a,quantity:21}]}),/库存不足/);
  const preview=await request(server,'/api/documents/validate',{cookie,data:{type:'sale',partner:customer,warehouse,lines:[{product:b,quantity:41}]}});
  assert.equal(preview.json().code,'DOCUMENT_LIMIT');
  const valid=await request(server,'/api/documents/validate',{cookie,data:{type:'sale',partner:customer,warehouse,lines:[{product:b,quantity:40}]}});
  assert.deepEqual(valid.json(),{valid:true});
  assert.deepEqual(stock(a),{quantity:70000,value:70000});
  assert.deepEqual(stock(b),{quantity:40000,value:80000});
  assert.equal(amount('ap',supplier),80000);
  assert.equal(amount('ar',customer),25000);
  const returned=post(doc('salesReturn',{partner:customer,data:{reference:outgoing.id},lines:[{product:a,quantity:1,price:15}]}));
  assert.equal(returned.status,'posted');
  assert.throws(()=>doc('salesReturn',{partner:customer,data:{reference:outgoing.id},lines:[{product:a,quantity:30,price:15}]}),/超过关联单据数量/);
  post(doc('purchaseReturn',{partner:supplier,data:{reference:inbound.id},lines:[{product:a,quantity:2,price:10}]}));
  assert.throws(()=>move(pendingSale,'approve'),/库存不足/);
});

test('来源未记账提供跳转数据，重复商品编号返回准确字段，批量删除保持原子性',async t=>{
  const {server,s,user,supplier,product,doc,move}=fixture(t);
  const cookie=(await request(server,'/api/login',{data:{username:'admin',password:testPassword}})).headers['set-cookie'].split(';')[0];
  const lines=[{product,quantity:3,price:10}];
  const order=move(move(doc('purchaseOrder',{partner:supplier,lines}),'submit'),'approve');
  const inbound=move(move(doc('purchase',{partner:supplier,lines,data:{reference:order.id}}),'submit'),'approve');
  const failure=await request(server,'/api/documents/'+inbound.id,{cookie,data:{action:'post'}});
  assert.equal(failure.status,409);
  assert.equal(failure.json().documentId,order.id);
  assert.equal(failure.json().code,'SOURCE_NOT_POSTED');
  assert.equal(failure.json().message,'采购订单 '+order.number+' 尚未记账。');
  assert.equal((await request(server,'/api/documents/'+failure.json().documentId+'?detail=1',{cookie})).json().id,order.id);
  assert.match(failure.json().message,new RegExp(order.number+' 尚未记账'));
  const draft=doc('purchaseOrder',{partner:supplier,lines});
  const bulk=ids=>request(server,'/api/documents/bulk-delete',{cookie,data:{ids}});
  const batch=(ids,action)=>request(server,'/api/documents/bulk-action',{cookie,data:{ids,action}});
  assert.equal((await batch([draft.id,inbound.id],'submit')).status,409);
  assert.equal(getDocument(s,user,draft.id).status,'draft');
  assert.deepEqual((await batch([draft.id],'submit')).json(),{count:1});
  assert.equal(getDocument(s,user,draft.id).status,'pending');
  assert.deepEqual((await batch([draft.id],'approve')).json(),{count:1});
  assert.deepEqual((await batch([draft.id],'unapprove')).json(),{count:1});
  assert.equal((await bulk([draft.id,inbound.id])).status,409);
  assert.equal(getDocument(s,user,draft.id).status,'draft');
  move(inbound,'unapprove');
  assert.deepEqual((await bulk([draft.id,inbound.id])).json(),{count:2});
  const {code}=s.one('SELECT code FROM master WHERE id=?',product);
  const duplicate=await request(server,'/api/master/products',{cookie,data:{code,name:'重复编号'}});
  assert.equal(duplicate.status,409);
  assert.equal(duplicate.json().field,'code');
  assert.equal(duplicate.json().message,'商品编号 '+code+' 已存在');
});

test('演示账套端到端：建档、订单执行、出入库、结算、退货、库存分类和 Excel',async t=>{
  const {server,account,otherWarehouse}=fixture(t);
  const signIn=async username=>(await request(server,'/api/login',{data:{username,password:testPassword}})).headers['set-cookie'].split(';')[0];
  const cookie=await signIn('admin');
  const call=(url,data)=>request(server,url,{cookie,data});
  const ok=async (url,data)=>{
    const response=await call(url,data);
    assert.equal(response.status,200,response.body);
    return response.json();
  };
  const parent=(await ok('/api/product-categories',{action:'create',name:'验收'})).path;
  const child=(await ok('/api/product-categories',{action:'create',parent,name:'器材'})).path;
  const sibling=(await ok('/api/product-categories',{action:'create',name:'验收额外'})).path;
  assert.ok((await ok('/api/product-categories')).paths.includes(child));
  const master=async (kind,code,data={})=>{
    const endpoint='/api/master/'+kind;
    await ok(endpoint,{code,name:code,data});
    return (await ok(endpoint+'?keyword='+code)).rows.find(row=>row.code===code).id;
  };
  const a=await master('products','E2E-A',{category:child,unit:'个'});
  const b=await master('products','E2E-B',{category:parent,unit:'个'});
  const unrelated=await master('products','E2E-C',{category:sibling,unit:'个'});
  const supplier=await master('partners','E2E-SUP',{type:'supplier'});
  const customer=await master('partners','E2E-CUST',{type:'customer'});
  const warehouse=await master('warehouses','E2E-WH');
  const documents='/api/documents';
  const save=(type,fields)=>ok(documents,{type,warehouse,...fields});
  const action=(doc,name)=>ok(documents+'/'+doc.id,{action:name});
  const post=async doc=>{
    for (const name of ['submit','approve','post']) doc=await action(doc,name);
    return doc;
  };
  const line=(product,quantity,price)=>({product,quantity,price});
  const assertExecution=async (doc,state)=>{
    const detail=await ok(documents+'/'+doc.id+'?detail=1');
    assert.equal(detail.execution.state,state);
    const {rows}=await ok(documents+'?type='+doc.type);
    assert.equal(rows.find(row=>row.id===doc.id).executionState,state);
  };
  const buy=[line(a,100,10),line(b,50,20)];
  const sell=[line(a,30,15),line(b,10,30)];
  const order=await post(await save('purchaseOrder',{partner:supplier,lines:buy}));
  await assertExecution(order,'waiting');
  const inbound=await post(await save('purchase',{partner:supplier,data:{reference:order.id},lines:[buy[0]]}));
  await assertExecution(order,'partial');
  await post(await save('purchase',{partner:supplier,data:{reference:order.id},lines:[buy[1]]}));
  await assertExecution(order,'complete');
  const salesOrder=await post(await save('salesOrder',{partner:customer,lines:sell}));
  await assertExecution(salesOrder,'waiting');
  const sale=await post(await save('sale',{partner:customer,data:{reference:salesOrder.id},lines:sell}));
  await assertExecution(salesOrder,'complete');
  const pay={partner:supplier,data:{account,amount:1200}};
  const receive={partner:customer,data:{account,reference:sale.id,amount:500}};
  // A legacy document already approved before the balance changed can still be reversed and deleted.
  const stuck=await save('payment',{...pay,data:{account,amount:900}});
  await action(stuck,'submit');
  await action(stuck,'approve');
  const lateDraft=await save('receipt',{...receive,data:{...receive.data,amount:300}});
  await post(await save('payment',pay));
  await post(await save('receipt',receive));
  const excess=[
    {type:'payment',partner:supplier,data:{account,amount:900}},
    {type:'receipt',partner:customer,data:{account,reference:sale.id,amount:300}},
    {type:'sale',partner:customer,lines:[line(a,71,15)]}
  ];
  for (const payload of excess) for (const path of [documents,documents+'/validate']) {
    const failure=await call(path,{warehouse,...payload});
    assert.equal(failure.status,400);
    assert.equal(failure.json().code,'DOCUMENT_LIMIT');
    assert.equal(failure.json().field,null);
  }
  assert.equal((await call(documents+'/'+lateDraft.id,{action:'submit'})).json().code,'DOCUMENT_LIMIT');
  await ok('/api/master/users',{username:'e2e-clerk',name:'验收制单员',password:testPassword,role:'clerk'});
  const clerk=await signIn('e2e-clerk');
  assert.equal((await request(server,documents+'/'+stuck.id,{cookie:clerk,data:{action:'unapprove'}})).status,403);
  assert.match((await call(documents+'/'+stuck.id,{action:'post'})).json().message,/结算金额超出未结金额/);
  assert.equal((await action(stuck,'unapprove')).status,'draft');
  assert.equal((await action(stuck,'delete')).status,'deleted');
  assert.equal((await call(documents+'/'+sale.id,{action:'unapprove'})).status,409);
  await post(await save('miscIn',{lines:[line(unrelated,5,4)]}));
  await post(await save('miscIn',{warehouse:otherWarehouse,lines:[line(a,2,10)]}));
  const stockPath='/api/report?'+new URLSearchParams({name:'库存状况查询',warehouse:String(warehouse),category:parent});
  const {rows}=await ok(stockPath);
  assert.deepEqual(rows.map(row=>[row[0],row[2],row[8]]),[['E2E-A',70,'700.00'],['E2E-B',40,'800.00']]);
  const workbook=await call(stockPath+'&export=1');
  assert.equal(workbook.status,200);
  assert.deepEqual(readWorkbookRows(workbook.raw,50).slice(1).map(row=>row[0]),['E2E-A','E2E-B']);
  const balances=async()=>Object.fromEntries((await ok('/api/report?'+new URLSearchParams({name:'往来单位应收应付',keyword:'E2E-'}))).rows.map(([name,ar,ap])=>[name,[ar,ap]]));
  assert.deepEqual(await balances(),{'E2E-CUST':['250.00','0.00'],'E2E-SUP':['0.00','800.00']});

  await post(await save('purchaseReturn',{partner:supplier,data:{reference:inbound.id},lines:[line(a,1,10)]}));
  await post(await save('salesReturn',{partner:customer,data:{reference:sale.id},lines:[line(b,1,30)]}));
  for (const [type,partner,reference,items] of [
    ['purchaseReturn',supplier,inbound.id,[line(a,100,10)]],
    ['salesReturn',customer,sale.id,[line(b,10,30)]]
  ]) {
    const error=await call(documents,{type,partner,warehouse,data:{reference},lines:items});
    assert.equal(error.status,400);
    assert.match(error.json().message,/超过关联单据数量/);
  }
  assert.deepEqual((await ok(stockPath)).rows.map(row=>[row[0],row[2],row[8]]),[['E2E-A',69,'690.00'],['E2E-B',41,'820.00']]);
  assert.deepEqual(await balances(),{'E2E-CUST':['220.00','0.00'],'E2E-SUP':['0.00','790.00']});
});

test('静态资源无需登录，重复资料和业务校验统一返回结构化错误',async t=>{
  const {server}=fixture(t);
  const me=await request(server,'/api/me');
  assert.equal(me.status,200);
  assert.deepEqual(me.json(),{user:null});
  const favicon=await request(server,'/favicon.ico');
  assert.equal(favicon.status,200);
  assert.match(favicon.headers['content-type'],/^image\//);
  assert.equal((await request(server,'/document-settings.js')).status,200);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  assert.equal((await request(server,'/favicon.ico',{cookie})).status,200);
  const conflict=async (kind,data,message,code,field)=>{
    const response=await request(server,'/api/master/'+kind,{cookie,data});
    assert.equal(response.status,409);
    assert.deepEqual(response.json(),{error:message,message,code,field});
  };
  await conflict('partners',{code:'S-001',name:'重复'},'往来单位编号 S-001 已存在','DUPLICATE_CODE','code');
  const warehouses=(await request(server,'/api/master/warehouses',{cookie})).json();
  const {code}=warehouses.rows[0];
  await conflict('warehouses',{code,name:'重复'},'仓库编号 '+code+' 已存在','DUPLICATE_CODE','code');
  await conflict('users',{username:'admin',name:'重复',role:'clerk',password:testPassword},'用户名 admin 已存在','DUPLICATE_USERNAME','username');
  const invalid=await request(server,'/api/master/products',{cookie,data:{name:'无编号'}});
  assert.equal(invalid.status,400);
  assert.deepEqual(invalid.json(),{error:'编号和名称为必填项',message:'编号和名称为必填项',code:'REQUEST_FAILED',field:null});
});

test('采购和销售退货选源时，同一请求期间锁定编辑且按源单行去重',async()=>{
  for (const type of ['purchaseReturn','salesReturn']) {
    const editor={type,lines:[{position:99}]};
    const pending=Promise.withResolvers();
    const loading=[];
    let fetched=0;
    const choose=()=>loadDocumentSource(editor,{
      load:()=>{fetched++;return pending.promise;},isCurrent:()=>true,
      setLoading:value=>loading.push(value),apply:source=>{editor.lines=uniqueSourceLines(source);}
    });
    const loadingSource=choose();
    await choose();
    assert.equal(editor.sourceLoading,true);
    assert.deepEqual(loading,[true]);
    assert.equal(fetched,1);
    pending.resolve({lines:[{position:1,product:42,quantity:30},{position:1,product:42,quantity:30},
      {position:2,product:42,quantity:10}]});
    await loadingSource;
    assert.deepEqual(editor.lines.map(line=>line.quantity),[30,10]);
    assert.deepEqual(loading,[true,false]);
    assert.equal(editor.sourceLoading,false);
    await assert.rejects(loadDocumentSource(editor,{
      load:()=>Promise.reject(Error('断网')),isCurrent:()=>true,setLoading:()=>{},
      apply:()=>assert.fail('加载失败时不能覆盖明细')
    }),/断网/);
    assert.equal(editor.sourceLoading,false);
  }
});

test('关联退货快速重复选商品只增加原行数量，保留源单价格和独立批次',()=>{
  for (const type of ['purchaseReturn','salesReturn']) {
    const first={product:42,unit:'盒',quantity:15,price:12,batch:'A'};
    const second={product:42,unit:'个',quantity:2,price:2,batch:'B'};
    const target={quantity:1};
    const editor={type,precision:{quantityDigits:4},reference:{lines:[first,second]},lines:[first,second,target],sourceLoading:true};
    assert.equal(mergeReturnLine(editor,42,1,{target}),true);
    assert.equal(first.quantity,15);
    editor.sourceLoading=false;
    assert.equal(mergeReturnLine(editor,42,1,{target}),true);
    assert.equal(mergeReturnLine(editor,42,1,{target}),true);
    assert.equal(mergeReturnLine(editor,42,1,{target:first}),true);
    assert.equal(mergeReturnLine(editor,42,3,{unit:'个',factors:new Map([['盒',6],['个',1]])}),true);
    assert.deepEqual(editor.lines,[{...first,quantity:17},{...second,quantity:5},target]);
    assert.equal(first.price,12);
    assert.equal(second.batch,'B');
    assert.equal(mergeReturnLine(editor,99,1,{target}),false);
  }
});

test('采购和销售退货的超量预检、保存及审核都失败',async t=>{
  const {server,supplier,customer,warehouse,doc,post,move,add}=fixture(t);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const product=add('products','RET-LIMIT','退货限量',{unit:'个'});
  const inbound=post(doc('purchase',{partner:supplier,lines:[{product,quantity:40,price:5}]}));
  const outbound=post(doc('sale',{partner:customer,lines:[{product,quantity:15,price:8}]}));
  post(doc('miscIn',{lines:[{product,quantity:20,price:5}]}));
  for (const [type,partner,source,available] of [['purchaseReturn',supplier,inbound,40],['salesReturn',customer,outbound,15]]) {
    const payload=quantity=>({type,partner,warehouse,data:{reference:source.id},lines:[{product,quantity,price:5}]});
    const pending=move(doc(type,payload(available)),'submit');
    post(doc(type,payload(1)));
    for (const [path,data] of [
      ['/api/documents/validate',payload(available)],['/api/documents',payload(available)],
      ['/api/documents/'+pending.id,{action:'approve'}]
    ]) {
      const result=await request(server,path,{cookie,data});
      assert.equal(result.status,400,result.body);
      assert.equal(result.json().code,'DOCUMENT_LIMIT');
      assert.match(result.json().message,/超过关联单据数量/);
    }
    const current=await request(server,'/api/documents/'+pending.id,{cookie});
    assert.equal(current.json().status,'pending');
  }
});

test('登录前后页面引用的静态资源及其模块依赖全部可加载',async t=>{
  const {server}=fixture(t);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  for (const session of [undefined,cookie]) {
    const page=await request(server,'/',{cookie:session});
    assert.equal(page.status,200);
    const paths=new Set([...page.body.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(match=>match[1]));
    for (const path of paths) {
      const response=await request(server,path,{cookie:session});
      assert.equal(response.status,200,path);
      if (!path.endsWith('.js')) continue;
      assert.match(response.headers['content-type'],/javascript/);
      for (const [,file] of response.body.matchAll(/\bfrom\s+['"]\.\/([^'"]+)['"]/g)) paths.add('/'+file);
    }
    assert.equal(paths.has('/document-source.js'),false);
  }
});

test('收付款和预收预付单校验启用账户，系统保存可选默认账户',async t=>{
  const {server,s,account,supplier,customer,warehouse,doc,post}=fixture(t);
  post(doc('openingAR',{partner:customer,data:{amount:100}}));
  post(doc('openingAP',{partner:supplier,data:{amount:100}}));
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const call=(url,data)=>request(server,url,{cookie,data});
  const settings=(await call('/api/system-settings')).json();
  assert.equal(settings.defaultSettlementAccount,null);
  assert.equal((await call('/api/system-settings',{...settings,defaultSettlementAccount:99999})).status,400);
  assert.equal((await call('/api/system-settings',{...settings,defaultSettlementAccount:account})).json().defaultSettlementAccount,account);
  for (const [type,partner] of [['receipt',customer],['payment',supplier],['advanceIn',customer],['advanceOut',supplier]]) {
    const payload={type,partner,warehouse,data:{amount:10}};
    for (const path of ['/api/documents/validate','/api/documents']) {
      const missing=await call(path,payload);
      assert.equal(missing.status,400);
      assert.equal(missing.json().message,'请选择结算账户');
      assert.equal(missing.json().field,'account');
    }
    const actual=await call('/api/documents',{...payload,data:{amount:10,account}});
    assert.equal(actual.status,200,actual.body);
    assert.equal(actual.json().data.account,account);
  }
  s.run('UPDATE master SET active=0 WHERE id=?',account);
  assert.equal((await call('/api/documents',{type:'advanceIn',partner:customer,warehouse,data:{account,amount:20}})).json().code,'SETTLEMENT_ACCOUNT_REQUIRED');
  assert.equal((await call('/api/system-settings',{...settings,defaultSettlementAccount:null})).json().defaultSettlementAccount,null);
});

test('已记账收款和付款红冲恢复资金、往来和源单余额，分录逐笔相反',async t=>{
  const {s,server,user,supplier,customer,account,product,doc,post,move,amount}=fixture(t);
  const purchase=post(doc('purchase',{partner:supplier,lines:[{product,quantity:10,price:40}]}));
  const sale=post(doc('sale',{partner:customer,lines:[{product,quantity:5,price:80}]}));
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const call=(url,data)=>request(server,url,{cookie,data});
  for (const [type,partner,source,category,sign] of [['payment',supplier,purchase,'ap',-1],['receipt',customer,sale,'ar',1]]) {
    const baseline=amount('cash',account);
    const payload=value=>({partner,data:{account,amount:value,reference:source.id}});
    const first=post(doc(type,payload(200)));
    const original=await call('/api/documents/'+source.id+'?detail=1');
    assert.equal(original.json().recordedSettlement,20000);
    assert.equal(original.json().unpaid,20000);
    post(doc(type,payload(200)));
    assert.equal(move(getDocument(s,user,source.id),'settle').status,'settled');
    assert.equal(amount(category,partner),0);
    assert.equal(amount('cash',account),baseline+sign*40000);
    const blocked=await call('/api/documents/bulk-action',{ids:[first.id],action:'unapprove'});
    assert.equal(blocked.status,409);
    assert.equal(blocked.json().message,'已记账单据不能反审核，请使用红冲');
    assert.throws(()=>transition(s,{...user,role:'clerk'},first.id,'reverse'),/没有此操作权限/);
    const reversed=await call('/api/documents/'+first.id,{action:'reverse'});
    assert.equal(reversed.status,200,reversed.body);
    const red=reversed.json();
    assert.match(red.number,/^HC-/);
    assert.equal(red.data.reversalOf,first.id);
    assert.equal(red.total,-20000);
    assert.equal(amount('cash',account),baseline+sign*20000);
    assert.equal(amount(category,partner),20000);
    const current=getDocument(s,user,source.id,true);
    assert.equal(current.status,'posted');
    assert.equal(current.unpaid,20000);
    assert.equal(current.recordedSettlement+current.unpaid,current.total);
    assert.ok(current.relations.some(row=>row.id===red.id));
    assert.equal(getDocument(s,user,first.id).reversedBy.id,red.id);
    for (const table of ['ledger','journal_entries']) {
      const amounts=id=>s.all('SELECT amount FROM '+table+' WHERE doc=? ORDER BY id',id).map(row=>row.amount);
      assert.deepEqual(amounts(red.id),amounts(first.id).map(value=>-value));
    }
    assert.equal((await call('/api/documents/'+first.id,{action:'reverse'})).status,409);
    assert.equal((await call('/api/documents/'+red.id,{action:'reverse'})).status,409);
  }
});

test('预收预付核销不走现金，红冲恢复余额，报表与资金流水勾稽',async t=>{
  const {s,server,user,supplier,customer,account,doc,post,move,amount}=fixture(t);
  const previousDate=new Date(today()+'T12:00:00Z');
  previousDate.setUTCDate(previousDate.getUTCDate()-1);
  const yesterday=previousDate.toISOString().slice(0,10);
  post(doc('openingCash',{date:yesterday,data:{account,amount:500}}));
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const call=(url,data)=>request(server,url,{cookie,data});
  const deposits=[];
  for (const [type,advance,opening,partner,category,sign] of [
    ['receipt','advanceIn','openingAR',customer,'ar',1],
    ['payment','advanceOut','openingAP',supplier,'ap',-1]
  ]) {
    post(doc(opening,{date:yesterday,partner,data:{amount:75}}));
    const source=post(doc(opening,{partner,data:{amount:100}}));
    const cashBefore=amount('cash',account);
    const deposit=post(doc(advance,{partner,data:{account,amount:100}}));
    deposits.push({deposit,advance,partner,sign});
    const applied=post(doc(type,{partner,data:{account,amount:100,useAdvance:true,reference:source.id}}));
    assert.equal(amount(advance,partner),0);
    assert.equal(amount(category,partner),7500);
    assert.equal(amount('cash',account),cashBefore+sign*10000);
    assert.equal(getDocument(s,user,source.id).status,'settled');
    assert.throws(()=>move(deposit,'reverse'),/请先红冲核销单/);
    assert.throws(()=>doc(type,{partner,data:{account,amount:1,useAdvance:true}}),/必须选择源单/);
    const reverse=move(applied,'reverse');
    assert.equal(reverse.data.useAdvance,true);
    assert.equal(getDocument(s,user,source.id).status,'posted');
    assert.equal(getDocument(s,user,source.id).unpaid,10000);
    assert.equal(amount(advance,partner),10000);
    assert.equal(amount('cash',account),cashBefore+sign*10000);
  }
  const operations=Object.fromEntries(report(s,user,'经营报告',{from:today()}).sections[0].values);
  assert.equal(operations['收款金额'],'0.00');
  assert.equal(operations['付款金额'],'0.00');
  assert.equal(operations['预收金额'],'100.00');
  assert.equal(operations['预付金额'],'100.00');
  const accountRows=(await call('/api/master/accounts')).json().rows;
  assert.equal(accountRows.find(row=>row.id===account).balance,50000);
  const balances=report(s,user,'往来单位应收应付',{});
  assert.deepEqual(balances.totalRow,['合计','175.00','175.00','100.00','100.00']);
  for (const index of [1,2,3,4])
    assert.equal(Number(balances.totalRow[index]),balances.rows.reduce((sum,row)=>sum+Number(row[index]),0));
  const statement=report(s,user,'对账',{from:today(),partner:customer});
  assert.deepEqual(statement.summary.rows.find(row=>row[1]==='应收').slice(2),['175.00','100.00','100.00','175.00']);
  for (const row of statement.summary.rows)
    assert.equal(Number(row[2])+Number(row[3])-Number(row[4]),Number(row[5]));
  const excel=await call('/api/report?'+new URLSearchParams({name:'往来单位应收应付',export:'1'}));
  assert.deepEqual(readWorkbookRows(excel.raw,50).at(-1),balances.totalRow);
  const reconciliation=await call('/api/report?'+new URLSearchParams({name:'对账',from:today(),partner:customer,export:'1'}));
  assert.deepEqual(readWorkbookRows(reconciliation.raw,50)[0],statement.summary.columns);
  for (const {deposit,advance,partner,sign} of deposits) {
    const cashBefore=amount('cash',account);
    assert.equal(move(deposit,'reverse').data.reversalOf,deposit.id);
    assert.equal(amount(advance,partner),0);
    assert.equal(amount('cash',account),cashBefore-sign*10000);
  }
  assert.equal(amount('cash',account),50000);
});

test('采购入库和销售出库金额、随单结算、筛选合计及 Excel 一致',async t=>{
  const {server,s,user,doc,post,amount,supplier,customer,account,warehouse,add}=fixture(t);
  const product=add('products','TRADE-TAX','测试税率商品',{unit:'件',taxRate:13});
  const lines=[{product,quantity:10,price:30,discount:0.9}];
  const terms={warehouse,lines,data:{reduction:5,account,paid:100}};
  const amountCheck={baseAmount:30000,net:27000,tax:3510,gross:30510,total:30010};
  assert.throws(()=>doc('purchase',{...terms,partner:supplier,amountCheck:{...amountCheck,tax:3500}}),/与服务器计算结果不一致/);
  const purchase=post(doc('purchase',{...terms,partner:supplier,amountCheck}));
  assert.equal(purchase.lines[0].data.tax,13);
  assert.equal(purchase.tradeAmounts.gross,30510);
  assert.equal(purchase.tradeAmounts.settled,10000);
  assert.equal(purchase.tradeAmounts.outstanding,20010);
  assert.equal(amount('ap',supplier),20010);
  const sale=post(doc('sale',{...terms,partner:customer,amountCheck}));
  assert.equal(sale.tradeAmounts.outstanding,20010);
  assert.equal(amount('ar',customer),20010);
  const related=getDocument(s,user,sale.id,true).relations;
  assert.ok(related.some(row=>row.type==='receipt'&&row.status==='posted'));
  const payment=getDocument(s,user,purchase.id,true).relations.find(row=>row.type==='payment');
  assert.equal(getDocument(s,user,payment.id).total,10000);
  assert.equal(report(s,user,'经营报告',{}).sections[2].values.find(([key])=>key==='优惠金额')[1],'10.00');
  assert.deepEqual(s.all('SELECT doc FROM journal_entries GROUP BY doc HAVING SUM(amount)<>0'),[]);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const filtered=(await request(server,'/api/documents?minAmount=300.10&maxAmount=300.10',{cookie})).json();
  assert.equal(filtered.count,2);
  assert.equal(filtered.totals.quantity,20);
  assert.equal(filtered.totals.gross,61020);
  assert.equal(filtered.totals.reduction,1000);
  assert.equal(filtered.totals.settled,20000);
  assert.equal(filtered.totals.outstanding,40020);
  const workbook=await request(server,'/api/documents?type=purchase&minAmount=300.10&maxAmount=300.10&export=1',{cookie});
  const rows=readWorkbookRows(workbook.raw,50);
  assert.ok(rows.some(row=>row[0]===purchase.number&&row[2]?.startsWith('TRADE-TAX ')&&row[10]==='270.00'&&row[12]==='35.10'&&row[14]==='305.10'));
  assert.ok(rows.some(row=>row[0]==='合计'&&row[10]==='100.00'&&row[11]==='200.10'));
});

test('采购和销售退货生成退款单并可红冲，存量无税率折扣数据保留金额',t=>{
  const {s,user,doc,post,move,amount,supplier,customer,product,account}=fixture(t);
  const line={product,quantity:10,price:30};
  const purchase=post(doc('purchase',{partner:supplier,lines:[line]}));
  const sale=post(doc('sale',{partner:customer,lines:[line]}));
  s.run("UPDATE lines SET data=json_remove(data,'$.tax','$.discount','$.unitPrice') WHERE doc=?",sale.id);
  const legacy=getDocument(s,user,sale.id);
  assert.equal(legacy.total,30000);
  assert.equal(legacy.tradeAmounts.gross,30000);
  assert.equal(legacy.tradeAmounts.baseAmount,30000);
  assert.equal(legacy.tradeAmounts.tax,0);

  for (const [type,partner,source,category,refundType] of [
    ['salesReturn',customer,sale,'ar','payment'],
    ['purchaseReturn',supplier,purchase,'ap','receipt']
  ]) {
    const start=amount('cash',account);
    const returned=post(doc(type,{partner,data:{reference:source.id,account,paid:20},lines:[{...line,quantity:2}]}));
    assert.equal(returned.tradeAmounts.settled,2000);
    assert.equal(returned.tradeAmounts.outstanding,4000);
    assert.equal(amount(category,partner),26000);
    assert.equal(amount('cash',account),start+(refundType==='receipt'?2000:-2000));
    const child=getDocument(s,user,returned.id,true).relations.find(row=>row.type===refundType);
    move(child,'reverse');
    assert.equal(getDocument(s,user,returned.id).tradeAmounts.settled,0);
    assert.equal(amount(category,partner),24000);
    assert.equal(amount('cash',account),start);
  }
});

test('含税单价依税率和折扣反算，兼容含税和未税录入模式',async ()=>{
  const {priceFromTradeGross,tradeLine}=await import('../public/system-settings.js');
  for (const taxInclusive of [false,true]) {
    const input=priceFromTradeGross(30.51,0.9,13,taxInclusive);
    const amounts=tradeLine(10,input,0.9,13,taxInclusive);
    assert.ok(Math.abs(amounts.unit-30)<1e-9);
    assert.equal(amounts.net,27000);
    assert.equal(amounts.tax,3510);
    assert.equal(amounts.gross,30510);
  }
});

test('采购入库与销售出库按 ¥60.02 保存和结算，忽略未选商品行', async t=>{
  const {server,doc,post,supplier,customer,account,add}=fixture(t);
  const {tradeLineRow,tradeTotalRow,tradeSettlementRows,priceFromTradeGrossInput}=await import('../public/system-settings.js');
  const product=add('products','QA-1117S-P2','验收商品',{unit:'件',taxRate:13,barcode:'690000000002'});
  const amountCheck={baseAmount:6000,net:5400,tax:702,gross:6102,total:6002};
  const price=priceFromTradeGrossInput({key:'grossAmount',value:61.02},2,0.9,13,false);
  assert.ok(Math.abs(price-30)<1e-9);
  assert.equal(priceFromTradeGrossInput({key:'grossAmount',value:61.02},0,0.9,13,false),null);
  const lines=[{quantity:1},{product,quantity:2,price,discount:0.9,tax:'',source:'手工'},{product:''}];
  assert.throws(()=>doc('purchase',{partner:supplier,lines,amountCheck,data:{reduction:1,paid:60.02}}),/请选择本次收付款账户/);
  const login=await request(server,'/api/login',{data:{username:'admin',password:testPassword}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const settings=(await request(server,'/api/system-settings',{cookie})).json();
  const saved=await request(server,'/api/system-settings',{cookie,data:{...settings,defaultSettlementAccount:account}});
  assert.equal(saved.json().defaultSettlementAccount,account);
  for (const [type,partner] of [['purchase',supplier],['sale',customer]]) {
    const draft=doc(type,{partner,lines,data:{reduction:1},amountCheck});
    assert.equal(draft.lines.length,1);
    assert.equal(draft.lines[0].position,1);
    assert.equal(draft.lines[0].data.tax,13);
    const row=tradeLineRow(draft.lines[0],draft.data);
    assert.deepEqual(row.slice(2,14),['690000000002',2,'件','30.00','60.00','90%','27.00','54.00',13,'7.02','30.51','61.02']);
    assert.equal(tradeTotalRow(draft.tradeAmounts)[13],'61.02');
    assert.equal(new Map(tradeSettlementRows(draft,()=>null)).get('本单未结金额'),'60.02');
    const full=post(doc(type,{id:draft.id,revision:draft.data.revision,partner,lines,data:{reduction:1,paid:60.02},amountCheck}));
    assert.equal(full.data.account,account);
    assert.equal(full.tradeAmounts.settled,6002);
    assert.equal(full.tradeAmounts.outstanding,0);
  }
});
