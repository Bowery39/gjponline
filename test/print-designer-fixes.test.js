import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPrintTemplate,renderPrintPages,validatePrintTemplate} from '../public/print-layout.js';
import {fitPrintPaper,selectPrintPaper,createPrintElement,createPrintTaskRunner} from '../public/print-designer.js';
import {buildPrintDocument,printTemplateDocuments} from '../public/print-output.js';

function printFixture(count=30) {
  const template=defaultPrintTemplate('sale');
  const paper=selectPrintPaper({...template.paper,margin:{top:5,right:5,bottom:5,left:5}},{preset:'241×140'});
  fitPrintPaper(template,paper);template.layout.table.rowsPerPage=10;
  const data={fields:{number:'XS-20261119-00001',documentName:'销售出库单',total:339,companyName:'模板打印测试公司'},
    lines:Array.from({length:count},(_,i)=>({index:i+1,code:'A001',name:'测试商品',unit:'件',quantity:1,unitPrice:10,baseAmount:10,net:10,tax:1.3,gross:11.3}))};
  return {template,data};
}
test('打印文档隔离应用样式，241×140 精确页尺寸和边距，批量连续输出真实分页',()=>{
  const first=printFixture();
  const second=printFixture(1);second.data.fields.number='XS-20261119-00002';
  fitPrintPaper(second.template,selectPrintPaper(second.template.paper,{preset:'A5'}));
  const html=buildPrintDocument([first,second]);
  assert.match(html,/@page\{size:241mm 140mm;margin:5mm 5mm 5mm 5mm;/);
  assert.match(html,/@page ptJob1\{size:148mm 210mm;/);
  assert.equal((html.match(/class="pt-page pt-sheet-0"/g)||[]).length,3);
  assert.equal((html.match(/class="pt-page pt-sheet-1"/g)||[]).length,1);
  assert.match(html,/page:ptJob0/);assert.match(html,/page:ptJob1/);
  assert.match(html,/page-break-after:always/);assert.match(html,/break-after:page/);
  assert.match(html,/width:231mm;height:130mm/);
  assert.match(html,/模板打印测试公司/);assert.match(html,/叁佰叁拾玖元整/);
  assert.match(html,/113\.00/);assert.match(html,/339\.00/);
  assert.doesNotMatch(html,/<link|app\.js|style\.css|display:none|visibility:hidden|pt-background/);
  const screen=renderPrintPages(first.template,first.data);
  assert.match(screen,/left:5mm;top:5mm/);assert.match(html,/left:0mm;top:0mm/);
  for(const value of ['测试商品','113.00','339.00','叁佰叁拾玖元整'])assert.ok(screen.includes(value)&&html.includes(value));
});

function fakePrintHost({imageError,onCommitError}={}) {
  const events=[],callbacks={};let frame;
  const ownerDocument={createElement(tag){
    assert.equal(tag,'iframe');
    frame={style:{},setAttribute(){},remove(){events.push('remove');},
      contentDocument:{fonts:{ready:Promise.resolve()},images:[{async decode(){events.push('image');if(imageError)throw Error('image failed');}}]},
      contentWindow:{addEventListener(name,callback){callbacks[name]=callback;},focus(){events.push('focus');},print(){events.push('frame-print');}}};
    return frame;
  },body:{append(node){events.push('append');queueMicrotask(()=>node.onload());}}};
  return {ownerDocument,events,callbacks,getFrame:()=>frame,onReady:async()=>{events.push('commit');if(onCommitError)throw Error('没有重复打印权限');}};
}
test('打印及 PDF 使用独立 iframe，等图片字体就绪和计数提交成功后才调用目标打印',async()=>{
  const host=fakePrintHost();
  await printTemplateDocuments([printFixture()],host);
  assert.deepEqual(host.events,['append','image','commit','focus','frame-print']);
  assert.match(host.getFrame().srcdoc,/@page\{size:241mm 140mm/);
  assert.match(host.getFrame().srcdoc,/测试商品/);
  assert.equal(host.getFrame().title,'模板打印文档');
  host.callbacks.afterprint();assert.equal(host.events.at(-1),'remove');
});
test('图片加载失败或打印权限失败时不输出空白页，并清理独立打印文档',async()=>{
  for(const settings of [{imageError:true},{onCommitError:true}]){
    const host=fakePrintHost(settings);
    await assert.rejects(printTemplateDocuments([printFixture()],host));
    assert.ok(!host.events.includes('frame-print'));
    if(settings.imageError)assert.ok(!host.events.includes('commit'));
    assert.equal(host.events.at(-1),'remove');
  }
});

test('所有插入元素在当前区域空白处错开放置，条码绑定单号，图形没有数据绑定',()=>{
  const template=defaultPrintTemplate('sale');template.layout.elements=[];
  let anchor;
  const kinds=['text','line','rect','barcode','qr','image','page','time','expression'];
  for(const kind of kinds){
    const element=createPrintElement(template,kind,{band:'body',anchor});
    assert.equal(element.band,'body');
    assert.ok(element.x>=0&&element.y>=0&&element.x+element.w<=190&&element.y+element.h<=175);
    assert.ok(!template.layout.elements.some(old=>old.x===element.x&&old.y===element.y));
    if(['barcode','qr'].includes(kind))assert.equal(element.key,'number');
    if(['line','rect','text','image','page'].includes(kind))assert.equal(Object.hasOwn(element,'key'),false);
    if(kind==='text')assert.equal(element.text,'固定文本');
    template.layout.elements.push(element);anchor=element;
  }
  validatePrintTemplate(template);
  const visible=createPrintElement(template,'text',{band:'body',viewport:{x:80,y:60,w:100,h:70}});
  assert.ok(visible.x>=80&&visible.y>=60&&visible.x+visible.w<=180&&visible.y+visible.h<=130);
  const drop=createPrintElement(template,'field',{key:'number',band:'header',position:{x:12,y:3}});
  assert.deepEqual([drop.x,drop.y,drop.key],[12,3,'number']);
});

test('纸张预设立即返回宽高和匹配方向，方向切换交换尺寸，自定义宽高自动判断',()=>{
  const initial=defaultPrintTemplate('sale').paper;
  let paper=selectPrintPaper(initial,{preset:'241×140'});
  assert.deepEqual([paper.width,paper.height,paper.orientation],[241,140,'landscape']);
  paper=selectPrintPaper(paper,{orientation:'portrait'});
  assert.deepEqual([paper.width,paper.height,paper.orientation],[140,241,'portrait']);
  paper=selectPrintPaper(paper,{orientation:'landscape'});
  assert.deepEqual([paper.width,paper.height],[241,140]);
  paper=selectPrintPaper(paper,{preset:'A4'});assert.deepEqual([paper.width,paper.height,paper.orientation],[210,297,'portrait']);
  paper=selectPrintPaper(paper,{width:280,height:100});assert.equal(paper.orientation,'landscape');assert.equal(paper.preset,'custom');
  assert.equal(initial.width,210);
  const template=defaultPrintTemplate('sale');template.paper={...template.paper,width:297,height:210,orientation:'portrait'};
  // Keep this legacy layout valid while testing orientation normalization.
  template.layout.bands.body=80;
  assert.equal(validatePrintTemplate(template).paper.orientation,'landscape');
});

test('适配按比例调整区域和位置，正文至少9pt标题至少12pt，保持字号可选且不改变原模板',()=>{
  const template=defaultPrintTemplate('sale'),original=structuredClone(template);
  const paper=selectPrintPaper(template.paper,{preset:'241×140'});
  fitPrintPaper(template,paper);
  const ratio=120/277;
  assert.ok(template.layout.bands.header>=Math.round(original.layout.bands.header*ratio*10)/10); // collision resolution may expand the header
  assert.equal(template.layout.elements[3].x,Math.round(original.layout.elements[3].x*221/190*10)/10);
  for(const element of template.layout.elements)assert.ok(element.fontSize>=(['title','company'].includes(element.id)?12:9));
  validatePrintTemplate(template);
  const kept=structuredClone(original);fitPrintPaper(kept,paper,{keepFontSize:true});
  assert.deepEqual(kept.layout.elements.map(el=>el.fontSize),original.layout.elements.map(el=>el.fontSize));
  validatePrintTemplate(kept);
  const paperOnly=structuredClone(original);paperOnly.paper=paper;
  assert.deepEqual(paperOnly.layout,original.layout);
  assert.throws(()=>validatePrintTemplate(paperOnly),/高度/);
});

test('模板请求期间控件锁定，连续点击新建或复制仅提交一次，失败后能恢复操作',async()=>{
  const states=[],errors=[];let finish,calls=0;
  const run=createPrintTaskRunner(value=>states.push(value),error=>errors.push(error.message));
  const pending=run(async()=>{calls++;await new Promise(resolve=>{finish=resolve;});return '新建成功';});
  await run(async()=>{calls++;});await run(async()=>{calls++;});
  assert.equal(calls,1);assert.deepEqual(states,[true]);
  finish();assert.equal(await pending,'新建成功');assert.deepEqual(states,[true,false]);
  await run(async()=>{throw Error('复制失败');});assert.deepEqual(errors,['复制失败']);assert.equal(states.at(-1),false);
  await run(async()=>{calls++;});assert.equal(calls,2);
});
