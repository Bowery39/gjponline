import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPrintTemplate,validatePrintTemplate,renderPrintPages,shapePrintStyle,printBands} from '../public/print-layout.js';
import {fitPrintPaper,createPrintElement,numberInput,renderPrintElementProperties} from '../public/print-designer.js';
import {editorNumber,elementsOverlap,updatePrintElement,updatePrintPagination,createTemplateSaver,createPrintToast,printDropPosition,bindPrintFieldDrag,bindPrintCanvasDrop,exportPrintDesign} from '../public/print-editor.js';

test('数字任意步进，任意有限小数可录入，失败不改变原设计或其他待录值',()=>{
  assert.match(numberInput('x',12.345),/step="any"/);
  assert.equal(editorNumber('13.019','X'),13.019);
  const original=defaultPrintTemplate('sale'),snapshot=structuredClone(original);
  const raw={x:'12.015',y:'-1',w:'81.1',h:'8',fontSize:'9.21',text:'尚未保存的修改'};
  assert.throws(()=>updatePrintElement(original,'no',raw),error=>error.field==='y'&&/Y 坐标/.test(error.message));
  assert.deepEqual(original,snapshot);assert.equal(raw.text,'尚未保存的修改');assert.equal(raw.w,'81.1');
  raw.y='10.015';const next=updatePrintElement(original,'no',raw);
  validatePrintTemplate(next);assert.equal(next.layout.elements.find(el=>el.id==='no').x,12.015);
  assert.equal(next.layout.elements.find(el=>el.id==='no').fontSize,9.21);
  for(const value of ['',NaN,Infinity,'abc'])assert.throws(()=>editorNumber(value,'边距'),/边距/);
  const paging={...original.layout.bands,rowsPerPage:'1.5',rowHeight:6,headerHeight:7,grid:2};
  assert.throws(()=>updatePrintPagination(original,paging),/每页行数须为整数/);assert.deepEqual(original,snapshot);
});

test('纸张适配舍入到0.1mm，标题编号顺序不变且不重叠，区域扩展后仍能分页',()=>{
  const value=defaultPrintTemplate('sale');
  fitPrintPaper(value,{preset:'241×140',width:241,height:140,orientation:'landscape',margin:{top:5,right:5,bottom:5,left:5}},{keepFontSize:true});
  for(const el of value.layout.elements)for(const key of ['x','y','w','h'])assert.ok(Math.abs(el[key]*10-Math.round(el[key]*10))<1e-8);
  for(const band of printBands)assert.ok(Math.abs(value.layout.bands[band]*10-Math.round(value.layout.bands[band]*10))<1e-8);
  const title=value.layout.elements.find(el=>el.id==='title'),number=value.layout.elements.find(el=>el.id==='no');
  assert.ok(number.y>=title.y+title.h);assert.equal(elementsOverlap(title,number),false);
  for(const band of printBands){const items=value.layout.elements.filter(el=>el.band===band&&el.id!=='sign');
    for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)assert.equal(elementsOverlap(items[i],items[j]),false,items[i].id+' overlaps '+items[j].id);
  }
  value.layout.table.rowsPerPage=10;validatePrintTemplate(value);
  const bad=defaultPrintTemplate('sale'),before=structuredClone(bad);
  assert.throws(()=>fitPrintPaper(bad,{...bad.paper,height:50,margin:{top:0,right:0,bottom:0,left:0}},{keepFontSize:true}),/纸张/);
  assert.deepEqual(bad,before);
});

test('连续插入按网格换行，不产生重叠，区域放满明确提示并保留原行',()=>{
  const value=defaultPrintTemplate('sale');value.layout.elements=[];value.layout.bands.header=70;
  let anchor;
  for(let i=0;i<25;i++){
    const element=createPrintElement(value,'text',{band:'header',anchor});
    for(const previous of value.layout.elements)assert.equal(elementsOverlap(element,previous),false);
    assert.equal(element.x%2,0);assert.equal(element.y%2,0);value.layout.elements.push(element);anchor=element;
  }
  assert.ok(new Set(value.layout.elements.map(el=>el.y)).size>1);
  const full=defaultPrintTemplate('sale');full.layout.elements=[{id:'filled',kind:'text',band:'header',x:0,y:0,w:190,h:30}];
  const before=structuredClone(full);
  assert.throws(()=>createPrintElement(full,'text',{band:'header'}),/放满/);assert.deepEqual(full,before);
});

test('图形属性只显示尺寸和描边，设计与打印使用同一线宽线型颜色并严格校验',()=>{
  for(const kind of ['rect','line']){
    const el={id:'shape',kind,band:'header',x:0,y:0,w:20,h:5,lineWidth:0.35,lineStyle:'dashed',color:'#225588'};
    const html=renderPrintElementProperties(el);
    for(const field of ['x','y','w','h','lineWidth','lineStyle','color'])assert.ok(html.includes('name="'+field+'"'));
    for(const field of ['font','fontSize','decimals','align','dateFormat'])assert.ok(!html.includes('name="'+field+'"'));
    const value=defaultPrintTemplate('sale');value.layout.elements=[el];validatePrintTemplate(value);
    assert.match(shapePrintStyle(el),/0.35mm dashed #225588/);
    assert.ok(renderPrintPages(value,{fields:{total:0},lines:[]}).includes('0.35mm dashed #225588'));
    el.color='red;position:fixed';assert.throws(()=>validatePrintTemplate(value),/颜色/);
  }
});

test('串行保存只携带最新revision/version，慢请求不丢修改，409保留原输入并停止自动覆盖',async()=>{
  const received=[];let release,active=0,maxActive=0;
  const persist=createTemplateSaver(async(path,input,binary,method)=>{
    active++;maxActive=Math.max(maxActive,active);received.push({path,input,method});
    if(received.length===1)await new Promise(resolve=>{release=resolve;});
    active--;return {...input,revision:input.revision+1,version:input.revision+1};
  });
  const draft={id:12,revision:3,layout:{text:'first'}};
  const first=persist(draft);const second=persist({...draft,layout:{text:'second'}});await new Promise(resolve=>setImmediate(resolve));
  release();await Promise.all([first,second]);
  assert.equal(maxActive,1);assert.deepEqual(received.map(row=>row.input.revision),[3,4]);
  assert.equal(received[1].input.layout.text,'second');assert.equal(received[1].input.version,4);
  assert.equal(received[0].path,'/api/print-templates/12');assert.equal(received[0].method,'PUT');
  const conflict=createTemplateSaver(async()=>{throw Object.assign(Error('冲突'),{code:'TEMPLATE_VERSION_CONFLICT'});});
  const before=structuredClone(draft);await assert.rejects(conflict(draft),/当前修改已保留/);assert.deepEqual(draft,before);
});

test('保存轻提示2秒消失，连续提示复用一个节点且不阻塞',()=>{
  const timers=new Map(),body=[],delays=[];let id=0;
  const doc={createElement(){return {setAttribute(){},remove(){this.isConnected=false;const index=body.indexOf(this);if(index>=0)body.splice(index,1);}};},
    body:{append(node){node.isConnected=true;body.push(node);}}};
  const toast=createPrintToast(doc,{schedule(callback,delay){const key=++id;timers.set(key,callback);delays.push(delay);return key;},cancel:key=>timers.delete(key)});
  assert.equal(toast('已保存'),undefined);toast('预览已就绪');
  assert.equal(body.length,1);assert.equal(body[0].textContent,'预览已就绪');assert.equal(timers.size,1);assert.deepEqual(delays,[2000,2000]);
  timers.values().next().value();assert.equal(body.length,0);
});

function event(type,values={}){return Object.assign(new Event(type,{cancelable:true}),values);}
test('HTML5工具箱拖放和鼠标pointer拖放都落在画布正确位置，取消不插入，原生拖放不重复',()=>{
  const button=new EventTarget(),doc=new EventTarget();button.textContent='单据编号';
  const region={dataset:{band:'header'},getBoundingClientRect:()=>({left:100,top:50})};
  doc.elementFromPoint=()=>({closest:()=>region});doc.createElement=()=>({style:{},remove(){}});doc.body={append(){}};
  const inserted=[];const onDrop=(key,band,point)=>inserted.push({key,band:band.dataset.band,...printDropPosition(band.getBoundingClientRect(),point,1)});
  bindPrintFieldDrag(button,{key:'number',ownerDocument:doc,onDrop});
  const transfer={setData(key,value){this[key]=value;},getData(key){return this[key]||'';}};
  button.dispatchEvent(event('pointerdown',{button:0,pointerType:'mouse',clientX:10,clientY:10}));
  button.dispatchEvent(event('dragstart',{dataTransfer:transfer}));
  const canvas={};bindPrintCanvasDrop(canvas,{onDrop});
  canvas.ondrop({preventDefault(){},dataTransfer:transfer,target:{closest:()=>region},clientX:137.79527559,clientY:87.79527559});
  doc.dispatchEvent(event('pointerup',{clientX:137.79527559,clientY:87.79527559}));
  assert.equal(inserted.length,1);assert.equal(inserted[0].x,10);assert.equal(inserted[0].y,10);
  button.dispatchEvent(event('pointerdown',{button:0,pointerType:'mouse',clientX:10,clientY:10}));
  doc.dispatchEvent(event('pointermove',{clientX:175.59055118,clientY:125.59055118}));
  doc.dispatchEvent(event('pointerup',{clientX:175.59055118,clientY:125.59055118}));
  assert.equal(inserted.length,2);assert.equal(inserted[1].x,20);assert.equal(inserted[1].y,20);
  button.dispatchEvent(event('pointerdown',{button:0,pointerType:'mouse',clientX:10,clientY:10}));doc.dispatchEvent(event('pointercancel'));
  assert.equal(inserted.length,2);
});


test('版本冲突后可直接导出未保存设计及新增图片，不再次触发保存请求',async()=>{
  const value=defaultPrintTemplate('sale');value.name='冲突后的未保存模板';
  value.layout.elements.push({id:'new-image',kind:'image',band:'header',x:0,y:0,w:10,h:10,asset:'a'.repeat(64)});
  const loaded=[];const bundle=await exportPrintDesign(value,async id=>{loaded.push(id);return{id,mime:'image/png',content:'image-data'};});
  assert.equal(bundle.template.name,'冲突后的未保存模板');assert.deepEqual(bundle.template.layout,value.layout);
  assert.deepEqual(loaded,['a'.repeat(64)]);assert.equal(bundle.assets[0].content,'image-data');
  bundle.template.layout.elements[0].x=999;assert.equal(value.layout.elements[0].x,0);
});
