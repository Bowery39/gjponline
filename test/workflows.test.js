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
