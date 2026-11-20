import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePrintTemplate,defaultPrintTemplate,validatePrintTemplate,printBands,renderPrintPages,printSymbolCacheInfo} from '../public/print-layout.js';
import {fitPrintPaper,insertPrintElementWithSpace,createPrintElement} from '../public/print-designer.js';
import {createTemplateSaver,elementsOverlap,bindPrintFieldDrag,bindPrintCanvasDrop,createPrintToast} from '../public/print-editor.js';

test('历史模板与保存数据规范化为0.1，拆分旧签字标签且不修改原对象',()=>{
  const value=defaultPrintTemplate('sale');
  value.layout.elements=value.layout.elements.filter(el=>!['sign-audit','sign-recipient'].includes(el.id));
  Object.assign(value.layout.elements.find(el=>el.id==='sign'),{text:'制单：                         审核：                         收货人：',w:190});
  Object.assign(value.layout.elements[0],{x:21.599999999999998,y:1.23456,w:100.4444,h:8.3333,fontSize:12.345,lineWidth:0.01});
  value.layout.bands.header=30.6666667;
  const original=structuredClone(value),normal=normalizePrintTemplate(value);
  assert.deepEqual(value,original);
  assert.deepEqual(['x','y','w','h','fontSize','lineWidth'].map(key=>normal.layout.elements[0][key]),[21.6,1.2,100.4,8.3,12.3,0.1]);
  assert.equal(normal.layout.bands.header,30.7);
  assert.equal(normal.layout.elements.find(el=>el.id==='sign').text,'制单：');
  assert.ok(normal.layout.elements.some(el=>el.id==='sign-audit'));
  assert.deepEqual(normalizePrintTemplate(normal),normal);
});

test('纸张适配整理所有元素：签字审核字段与二维码不相交，不再跳过sign或装饰图形',()=>{
  const value=defaultPrintTemplate('sale');
  Object.assign(value.layout.elements.find(el=>el.id==='sign'),{x:76,y:31.2});
  Object.assign(value.layout.elements.find(el=>el.id==='reviewer'),{x:76,y:31.2});
  value.layout.elements.push({id:'qr-test',kind:'qr',key:'number',band:'footer',x:76,y:31.2,w:20,h:20});
  fitPrintPaper(value,value.paper,{keepFontSize:true});
  const footer=value.layout.elements.filter(el=>el.band==='footer');
  for(let i=0;i<footer.length;i++)for(let j=i+1;j<footer.length;j++)assert.equal(elementsOverlap(footer[i],footer[j]),false,footer[i].id+'/'+footer[j].id);
  assert.ok(value.layout.bands.footer>40);validatePrintTemplate(value);
  assert.ok(printBands.reduce((sum,key)=>sum+value.layout.bands[key],0)<=277);
});

test('409版本冲突自动GET并三方合并重试一次，保留远程独立修改与本地修改',async()=>{
  const base={...defaultPrintTemplate('sale'),id:9,revision:3,version:3};
  const local=structuredClone(base);local.layout.elements.find(el=>el.id==='no').x=7.777;
  const remote=structuredClone(base);remote.revision=8;remote.layout.elements.find(el=>el.id==='date').fontSize=15;
  remote.layout.elements.push({id:'remote-note',kind:'text',text:'远程新增',band:'header',x:0,y:28,w:20,h:1});
  const calls=[],messages=[];
  const save=createTemplateSaver(async(path,payload)=>{
    calls.push({path,payload});if(!payload)return remote;
    if(calls.length===1)throw Object.assign(Error('版本已更新'),{status:409,code:'TEMPLATE_VERSION_CONFLICT'});
    return {...payload,revision:9,version:9};
  },{onRetry:message=>messages.push(message)});
  save.remember(base);
  const result=await save(local);
  assert.equal(calls.length,3);assert.equal(calls[2].payload.revision,8);assert.equal(messages.length,1);
  assert.equal(result.layout.elements.find(el=>el.id==='no').x,7.8);
  assert.equal(result.layout.elements.find(el=>el.id==='date').fontSize,15);
  assert.ok(result.layout.elements.some(el=>el.id==='remote-note'));
  assert.equal(local.revision,3);assert.equal(local.layout.elements.find(el=>el.id==='no').x,7.777);
});

test('自动与手动保存共用队列，不覆盖先前保存的独立字段，重试次数有界且重名不误重试',async()=>{
  const base={id:9,revision:3,name:'模板',paper:{width:100},layout:{version:1,elements:[],bands:{}}};
  let current=structuredClone(base),active=0,max=0;
  const save=createTemplateSaver(async(_path,payload)=>{active++;max=Math.max(max,active);await new Promise(resolve=>setImmediate(resolve));current={...payload,revision:payload.revision+1};active--;return current;});
  save.remember(base);
  await Promise.all([save({...base,name:'自动保存名称'}),save({...base,paper:{width:120}})]);
  assert.equal(max,1);assert.equal(current.name,'自动保存名称');assert.equal(current.paper.width,120);assert.equal(current.revision,5);
  for(const code of ['TEMPLATE_VERSION_CONFLICT','TEMPLATE_NAME_CONFLICT']){
    let puts=0,gets=0;
    const failing=createTemplateSaver(async(_path,payload)=>{if(!payload){gets++;return {...base,revision:8};}puts++;throw Object.assign(Error('冲突'),{status:409,code});});
    failing.remember(base);await assert.rejects(failing(base));
    assert.equal(puts,code==='TEMPLATE_VERSION_CONFLICT'?2:1);assert.equal(gets,code==='TEMPLATE_VERSION_CONFLICT'?1:0);
  }
});

function event(type,values={}){return Object.assign(new Event(type,{cancelable:true}),values);}
test('全部插入工具支持HTML5和pointer拖放，落点为元素位置，原有字段MIME不变',()=>{
  for(const kind of ['text','line','rect','barcode','qr','image','page','time','expression']){
    const button=new EventTarget(),doc=new EventTarget(),inserted=[];
    const region={dataset:{band:'body'}};doc.elementFromPoint=()=>({closest:()=>region});doc.createElement=()=>({style:{},remove(){}});doc.body={append(){}};
    const drop=(key,band,point)=>{const source=defaultPrintTemplate('sale');source.layout.elements=[];inserted.push(createPrintElement(source,key.replace('element:',''),{band:band.dataset.band,position:point}));};
    bindPrintFieldDrag(button,{key:kind,mime:'application/x-print-element',ownerDocument:doc,onDrop:(key,band,point)=>drop('element:'+key,band,point)});
    assert.equal(button.draggable,true);
    const transfer={setData(key,value){this[key]=value;},getData(key){return this[key]||'';}};
    button.dispatchEvent(event('dragstart',{dataTransfer:transfer}));
    const canvas={};bindPrintCanvasDrop(canvas,{onDrop:drop});canvas.ondrop({preventDefault(){},dataTransfer:transfer,target:{closest:()=>region},clientX:31,clientY:41});
    assert.equal(inserted[0].kind,kind);assert.deepEqual([inserted[0].x,inserted[0].y],[31,41]);
    button.dispatchEvent(event('pointerdown',{button:0,pointerType:'mouse',clientX:1,clientY:1}));
    doc.dispatchEvent(event('pointermove',{clientX:50,clientY:60}));doc.dispatchEvent(event('pointerup',{clientX:50,clientY:60}));
    assert.equal(inserted.length,2);assert.deepEqual([inserted[1].x,inserted[1].y],[50,60]);
    assert.equal(transfer.getData('application/x-print-field'),'');
  }
});

test('区域放满可选择扩展或下一可用区域，保持原模板不变',()=>{
  const value=defaultPrintTemplate('sale');value.layout.elements=[{id:'filled',kind:'text',band:'header',x:0,y:0,w:190,h:30,text:'占满'}];
  const before=structuredClone(value);
  const expanded=insertPrintElementWithSpace(value,'text',{band:'header'},'expand');
  assert.ok(expanded.value.layout.bands.header>30);assert.equal(expanded.element.band,'header');
  assert.equal(elementsOverlap(expanded.value.layout.elements[0],expanded.element),false);
  const moved=insertPrintElementWithSpace(value,'text',{band:'header'},'next');assert.equal(moved.element.band,'body');
  assert.deepEqual(value,before);
});

test('重复翻页预览复用条码二维码缓存，缓存有界',()=>{
  const value=defaultPrintTemplate('sale');value.layout.elements=[{id:'q',kind:'qr',key:'number',band:'header',x:0,y:0,w:20,h:20},{id:'b',kind:'barcode',key:'number',band:'header',x:30,y:0,w:50,h:15}];
  const data={fields:{number:'XS-R3-CACHE-TEST',total:0},lines:[]};
  const before=printSymbolCacheInfo().builds;
  const first=renderPrintPages(value,data);for(let i=0;i<20;i++)assert.equal(renderPrintPages(value,data),first);
  assert.equal(printSymbolCacheInfo().builds-before,2);assert.ok(printSymbolCacheInfo().size<=256);
});


test('应用纸张后立即保存的连续toast正确绑定浏览器计时器上下文，不产生Illegal invocation',()=>{
  let removed=0,cancelled=0;const doc={createElement(){return{setAttribute(){},remove(){removed++;this.isConnected=false;}};},body:{append(node){node.isConnected=true;}}};
  const toast=createPrintToast(doc,{schedule:()=>1,cancel:function(timer){assert.equal(this,globalThis);assert.equal(timer,1);cancelled++;}});
  assert.doesNotThrow(()=>{toast('纸张已应用到草稿');toast('打印模板已保存');});
  assert.equal(cancelled,1);assert.equal(removed,0);
});
