import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createApp} from '../src/server.js';
import {saveDocument} from '../src/engine.js';
import {saveOpening} from '../src/opening.js';
import {openingState} from '../src/opening-state.js';
import {listPrintTemplates,savePrintTemplate,changePrintTemplate,savePrintAsset,exportPrintTemplate,importPrintTemplate,
  preparePrint,recordPrint,getPrintTemplate} from '../src/print-templates.js';
import {defaultPrintTemplate,paginatePrint,renderPrintPages,uppercaseRmb,evaluatePrintExpression,validatePrintTemplate} from '../public/print-layout.js';
import {fitPrintPaper,alignPrintElements} from '../public/print-designer.js';
import {qrMatrix} from '../public/print-qr.js';
import {permits} from '../public/permissions.js';
import {readWorkbookRows} from '../src/xlsx-import.js';

const password='Print-Template-2026';
function request(server,url,{data,cookie}={}) {
  const req=Readable.from(data===undefined?[]:[Buffer.from(JSON.stringify(data))]);
  Object.assign(req,{url,method:data===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},socket:{remoteAddress:'test'}});
  return new Promise(resolve=>{
    const headers={};const response={headersSent:false,status:200,
      setHeader:(key,value)=>{headers[key.toLowerCase()]=value;},
      writeHead:(status,items)=>{response.status=status;response.headersSent=true;for(const [key,value] of Object.entries(items))response.setHeader(key,value);},
      end:raw=>resolve({status:response.status,headers,raw,json:()=>JSON.parse(raw)})};
    server.emit('request',req,response);
  });
}
function fixture(t) {
  const {server,store:s}=createApp({password,demo:true});t.after(()=>s.db.close());
  const user=s.one("SELECT * FROM users WHERE role='admin'");
  const id=code=>s.one('SELECT id FROM master WHERE code=?',code).id;
  saveOpening(s,user,'stock',{revision:openingState(s).revision,warehouse:id('WH-01'),rows:[{id:id('P-1001'),quantity:100,price:20}]});
  const doc=saveDocument(s,user,{type:'sale',partner:id('C-001'),warehouse:id('WH-01'),
    lines:Array.from({length:30},()=>({product:id('P-1001'),quantity:1,price:10,tax:13}))});
  return {s,server,user,doc};
}
test('每类单据有默认模板，设计复制、重命名、默认删除保护和版本冲突',t=>{
  const {s,user}=fixture(t);
  const all=listPrintTemplates(s,user);
  assert.equal(new Set(all.map(row=>row.doc_type)).size,all.length);
  for(const value of all)validatePrintTemplate(value);
  const source=all.find(row=>row.doc_type==='sale');
  assert.throws(()=>changePrintTemplate(s,user,source.id,{action:'delete',revision:source.revision}),/默认模板不能删除/);
  const copy=changePrintTemplate(s,user,source.id,{action:'copy',name:'销售自定义'});
  assert.deepEqual(copy.layout,source.layout);
  const named=savePrintTemplate(s,user,{...copy,name:'重新命名'});
  assert.throws(()=>savePrintTemplate(s,user,{...copy,name:'旧版本'}),/已被其他人修改/);
  const restored=changePrintTemplate(s,user,named.id,{action:'restore',revision:named.revision});
  assert.deepEqual(restored.layout,defaultPrintTemplate('sale').layout);
  const chosen=changePrintTemplate(s,user,restored.id,{action:'default',revision:restored.revision});
  assert.equal(chosen.is_default,true);
  assert.equal(listPrintTemplates(s,user,'sale').filter(row=>row.is_default).length,1);
  const old=getPrintTemplate(s,user,source.id);
  changePrintTemplate(s,user,old.id,{action:'delete',revision:old.revision});
  assert.equal(listPrintTemplates(s,user,'sale').length,1);
});

test('241×140 模板含 Logo、列顺序和隐藏税额，30 行分 3 页并正确小计总计大写',t=>{
  const {s,user,doc}=fixture(t);
  const source=listPrintTemplates(s,user,'sale')[0];
  const value={...structuredClone(source),id:undefined,name:'三等分销售单',is_default:false};
  fitPrintPaper(value,{preset:'241×140',width:241,height:140,orientation:'portrait',margin:{top:5,right:5,bottom:5,left:5}});
  value.layout.table.rowsPerPage=10;
  const [first]=value.layout.table.columns.splice(2,1);value.layout.table.columns.splice(1,0,first);
  value.layout.table.columns.push({key:'tax',title:'税额',width:12,visible:false,decimals:2});
  const image=savePrintAsset(s,user,{content:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgXQAAAAASUVORK5CYII='});
  value.layout.elements.push({id:'logo',kind:'image',band:'header',asset:image.id,x:0,y:0,w:10,h:10});
  const saved=savePrintTemplate(s,user,value);
  const prepared=preparePrint(s,user,{ids:[doc.id],templateId:saved.id})[0];
  assert.equal(prepared.pages.length,3);
  assert.deepEqual(prepared.pages.map(page=>page.rows.length),[10,10,10]);
  assert.deepEqual(prepared.pages.map(page=>page.subtotal.gross),[113,113,113]);
  assert.equal(prepared.pages[2].totals.gross,339);
  assert.equal(prepared.pages[2].fields.uppercase,'叁佰叁拾玖元整');
  const preview=renderPrintPages(saved,prepared.data,{preview:true});
  assert.equal((preview.match(/class="pt-page"/g)||[]).length,3);
  assert.equal((preview.match(/本页小计/g)||[]).length,3);
  assert.equal((preview.match(/>合计<\/div>/g)||[]).length,1);
  assert.ok(!preview.includes('<th>税额</th>'));
  assert.ok(preview.includes('/api/print-assets/'+image.id));
  value.layout.background=image.id;value.layout.overlay=true;
  const overlay=renderPrintPages(value,prepared.data,{preview:false});
  assert.ok(!overlay.includes('class="pt-background"'));
  assert.ok(renderPrintPages(value,prepared.data,{preview:true}).includes('class="pt-background"'));
});

test('模板 JSON 携图片导出导入完全一致，拒绝恶意表达式和布局',t=>{
  const {s,user}=fixture(t);
  let copy=changePrintTemplate(s,user,listPrintTemplates(s,user,'sale')[0].id,{action:'copy',name:'可导入模板'});
  const image=savePrintAsset(s,user,{content:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgXQAAAAASUVORK5CYII='});
  copy.layout.elements.push({id:'portable-logo',kind:'image',band:'header',asset:image.id,x:0,y:0,w:8,h:8});
  copy=savePrintTemplate(s,user,copy);
  const bundle=exportPrintTemplate(s,user,copy.id);
  assert.deepEqual(exportPrintTemplate(s,user,importPrintTemplate(s,user,bundle).id),bundle);
  changePrintTemplate(s,user,copy.id,{action:'delete',revision:copy.revision});
  const imported=importPrintTemplate(s,user,bundle);
  assert.deepEqual(exportPrintTemplate(s,user,imported.id),bundle);
  const target=fixture(t);
  const moved=importPrintTemplate(target.s,target.user,bundle);
  assert.deepEqual(exportPrintTemplate(target.s,target.user,moved.id),bundle);
  assert.equal(target.s.one('SELECT count(*) count FROM print_assets').count,1);
  const corrupt=structuredClone(bundle);corrupt.assets[0].id='0'.repeat(64);
  assert.throws(()=>importPrintTemplate(target.s,target.user,corrupt),/图片校验失败/);
  assert.equal(target.s.one('SELECT count(*) count FROM print_assets').count,1);
  const invalid=structuredClone(bundle);
  invalid.template.layout.elements[0].id='"><script>';
  assert.throws(()=>importPrintTemplate(s,user,{...invalid,replace:true}),/元素无效/);
  assert.equal(evaluatePrintExpression('{含税金额}-{整单优惠}',{gross:339,reduction:5}),334);
  assert.throws(()=>evaluatePrintExpression('globalThis.process.exit()',{}),/仅支持/);
  assert.equal(uppercaseRmb(100010001),'壹佰万零壹佰元零壹分');
  assert.throws(()=>validatePrintTemplate({...imported,layout:{...imported.layout,version:2}}),/模板版本/);
});

test('打印、重复打印和设计权限独立，打印次数幂等，审核限制和批量分页',t=>{
  const {s,user,doc}=fixture(t);
  const template=listPrintTemplates(s,user,'sale')[0];
  const clerk={...user,role:'clerk',permissions:{'d:sale':['view','print']}};
  assert.equal(permits(clerk,'m:templates','design'),false);
  assert.throws(()=>savePrintTemplate(s,clerk,defaultPrintTemplate('sale')),/没有打印模板设计权限/);
  const input={ids:[doc.id],templateId:template.id,requestId:'print-test-0001'};
  recordPrint(s,clerk,input);
  recordPrint(s,clerk,input);
  assert.equal(s.one('SELECT COUNT(*) count FROM print_jobs WHERE doc=?',doc.id).count,1);
  assert.throws(()=>recordPrint(s,clerk,{...input,requestId:'print-test-0002'}),/重复打印权限/);
  const allowed={...clerk,permissions:{'d:sale':['view','print','reprint']}};
  recordPrint(s,allowed,{...input,requestId:'print-test-0002'});
  assert.equal(preparePrint(s,user,{ids:[doc.id]})[0].data.fields.printCount,2);
  const requireApproved=savePrintTemplate(s,user,{...template,layout:{...template.layout,requireApproved:true}});
  assert.throws(()=>preparePrint(s,user,{ids:[doc.id],templateId:requireApproved.id}),/未审核单据/);
  assert.equal(preparePrint(s,user,{ids:[doc.id],templateId:requireApproved.id},{enforce:false}).length,1);
  assert.equal(s.one('SELECT COUNT(*) count FROM print_jobs WHERE doc=?',doc.id).count,2);
});

test('打印预览、Excel 和图片接口经过权限检查，静态设计器可加载',async t=>{
  const {server,s,user,doc}=fixture(t);
  const login=await request(server,'/api/login',{data:{username:'admin',password}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const call=(url,data)=>request(server,url,{data,cookie});
  const template=listPrintTemplates(s,user,'sale')[0];
  const configured=savePrintTemplate(s,user,{...template,layout:{...template.layout,table:{...template.layout.table,rowsPerPage:10}}});
  assert.equal((await request(server,'/print-designer.js')).status,200);
  const preview=await call('/api/print/preview',{ids:[doc.id],templates:{sale:configured.id}});
  assert.equal(preview.status,200);
  assert.equal(preview.json().documents[0].pages.length,3);
  const excel=await call('/api/print/excel',{ids:[doc.id],templates:{sale:configured.id}});
  assert.equal(excel.status,200);
  const rows=readWorkbookRows(excel.raw,100);
  assert.equal(rows.filter(row=>row[0]==='本页小计').length,3);
  assert.equal(rows.find(row=>row[0]==='大写金额')[1],'叁佰叁拾玖元整');
  const commit=await call('/api/print/commit',{ids:[doc.id],templates:{sale:configured.id},requestId:'browser-print-0001'});
  assert.equal(commit.status,200);
  assert.equal((await call('/api/print/preview',{ids:[doc.id],templates:{sale:configured.id}})).json().documents[0].data.fields.printCount,1);
  assert.equal((await call('/api/print-assets',{content:Buffer.from('<svg onload="alert(1)">').toString('base64')})).status,400);
  const bad=structuredClone(configured);bad.layout.table.rowsPerPage=500;
  assert.equal((await call('/api/print-templates',bad)).status,400);
  const invalidBundle=exportPrintTemplate(s,user,configured.id);invalidBundle.template.layout.version=99;
  const invalidImport=await call('/api/print-templates/import',invalidBundle);
  assert.equal(invalidImport.status,400);
  assert.match(invalidImport.json().message,/模板版本/);
});

test('设计器多选对齐、等距和二维码矩阵具备有效结构',()=>{
  const elements=[{id:'a',x:0,y:0,w:5,h:5},{id:'b',x:10,y:2,w:5,h:5},{id:'c',x:30,y:4,w:5,h:5}];
  const ids=new Set(['a','b','c']);
  alignPrintElements(elements,ids,'top');assert.deepEqual(elements.map(el=>el.y),[0,0,0]);
  alignPrintElements(elements,ids,'horizontal');assert.deepEqual(elements.map(el=>el.x),[0,15,30]);
  const matrix=qrMatrix('XS-20261119-00001');
  assert.equal(matrix.length,21);
  assert.equal(matrix[0].slice(0,7).filter(Boolean).length,7);
  assert.equal(matrix[3][3],true);
  assert.equal(matrix[8][13],true);
  assert.throws(()=>qrMatrix('a'.repeat(107)),/106/);
});


test('批量打印按每单所选模板分页，失败不写入部分记录，实时读取往来欠款',t=>{
  const {s,user,doc}=fixture(t);
  const purchase=saveDocument(s,user,{type:'purchase',partner:s.one("SELECT id FROM master WHERE code='S-001'").id,
    warehouse:doc.warehouse,lines:[{product:doc.lines[0].product,quantity:2,price:15}]});
  const saleTemplate=listPrintTemplates(s,user,'sale')[0];
  const configured=savePrintTemplate(s,user,{...saleTemplate,layout:{...saleTemplate.layout,table:{...saleTemplate.layout.table,rowsPerPage:10}}});
  const purchaseTemplate=listPrintTemplates(s,user,'purchase')[0];
  const input={ids:[doc.id,purchase.id],templates:{sale:configured.id,purchase:purchaseTemplate.id},requestId:'batch-test-0001'};
  const prepared=preparePrint(s,user,input);
  assert.deepEqual(prepared.map(row=>row.pages.length),[3,1]);
  assert.deepEqual(prepared.map(row=>row.template.id),[configured.id,purchaseTemplate.id]);
  const limited={...user,role:'clerk',permissions:{'d:sale':['view','print'],'d:purchase':['view']}};
  assert.throws(()=>recordPrint(s,limited,input),/没有单据打印权限/);
  assert.equal(s.one('SELECT count(*) count FROM print_jobs').count,0);
  recordPrint(s,user,input);
  assert.equal(s.one('SELECT count(*) count FROM print_jobs').count,2);
  assert.equal(preparePrint(s,user,input)[0].data.fields.printCount,1);
  s.run("INSERT INTO ledger(doc,entity,category,amount,reference,date) VALUES(?,?,'ar',?,?,?)",doc.id,doc.partner,43210,doc.id,doc.date);
  assert.equal(preparePrint(s,user,input)[0].data.fields.balance,432.1);
});
