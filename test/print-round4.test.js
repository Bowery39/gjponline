import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {defaultPrintTemplate,validatePrintTemplate,paginatePrint,renderPrintPages} from '../public/print-layout.js';
import {fitPrintPaper,selectPrintPaper,insertPrintElementWithSpace,suggestTallerPrintPaper,shrinkPrintBand} from '../public/print-designer.js';
import {createPrintSavePreparation,createTemplateSaver,createPrintTrace,elementsOverlap} from '../public/print-editor.js';
import {createApp} from '../src/server.js';
import {latestPrintDocumentId} from '../src/print-templates.js';
import {saveDocument} from '../src/engine.js';

function denseTemplate(){
  const value=defaultPrintTemplate('purchase');
  fitPrintPaper(value,{...selectPrintPaper(value.paper,{preset:'241×140'}),margin:{top:5,right:5,bottom:5,left:5}},{keepFontSize:true});
  value.layout.elements.push({id:'body-bottom',kind:'text',band:'body',text:'底部文字',x:0,y:value.layout.bands.body-7,w:60,h:7,fontSize:10});
  for(let i=0;i<8;i++)value.layout.elements.push({id:'many-'+i,kind:'text',band:'footer',text:'附加信息'+i,x:0,y:0,w:60,h:5,fontSize:10});
  value.layout.elements.push({id:'hidden-tall',kind:'text',band:'footer',text:'隐藏项不占高度',x:0,y:900,w:80,h:80,fontSize:10,visible:false});
  validatePrintTemplate(value);return value;
}
test('元素密集241×140改A4使用新纸张尺寸，收紧空白并忽略隐藏元素高度',()=>{
  const value=denseTemplate();const a4=selectPrintPaper(value.paper,{preset:'A4'});
  assert.doesNotThrow(()=>fitPrintPaper(value,a4,{keepFontSize:true}));
  assert.deepEqual([value.paper.width,value.paper.height],[210,297]);
  assert.ok(Object.values(value.layout.bands).reduce((sum,n)=>sum+n,0)<=287.01);validatePrintTemplate(value);
  const visible=value.layout.elements.filter(el=>el.visible!==false);
  for(let i=0;i<visible.length;i++)for(let j=i+1;j<visible.length;j++)if(visible[i].band===visible[j].band)assert.equal(elementsOverlap(visible[i],visible[j]),false);
  const data={fields:{total:0},lines:[]};assert.ok(!renderPrintPages(value,data).includes('隐藏项不占高度'));
});
function fullPaper(){
  const value=defaultPrintTemplate('purchase');value.paper={preset:'241×140',width:241,height:140,orientation:'landscape',margin:{top:5,right:5,bottom:5,left:5}};
  value.layout.bands={pageHeader:0,header:40,body:60,footer:30,pageFooter:0};value.layout.elements=['header','body','footer'].map((band,index)=>({id:band,kind:'text',band,text:'满区域',x:0,y:0,w:231,h:[40,60,30][index],fontSize:12}));return value;
}
test('自动扩展不足给出区域需要/可用高度和三个可操作分支，失败保持原数据',()=>{
  const source=fullPaper(),before=structuredClone(source);let failure;
  assert.throws(()=>insertPrintElementWithSpace(source,'qr',{band:'header'},'expand'),error=>{failure=error;return error.code==='PRINT_HEIGHT_INSUFFICIENT';});
  assert.equal(failure.band,'header');assert.ok(failure.requiredHeight>failure.availableHeight);
  assert.match(failure.message,/表头需要 \d+(\.\d+)?mm，剩余可用/);assert.equal(failure.paperHeight,140);
  assert.deepEqual(failure.actions,['taller','next','shrink']);assert.ok(failure.neededPaperHeight>140);
  const taller=suggestTallerPrintPaper(source,failure);assert.ok(taller.height>=failure.neededPaperHeight);
  assert.doesNotThrow(()=>{const copy=structuredClone(source);fitPrintPaper(copy,taller,{keepFontSize:true});});
  assert.throws(()=>insertPrintElementWithSpace(source,'qr',{band:'header'},'next'),/没有可用区域/);
  const smaller=shrinkPrintBand(source,'header');assert.ok(smaller.layout.elements.find(el=>el.id==='header').fontSize<12);
  assert.deepEqual(source,before);
});
test('apply已完成的布局直接复用快照保存，不再重排或重复规范化，单次PUT小于1秒',async()=>{
  const value=denseTemplate();fitPrintPaper(value,selectPrintPaper(value.paper,{preset:'A4'}));value.id=1;value.revision=3;
  const preparation=createPrintSavePreparation();preparation.accept(value);const before=structuredClone(value);
  const started=performance.now(),candidate=preparation.prepare(value);let puts=0;
  const save=createTemplateSaver(async(_path,input)=>{puts++;return {...input,revision:4};});save.remember(value);
  await save(candidate);assert.equal(puts,1);assert.equal(preparation.stats().builds,0);
  assert.deepEqual(value,before);assert.ok(performance.now()-started<1000);
  preparation.invalidate();preparation.prepare(value);assert.equal(preparation.stats().builds,1);
});
test('前端保存与预览分阶段耗时日志可区分准备、网络队列和DOM更新',async()=>{
  let clock=0;const logs=[];const trace=createPrintTrace('template_save',{clock:()=>clock,report:entry=>logs.push(entry)});
  trace.sync('prepare_ms',()=>{clock+=5;});await trace.run('queue_http_ms',async()=>{clock+=7;});trace.sync('update_dom_ms',()=>{clock+=2;});trace.finish({status:200});
  assert.equal(logs[0].event,'print_client');assert.equal(logs[0].total_ms,14);assert.deepEqual(logs[0].stages,{prepare_ms:5,queue_http_ms:7,update_dom_ms:2});
});
test('A4预览复用一次分页结果，渲染不再读取明细重新分页',()=>{
  const value=defaultPrintTemplate('purchase'),data={fields:{total:300},lines:Array.from({length:100},(_,i)=>({index:i+1,name:'商品',quantity:1,gross:3}))};
  const preparedPages=paginatePrint(value,data),expected=renderPrintPages(value,data,{pageIndex:0});
  Object.defineProperty(data,'lines',{get(){throw Error('重复读取明细计算');}});
  assert.equal(renderPrintPages(value,data,{pageIndex:0,preparedPages}),expected);
});
function request(server,url,{data,cookie,method}={}){
  const req=Readable.from(data===undefined?[]:[Buffer.from(JSON.stringify(data))]);Object.assign(req,{url,method:method||(data===undefined?'GET':'POST'),headers:{cookie,'content-type':'application/json'},socket:{remoteAddress:'round4-test'}});
  return new Promise(resolve=>{const headers={};const res={headersSent:false,setHeader(key,value){headers[key.toLowerCase()]=value;},writeHead(status,h){this.status=status;this.headersSent=true;for(const [key,value]of Object.entries(h))this.setHeader(key,value);},end(raw){resolve({status:this.status,headers,raw,json:()=>JSON.parse(raw)});}};server.emit('request',req,res);});
}
test('A4采购预览单接口取得最新有权单据，精简响应与普通预览一致，PUT有分阶段日志',async t=>{
  const logs=[],password='Round4-Print-2026',app=createApp({password,demo:true,printTimingLogger:entry=>logs.push(entry)});t.after(()=>app.store.db.close());
  const {server,store:s}=app,user=s.one("SELECT * FROM users WHERE role='admin'"),id=code=>s.one('SELECT id FROM master WHERE code=?',code).id;
  const doc=saveDocument(s,user,{type:'purchase',partner:id('S-001'),warehouse:id('WH-01'),lines:Array.from({length:100},()=>({product:id('P-1001'),quantity:1,price:3}))});
  const login=await request(server,'/api/login',{data:{username:'admin',password}}),cookie=login.headers['set-cookie'].split(';')[0];
  const started=performance.now(),compact=await request(server,'/api/print/preview',{cookie,data:{latestType:'purchase',compact:true,includeTemplates:false}});
  assert.equal(compact.status,200);assert.ok(performance.now()-started<2000);
  assert.equal(compact.json().documents[0].data.id,doc.id);assert.equal(compact.json().documents[0].template.paper.preset,'A4');assert.equal(compact.json().templates,undefined);assert.equal(compact.json().documents[0].pages,undefined);
  const standard=await request(server,'/api/print/preview',{cookie,data:{ids:[doc.id]}});assert.equal(standard.status,200);
  assert.equal(compact.json().documents[0].data.lines.length,standard.json().documents[0].data.lines.length);assert.ok(Buffer.byteLength(compact.raw)<Buffer.byteLength(standard.raw));
  const template=compact.json().documents[0].template;template.name='采购A4测试';
  const put=await request(server,'/api/print-templates/'+template.id,{cookie,method:'PUT',data:template});assert.equal(put.status,200);
  assert.match(put.headers['server-timing'],/body_ms;dur=/);assert.match(put.headers['server-timing'],/save_ms;dur=/);
  const log=logs.find(row=>row.method==='PUT');for(const key of ['body_ms','save_ms','serialize_ms'])assert.ok(Number.isFinite(log.stages[key]));
  assert.throws(()=>latestPrintDocumentId(s,{...user,role:'clerk',permissions:{'d:purchase':[]}},'purchase'),/权限/);
  const restricted={...user,role:'clerk',warehouses:JSON.stringify([id('WH-02')])};assert.throws(()=>latestPrintDocumentId(s,restricted,'purchase'),/请先保存/);
});


test('版本号从package.json统一读取，登录前首页及公共接口一致',async t=>{
  const app=createApp({password:'Round4-Version-2026'});t.after(()=>app.store.db.close());
  const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
  const page=await request(app.server,'/');assert.equal(page.status,200);assert.ok(String(page.raw).includes('name="application-version" content="'+version+'"'));assert.ok(!String(page.raw).includes('__APP_VERSION__'));
  const info=await request(app.server,'/api/version');assert.equal(info.status,200);assert.equal(info.json().version,version);
});
