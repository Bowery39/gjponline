import {mm,elementsOverlap,resolvePrintOverlaps,updatePrintElement,createTemplateSaver,createPrintToast,updatePrintPagination,printPaperFromInput,bindPrintFieldDrag,printDropPosition,bindPrintCanvasDrop,exportPrintDesign} from './print-editor.js';
import {printTemplateDocuments} from './print-output.js';
import {families} from './catalog.js';
import {defaultPrintTemplate,validatePrintTemplate,printFields,printLineFields,printBands,paperPresets,escapePrint as esc,
  renderPrintPages,paginatePrint,shapePrintStyle,normalizePrintTemplate} from './print-layout.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const uid=()=>crypto.randomUUID();
const button=(text,action)=>'<button type="button" class="btn"'+(action.startsWith('add-')&&action!=='add-column'?' draggable="true" data-tool-kind="'+action.slice(4)+'"':'')+' data-pt="'+action+'">'+esc(text)+'</button>';
const options=(values,current)=>Object.entries(values).map(([key,label])=>'<option value="'+esc(key)+'"'+(String(current)===key?' selected':'')+'>'+esc(label)+'</option>').join('');
export const numberInput=(name,value,step='any')=>'<input type="number" step="'+step+'" name="'+name+'" value="'+value+'">';
const label=(text,html)=>'<label>'+esc(text)+html+'</label>';
const bands={pageHeader:'页眉（每页）',header:'表头（首页）',body:'表体明细',footer:'表尾（末页）',pageFooter:'页脚（每页）'};
function downloadJson(value,name) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=name+'.json';a.click();URL.revokeObjectURL(url);
}
async function imageUpload(file,api) {
  if(!file||file.size>1_000_000)throw Error('图片最大 1 MB');
  const bytes=new Uint8Array(await file.arrayBuffer());let text='';
  for(const value of bytes)text+=String.fromCharCode(value);
  return api('/api/print-assets',{content:btoa(text)});
}
export function paperOrientation(paper) {return paper.width>paper.height?'landscape':'portrait';}
export function selectPrintPaper(paper,{preset,orientation,width,height}={}) {
  const next=copy(paper);
  if(preset&&paperPresets[preset]){[next.width,next.height]=paperPresets[preset];next.preset=preset;}
  if(width!=null||height!=null){next.width=Number(width??next.width);next.height=Number(height??next.height);next.preset='custom';}
  if(orientation&&orientation!==paperOrientation(next))[next.width,next.height]=[next.height,next.width];
  next.orientation=paperOrientation(next);return next;
}
export function fitPrintPaper(value,paper,{keepFontSize=false}={}) {
  const target=value;value=normalizePrintTemplate(value);paper=copy(paper);
  for(const key of ['width','height'])paper[key]=mm(paper[key]);
  for(const key of Object.keys(paper.margin))paper.margin[key]=mm(paper.margin[key]);
  const previous=value.paper,oldWidth=previous.width-previous.margin.left-previous.margin.right;
  const width=paper.width-paper.margin.left-paper.margin.right,height=paper.height-paper.margin.top-paper.margin.bottom;
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<20||height<50||width>1000||height>1000)throw Error('纸张可打印范围无效，宽度至少20mm、高度至少50mm');
  const scale=height/(previous.height-previous.margin.top-previous.margin.bottom);
  const oldBands={...value.layout.bands};
  const next=Object.fromEntries(printBands.map(band=>[band,oldBands[band]*scale]));
  for(const el of value.layout.elements){
    el.x=el.x/oldWidth*width;el.w=el.w/oldWidth*width;el.y*=scale;el.h*=scale;
    const title=['companyName','documentName'].includes(el.key)||['company','title'].includes(el.id);
    if(!keepFontSize)el.fontSize=Math.max(title?12:9,Math.min(72,(el.fontSize||10)*Math.min(scale,width/oldWidth)));
    if(!['line','rect','image','barcode','qr'].includes(el.kind))el.h=Math.min(next[el.band],Math.max(el.h,(el.fontSize||10)*25.4/72*1.2));
    el.y=Math.max(0,Math.min(el.y,next[el.band]-el.h));
  }
  for(const el of value.layout.elements){for(const key of ['x','y','w','h'])el[key]=Math.max(key==='w'||key==='h'?0.1:0,mm(el[key]));if(el.fontSize!=null)el.fontSize=mm(el.fontSize);}
  for(const band of printBands)next[band]=mm(next[band]);
  for(const column of value.layout.table.columns)column.width=mm(column.width/oldWidth*width);
  const shown=value.layout.table.columns.filter(column=>column.visible!==false),last=shown.at(-1);
  const sum=shown.reduce((total,column)=>total+column.width,0);
  if(last&&sum>width)last.width=mm(last.width-(sum-width));
  value.paper={...paper,orientation:paperOrientation(paper)};value.layout.bands=next;
  resolvePrintOverlaps(value);
  validatePrintTemplate(value);Object.assign(target,value);
}
export function createPrintElement(value,kind,{key,band='header',position,anchor,viewport,id=uid()}={}) {
  const width=value.paper.width-value.paper.margin.left-value.paper.margin.right,height=value.layout.bands[band];
  if(height<1)throw Error('此区域高度为零');
  const sizes={line:[35,0.5],rect:[35,14],image:[25,20],barcode:[45,14],qr:[20,20],page:[40,7]};
  const [w,h]=(sizes[kind]||[35,7]).map((n,i)=>Math.min(n,i?height:width));
  const grid=value.layout.grid||2;
  const clamp=(x,y)=>({x:mm(Math.max(0,Math.min(x,width-w))),y:mm(Math.max(0,Math.min(y,height-h)))});
  const occupied=value.layout.elements.filter(el=>el.band===band);
  if(band==='body')occupied.push({x:0,y:0,w:width,h:value.layout.table.headerHeight});
  const free=point=>!occupied.some(el=>elementsOverlap({...point,w,h},el,0.5));
  const snap=n=>Math.ceil(n/grid)*grid;
  let location=position?clamp(position.x,position.y):null;
  if(!location&&anchor?.band===band){
    for(const point of [clamp(snap(anchor.x+grid),snap(anchor.y+grid)),clamp(snap(anchor.x+anchor.w+grid),snap(anchor.y+grid))])if(free(point)){location=point;break;}
  }
  const search=view=>{
    const maxY=Math.min(height-h,view.y+view.h-h),maxX=Math.min(width-w,view.x+view.w-w);
    for(let y=snap(Math.max(0,view.y));y<=maxY;y+=grid)for(let x=snap(Math.max(0,view.x));x<=maxX;x+=grid){const point=clamp(x,y);if(free(point))return point;}
    return null;
  };
  location??=search(viewport||{x:0,y:0,w:width,h:height});
  location??=search({x:0,y:0,w:width,h:height});
  if(!location)throw Object.assign(Error('当前区域已放满，可自动扩展或放到下一可用区域'),{code:'PRINT_BAND_FULL'});
  return {id,kind,band,...location,w,h,
    ...(['field','barcode','qr'].includes(kind)?{key:key||'number'}:{}),
    ...(kind==='text'?{text:'固定文本'}:{}),...(kind==='expression'?{expression:'{含税金额}-{整单优惠}'}:{}),
    ...(['line','rect'].includes(kind)?{lineWidth:0.2,lineStyle:'solid',color:'#222222'}:{font:'Microsoft YaHei',fontSize:10,wrap:true,decimals:2})};
}
export function insertPrintElementWithSpace(value,kind,options,strategy='expand') {
  const next=copy(value),band=options.band||'header';
  const candidates=strategy==='next'?[...printBands.slice(printBands.indexOf(band)+1),...printBands.slice(0,printBands.indexOf(band))]:[band];
  if(strategy==='expand')next.layout.bands[band]=mm(next.layout.bands[band]+30);
  for(const target of candidates){
    try{
      const element=createPrintElement(next,kind,{key:options.key,band:target});
      next.layout.elements.push(element);
      if(strategy==='expand')resolvePrintOverlaps(next);
      validatePrintTemplate(next);return {value:normalizePrintTemplate(next),element};
    }catch(error){if(strategy!=='next'||error.code!=='PRINT_BAND_FULL')throw error;}
  }
  throw Error('没有可用区域，请增大纸张或调整区域高度后重试');
}
export function createPrintTaskRunner(setBusy,onError) {
  let busy=false;
  return async action=>{
    if(busy)return;busy=true;setBusy(true);
    try{return await action();}catch(error){await onError(error);}finally{busy=false;setBusy(false);}
  };
}
export function alignPrintElements(elements,ids,mode) {
  const selected=elements.filter(el=>ids.has(el.id));
  if(selected.length<2)return;
  const left=Math.min(...selected.map(el=>el.x)),right=Math.max(...selected.map(el=>el.x+el.w));
  const top=Math.min(...selected.map(el=>el.y)),bottom=Math.max(...selected.map(el=>el.y+el.h));
  if(mode==='left')for(const el of selected)el.x=left;
  if(mode==='right')for(const el of selected)el.x=right-el.w;
  if(mode==='top')for(const el of selected)el.y=top;
  if(mode==='bottom')for(const el of selected)el.y=bottom-el.h;
  for(const [axis,size,start,end] of [['x','w',left,right],['y','h',top,bottom]]) {
    if(mode!==(axis==='x'?'horizontal':'vertical')||selected.length<3)continue;
    const sorted=[...selected].sort((a,b)=>a[axis]-b[axis]);
    const gap=(end-start-selected.reduce((sum,el)=>sum+el[size],0))/(selected.length-1);
    let pos=start;for(const el of sorted){el[axis]=pos;pos+=el[size]+gap;}
  }
}
export function renderPrintElementProperties(el,count=1){
    const shape=['line','rect'].includes(el.kind);
    return '<h3>元素属性（已选 '+count+'）</h3><form id="pt-props">'+
      label('区域','<select name="band">'+options(bands,el.band)+'</select>')+
      ['x','y','w','h'].map((key,index)=>label(['X mm','Y mm','宽 mm','高 mm'][index],numberInput(key,mm(el[key])))).join('')+
      (['field','barcode','qr'].includes(el.kind)?label('字段','<select name="key">'+options(printFields,el.key||'number')+'</select>'):'')+
      (el.kind==='text'?label('固定文本','<textarea name="text">'+esc(el.text||'')+'</textarea>'):'')+
      (el.kind==='expression'?label('表达式','<textarea name="expression">'+esc(el.expression||'{含税金额}-{整单优惠}')+'</textarea>'):'')+
      (shape?label('线宽 mm',numberInput('lineWidth',mm(el.lineWidth??0.2)))+
        label('线型','<select name="lineStyle">'+options({solid:'实线',dashed:'虚线',dotted:'点线'},el.lineStyle||'solid')+'</select>')+
        label('颜色','<input type="color" name="color" value="'+esc(el.color||'#222222')+'">'):
      label('字体','<input name="font" value="'+esc(el.font||'Microsoft YaHei')+'">')+label('字号 pt',numberInput('fontSize',mm(el.fontSize||10)))+
      label('对齐','<select name="align">'+options({left:'左',center:'中',right:'右'},el.align||'left')+'</select>')+
      label('小数位',numberInput('decimals',el.decimals??2,'1'))+
      label('日期格式','<select name="dateFormat">'+options(Object.fromEntries(['YYYY-MM-DD','YYYY/MM/DD','YYYY年MM月DD日','YYYY-MM-DD HH:mm'].map(key=>[key,key])),el.dateFormat||'YYYY-MM-DD')+'</select>')+
      [['bold','加粗',el.bold],['border','边框',el.border],['wrap','自动换行',el.wrap!==false],['hideZero','零不显示',el.hideZero],['thousands','千分位',el.thousands],['currency','¥ 符号',el.currency]]
        .map(([key,text,value])=>'<label><input type="checkbox" name="'+key+'"'+(value?' checked':'')+'>'+text+'</label>').join(''))+
      '<button class="btn" type="submit">应用属性</button></form>'+
      (el.kind==='image'?'<label class="btn">上传 Logo / 印章<input type="file" id="pt-image-file" accept="image/png,image/jpeg,image/webp" hidden></label>':'');
}
export async function renderTemplateCenter(host,{api,showError,showSystemPrompt,canDesign}) {
  let type='sale',rows=[],selected=null,draft=null,ids=new Set(),clipboard=[],history=[],cursor=-1,zoom=0.8,dirty=false,busy=false,selectedBand='header';
  const alive=()=>host.isConnected;
  const toast=createPrintToast(),persist=createTemplateSaver(api,{onRetry:message=>toast(message)}),panels=new Map(),latestDocuments=new Map();
  const readPanel=form=>Object.fromEntries([...form.querySelectorAll('[name]')].map(input=>[input.name,input.type==='checkbox'?input.checked:input.value]));
  const watchPanel=(form,key)=>{
    form.noValidate=true;
    const pending=panels.get(key);
    if(pending)for(const input of form.querySelectorAll('[name]'))if(Object.hasOwn(pending,input.name)){if(input.type==='checkbox')input.checked=pending[input.name];else input.value=pending[input.name];}
    const capture=()=>{panels.set(key,readPanel(form));dirty=true;};
    form.addEventListener('input',capture);form.addEventListener('change',capture);
    if(!form.querySelector('.pt-form-error')){const output=document.createElement('output');output.className='pt-form-error';output.setAttribute('aria-live','polite');form.append(output);}
  };
  const panelError=(form,error)=>{form.querySelector('.pt-form-error').textContent=error.message;const input=[...form.querySelectorAll('[name]')].find(input=>input.name===error.field);input?.focus();};
  const applyPanel=(value,key,raw)=>{
    if(key.startsWith('element:'))return updatePrintElement(value,key.slice(8),raw);
    if(key==='pagination')return updatePrintPagination(value,raw);
    const next=copy(value),paper=printPaperFromInput(raw);
    if(raw.fitLayout)fitPrintPaper(next,paper,{keepFontSize:raw.keepFontSize});else next.paper=paper;
    return next;
  };
  const collectPanels=()=>{
    let next=copy(draft);
    for(const [key,raw] of panels)next=applyPanel(next,key,raw);
    validatePrintTemplate(next);return next;
  };
  const refreshPaperPanels=()=>{
    const paper=host.querySelector('#pt-paper-form'),pagination=host.querySelector('#pt-pagination-form');
    for(const key of ['preset','width','height','orientation'])paper.elements[key].value=draft.paper[key];
    for(const key of ['top','right','bottom','left'])paper.elements[key].value=draft.paper.margin[key];
    for(const band of printBands)pagination.elements[band].value=draft.layout.bands[band];
    for(const key of ['rowsPerPage','rowHeight','headerHeight'])pagination.elements[key].value=draft.layout.table[key];
  };
  const remember=()=>{
    const text=JSON.stringify(draft);
    if(history[cursor]===text)return;
    history=history.slice(0,cursor+1);history.push(text);
    if(history.length>80)history.shift();
    cursor=history.length-1;dirty=true;
  };
  const disabledControls=new WeakMap();
  const setBusy=value=>{
    busy=value;host.setAttribute('aria-busy',String(value));
    for(const control of host.querySelectorAll('button,input,select,textarea')){
      if(value){if(!disabledControls.has(control))disabledControls.set(control,control.disabled);control.disabled=true;}
      else if(disabledControls.has(control)){control.disabled=disabledControls.get(control);disabledControls.delete(control);}
    }
  };
  const reportDesignerError=error=>{if(error.code?.startsWith('TEMPLATE_'))return toast(error.message);if(error.code==='PRINT_BAND_FULL'){toast(error.message);showInsertionOptions();return;}return showError(error);};
  const run=createPrintTaskRunner(setBusy,reportDesignerError);
  const act=action=>event=>{if(event?.type==='submit')event.preventDefault();return run(()=>action(event));};
  const draw=()=>{
    if(!alive())return;
    host.innerHTML='<h1>打印模板中心</h1><div class="toolbar">'+label('单据类型','<select id="pt-type">'+options(Object.fromEntries(Object.entries(families).map(([key,value])=>[key,value[0]])),type)+'</select>')+
      button('新建','new')+button('复制','copy')+button('重命名','rename')+button('删除','delete')+button('设为默认','default')+button('恢复系统默认','restore')+
      button('导出 JSON','export')+'<label class="btn">导入 JSON<input type="file" id="pt-import" accept=".json" hidden></label>'+
      '<span class="toolbar-end"></span>'+button('保存模板','save')+button('真实数据预览','preview')+'</div>'+
      '<div class="pt-workspace"><aside class="pt-library"><h3>模板</h3>'+rows.map(row=>'<button class="btn '+(row.id===selected?.id?'primary':'')+'" data-template="'+row.id+'">'+esc(row.name)+(row.is_default?'（默认）':'')+'</button>').join('')+
      '<h3>拖入字段</h3><select id="pt-band">'+options(bands,selectedBand)+'</select><div class="pt-field-library">'+Object.entries(printFields).map(([key,text])=>
        '<button draggable="true" data-field="'+key+'" class="btn">'+text+'</button>').join('')+'</div>'+
      '<h3>插入元素</h3><div class="pt-element-tools">'+Object.entries({text:'固定文本',line:'线条',rect:'矩形框',image:'图片',barcode:'条形码',qr:'二维码',page:'页码',time:'打印时间',expression:'表达式'}).map(([key,text])=>button(text,'add-'+key)).join('')+'</div></aside>'+
      '<main class="pt-design-main"><div class="toolbar">'+button('撤销','undo')+button('重做','redo')+button('复制元素','copy-elements')+button('粘贴','paste')+
      button('左对齐','align-left')+button('右对齐','align-right')+button('顶部对齐','align-top')+button('底部对齐','align-bottom')+
      button('水平等距','align-horizontal')+button('垂直等距','align-vertical')+button('上移图层','up')+button('下移图层','down')+button('删除元素','remove')+
      label('缩放','<select id="pt-zoom">'+options({'0.5':'50%','0.8':'80%','1':'100%','1.25':'125%'},zoom)+'</select>')+'</div>'+
      '<div class="pt-canvas-scroll"><div class="pt-canvas-space"><div id="pt-canvas" tabindex="0" aria-label="打印模板设计画布"></div></div></div></main>'+
      '<aside class="pt-properties"><div id="pt-element-properties"></div><details open><summary>纸张及分页</summary><form id="pt-paper-form">'+
      label('纸张','<select name="preset">'+options({...Object.fromEntries(Object.keys(paperPresets).map(key=>[key,key])) ,custom:'自定义'},draft.paper.preset)+'</select>')+
      label('宽 mm',numberInput('width',draft.paper.width))+label('高 mm',numberInput('height',draft.paper.height))+
      label('方向','<select name="orientation">'+options({portrait:'纵向',landscape:'横向'},draft.paper.orientation)+'</select>')+
      ['top','right','bottom','left'].map((key,index)=>label(['上边距 mm','右边距 mm','下边距 mm','左边距 mm'][index],numberInput(key,draft.paper.margin[key]))).join('')+
      '<label><input type="checkbox" name="fitLayout" checked>适配布局</label><label><input type="checkbox" name="keepFontSize" checked>保持字号</label>'+
      '<p class="note">预设立即更新宽高，点击应用生效。取消适配仅改纸张；缩放字号时正文至少 9pt、标题至少 12pt。换纸后请检查重叠和分页。</p>'+
      '<button class="btn" type="submit">应用纸张设置</button><output id="pt-paper-status" aria-live="polite"></output></form>'+
      '<form id="pt-pagination-form">'+printBands.map(key=>label(bands[key]+' mm',numberInput(key,draft.layout.bands[key]))).join('')+
      label('每页行数（0 自动）',numberInput('rowsPerPage',draft.layout.table.rowsPerPage,'1'))+
      label('行高 mm',numberInput('rowHeight',draft.layout.table.rowHeight))+
      label('列标题高 mm',numberInput('headerHeight',draft.layout.table.headerHeight))+
      label('网格 mm',numberInput('grid',draft.layout.grid||2))+
      [['fillBlank','补空行',draft.layout.table.fillBlank],['subtotal','每页小计',draft.layout.table.subtotal],['total','末页总计',draft.layout.table.total],
        ['snap','网格吸附',draft.layout.snap],['overlay','套打模式',draft.layout.overlay],['requireApproved','未审核禁止打印',draft.layout.requireApproved],['autoSave','打印前自动保存',draft.layout.autoSave]]
        .map(([key,text,value])=>'<label><input type="checkbox" name="'+key+'"'+(value?' checked':'')+'>'+text+'</label>').join('')+
      '<button class="btn" type="submit">应用分页设置</button></form>'+
      '<label class="btn">上传套打底图<input type="file" id="pt-background-file" accept="image/png,image/jpeg,image/webp" hidden></label>'+button('清除底图','clear-background')+'</details>'+
      '<details open><summary>表体列（拖动排序）</summary><div id="pt-columns"></div>'+
      '<select id="pt-add-column">'+options(printLineFields,'name')+'</select>'+button('添加列','add-column')+'</details></aside></div>';
    bind();drawCanvas();drawProperties();drawColumns();setBusy(busy);
  };
  const drawCanvas=()=>{
    const canvas=host.querySelector('#pt-canvas'),p=draft.paper,l=draft.layout,width=p.width-p.margin.left-p.margin.right;
    const totalHeight=p.height*3.779527559*zoom;
    canvas.style.cssText='width:'+p.width+'mm;height:'+p.height+'mm;transform:scale('+zoom+');transform-origin:top left;--pt-grid:'+(l.grid||2)+'mm';
    canvas.parentElement.style.cssText='width:'+p.width*3.779527559*zoom+'px;height:'+totalHeight+'px';
    let y=p.margin.top;
    canvas.innerHTML=(l.background?'<img class="pt-background" alt="" src="/api/print-assets/'+l.background+'">':'')+
      printBands.map(band=>{
        const top=y;y+=l.bands[band];
        const elements=l.elements.filter(el=>el.band===band).map(el=>{
          const text=el.kind==='field'?printFields[el.key]:el.kind==='text'?el.text:el.kind==='expression'?el.expression:
            ({line:'',rect:'',image:'图片',barcode:'▥ 单据编号',qr:'▦ 二维码',page:'第 N 页 / 共 M 页',time:'打印时间'})[el.kind];
          return '<div tabindex="0" data-element="'+el.id+'" class="pt-design-element '+(ids.has(el.id)?'selected':'')+
            '" style="left:'+el.x+'mm;top:'+el.y+'mm;width:'+el.w+'mm;height:'+el.h+'mm;font-family:'+esc(el.font||'Microsoft YaHei')+
            ';font-size:'+(el.fontSize||10)+'pt;font-weight:'+(el.bold?700:400)+';text-align:'+(el.align||'left')+';white-space:'+(el.wrap===false?'nowrap':'pre-wrap')+';'+
            (['line','rect'].includes(el.kind)?shapePrintStyle(el):el.border?'border:0.2mm solid #222;':'')+'">'+
            (el.kind==='image'&&el.asset?'<img alt="" src="/api/print-assets/'+el.asset+'">':esc(text||''))+'</div>';
        }).join('');
        return '<section class="pt-design-band '+(selectedBand===band?'active':'')+'" data-band="'+band+'" style="left:'+p.margin.left+'mm;top:'+top+'mm;width:'+width+'mm;height:'+l.bands[band]+'mm">'+
          '<span class="pt-band-label">'+bands[band]+'</span>'+
          (band==='body'?'<div class="pt-design-table">'+l.table.columns.filter(c=>c.visible!==false).map(c=>'<span style="width:'+c.width+'mm">'+esc(c.title)+'</span>').join('')+'</div>':'')+elements+'</section>';
      }).join('');
    bindPrintCanvasDrop(canvas,{onDrop:dropField,canDrop:()=>!busy,onError:reportDesignerError});
    canvas.onpointerdown=event=>{
      if(busy)return;
      const region=event.target.closest('[data-band]');
      if(region){selectedBand=region.dataset.band;host.querySelector('#pt-band').value=selectedBand;host.querySelectorAll('[data-band]').forEach(node=>node.classList.toggle('active',node.dataset.band===selectedBand));}
      const node=event.target.closest('[data-element]');
      if(!node){ids.clear();drawProperties();return;}
      const id=node.dataset.element;
      if(event.shiftKey||event.ctrlKey||event.metaKey){if(ids.has(id))ids.delete(id);else ids.add(id);}else if(!ids.has(id))ids=new Set([id]);
      host.querySelectorAll('[data-element]').forEach(el=>el.classList.toggle('selected',ids.has(el.dataset.element)));
      drawProperties();
      const selectedElements=l.elements.filter(el=>ids.has(el.id));
      const initial=selectedElements.map(el=>({el,x:el.x,y:el.y}));
      const startX=event.clientX,startY=event.clientY;
      node.setPointerCapture(event.pointerId);
      const move=e=>{
        const dx=(e.clientX-startX)/zoom/3.779527559,dy=(e.clientY-startY)/zoom/3.779527559;
        for(const item of initial){
          const snap=v=>l.snap?Math.round(v/l.grid)*l.grid:v;
          item.el.x=mm(Math.max(0,Math.min(width-item.el.w,snap(item.x+dx))));
          item.el.y=mm(Math.max(0,Math.min(l.bands[item.el.band]-item.el.h,snap(item.y+dy))));
          const element=host.querySelector('[data-element="'+item.el.id+'"]');
          element.style.left=item.el.x+'mm';element.style.top=item.el.y+'mm';
        }
      };
      const end=()=>{node.removeEventListener('pointermove',move);for(const {el} of initial){const pending=panels.get('element:'+el.id);if(pending){pending.x=el.x;pending.y=el.y;}}remember();drawProperties();};
      node.addEventListener('pointermove',move);node.addEventListener('pointerup',end,{once:true});
    };
    canvas.onkeydown=event=>{
      if(event.target.matches('input,textarea,select'))return;
      const control=event.ctrlKey||event.metaKey;
      if(control&&['c','v','z','y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        const key=event.key.toLowerCase();
        if(key==='c')clipboard=copy(l.elements.filter(el=>ids.has(el.id)));
        if(key==='v')paste();
        if(key==='z')undo(event.shiftKey?1:-1);
        if(key==='y')undo(1);
      } else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const distance=event.shiftKey?1:0.2;
        for(const el of l.elements.filter(el=>ids.has(el.id))) {
          const dx=event.key==='ArrowLeft'?-distance:event.key==='ArrowRight'?distance:0;
          const dy=event.key==='ArrowUp'?-distance:event.key==='ArrowDown'?distance:0;
          el.x=mm(Math.max(0,Math.min(width-el.w,el.x+dx)));el.y=mm(Math.max(0,Math.min(l.bands[el.band]-el.h,el.y+dy)));
        }
        remember();drawCanvas();drawProperties();host.querySelector('#pt-canvas').focus();
      } else if(event.key==='Delete'){event.preventDefault();remove();}
    };
  };
  const drawProperties=()=>{
    const el=draft.layout.elements.find(el=>ids.has(el.id)),area=host.querySelector('#pt-element-properties');
    if(!el){area.innerHTML='<h3>元素属性</h3><p>选择元素后编辑，可按 Shift 多选。</p>';return;}
    area.innerHTML=renderPrintElementProperties(el,ids.size);
    const form=area.querySelector('form'),panelKey='element:'+el.id;watchPanel(form,panelKey);
    form.addEventListener('submit',act(async event=>{
      event.preventDefault();
      try{const next=updatePrintElement(draft,el.id,readPanel(form));validatePrintTemplate(next);draft=next;panels.delete(panelKey);
        selectedBand=next.layout.elements.find(item=>item.id===el.id).band;host.querySelector('#pt-band').value=selectedBand;remember();drawCanvas();form.querySelector('.pt-form-error').textContent='';}
      catch(error){panelError(form,error);}
    }));
    area.querySelector('#pt-image-file')?.addEventListener('change',act(async event=>{
      const result=await imageUpload(event.target.files[0],api);draft.layout.elements.find(item=>item.id===el.id).asset=result.id;remember();drawCanvas();
    }));
  };
  const drawColumns=()=>{
    const container=host.querySelector('#pt-columns');
    container.innerHTML=draft.layout.table.columns.map((c,index)=>'<div draggable="true" class="pt-column" data-index="'+index+'">'+
      '<input type="checkbox" data-column="visible"'+(c.visible!==false?' checked':'')+' aria-label="显示'+esc(c.title)+'">'+
      '<span>'+esc(printLineFields[c.key])+'</span><input data-column="title" value="'+esc(c.title)+'" aria-label="列标题">'+
      '<input type="number" step="any" data-column="width" value="'+Number(c.width.toFixed(2))+'" aria-label="列宽 mm">'+
      '<input type="number" step="1" data-column="decimals" value="'+(c.decimals??2)+'" aria-label="列小数位">'+
      '<select data-column="align" aria-label="列对齐">'+options({left:'左对齐',center:'居中',right:'右对齐'},c.align||'left')+'</select>'+
      [['wrap','换行',c.wrap!==false],['hideZero','零不显示',c.hideZero],['thousands','千分位',c.thousands],['currency','¥ 符号',c.currency]].map(([key,title,on])=>'<label><input type="checkbox" data-column="'+key+'"'+(on?' checked':'')+'>'+title+'</label>').join('')+'</div>').join('');
    for(const node of container.children){
      node.addEventListener('dragstart',event=>event.dataTransfer.setData('application/x-print-column',node.dataset.index));
      node.addEventListener('dragover',event=>event.preventDefault());
      node.addEventListener('drop',event=>{
        event.preventDefault();const raw=event.dataTransfer.getData('application/x-print-column');if(raw==='')return;
        const from=Number(raw),to=Number(node.dataset.index),columns=draft.layout.table.columns;
        const [column]=columns.splice(from,1);columns.splice(to,0,column);remember();drawColumns();drawCanvas();
      });
      node.addEventListener('change',event=>{
        const c=draft.layout.table.columns[Number(node.dataset.index)],key=event.target.dataset.column;
        if(!key)return;
        c[key]=['visible','wrap','hideZero','thousands','currency'].includes(key)?event.target.checked:['width','decimals'].includes(key)?Number(event.target.value):event.target.value;
        remember();drawCanvas();
      });
    }
  };
  function dropField(key,region,point){
    if(busy||!host.contains(region))return;
    const tool=key.startsWith('element:')?key.slice(8):null;
    if(tool&&!['text','line','rect','barcode','qr','image','page','time','expression'].includes(tool))return;
    if(!tool&&!Object.hasOwn(printFields,key))return;
    const position=printDropPosition(region.getBoundingClientRect(),point,zoom);
    addElement(tool||'field',tool?'':key,region.dataset.band,position.x,position.y);
  }
  let pendingInsertion;
  function showInsertionOptions(){
    if(!pendingInsertion)return;
    host.querySelector('.pt-insert-options')?.remove();
    const area=document.createElement('div');area.className='pt-insert-options';area.setAttribute('role','group');area.setAttribute('aria-label','区域已满的处理选项');
    for(const [strategy,title] of [['expand','自动扩展当前区域'],['next','放到下一可用区域']]){
      const control=document.createElement('button');control.type='button';control.className='btn';control.textContent=title;
      control.onclick=()=>{try{const result=insertPrintElementWithSpace(draft,pendingInsertion.kind,pendingInsertion,strategy);draft=result.value;ids=new Set([result.element.id]);selectedBand=result.element.band;remember();drawCanvas();drawProperties();refreshPaperPanels();host.querySelector('#pt-band').value=selectedBand;area.remove();toast('已调整并插入元素，尚未保存');}catch(error){toast(error.message);}};
      area.append(control);
    }
    host.querySelector('.pt-design-main > .toolbar').append(area);
  }
  function addElement(kind,key='',band=null,x,y){
    if(draft.layout.elements.length>=200)throw Error('模板元素最多200个');
    band??=selectedBand;selectedBand=band;host.querySelector('#pt-band').value=band;
    const region=host.querySelector('[data-band="'+band+'"]');
    region.scrollIntoView({block:'nearest',inline:'nearest'});
    const bounds=region.getBoundingClientRect(),visible=host.querySelector('.pt-canvas-scroll').getBoundingClientRect(),mm=zoom*3.779527559;
    const viewport={x:Math.max(0,(visible.left-bounds.left)/mm),y:Math.max(0,(visible.top-bounds.top)/mm),
      w:Math.max(0,(Math.min(visible.right,bounds.right)-Math.max(visible.left,bounds.left))/mm),
      h:Math.max(0,(Math.min(visible.bottom,bounds.bottom)-Math.max(visible.top,bounds.top))/mm)};
    const anchor=draft.layout.elements.find(el=>ids.has(el.id)&&el.band===band);
    pendingInsertion={kind,key,band};
    const el=createPrintElement(draft,kind,{key,band,anchor,viewport,position:x==null?null:{x,y}});
    host.querySelector('.pt-insert-options')?.remove();
    draft.layout.elements.push(el);ids=new Set([el.id]);remember();drawCanvas();drawProperties();
    host.querySelector('[data-element="'+el.id+'"]').scrollIntoView({block:'nearest',inline:'nearest'});
    if(kind==='text'){const input=host.querySelector('#pt-props textarea[name="text"]');input.focus();input.select();}
  }
  function undo(delta){panels.clear();const next=cursor+delta;if(next<0||next>=history.length)return;cursor=next;draft=JSON.parse(history[cursor]);dirty=true;draw();}
  function paste(){for(const item of clipboard){const el={...item,id:uid(),x:Math.max(0,item.x+2),y:Math.max(0,item.y+2)};
    const width=draft.paper.width-draft.paper.margin.left-draft.paper.margin.right;
    el.x=Math.min(el.x,width-el.w);el.y=Math.min(el.y,draft.layout.bands[el.band]-el.h);draft.layout.elements.push(el);ids.add(el.id);}
    remember();drawCanvas();drawProperties();}
  function remove(){for(const id of ids)panels.delete('element:'+id);draft.layout.elements=draft.layout.elements.filter(el=>!ids.has(el.id));ids.clear();remember();drawCanvas();drawProperties();}
  async function save({collect=true}={}){
    const started=performance.now();
    const candidate=normalizePrintTemplate(collect?collectPanels():draft);validatePrintTemplate(candidate);
    const result=await persist(candidate);
    selected=result;draft=copy(result);dirty=false;panels.clear();
    const index=rows.findIndex(row=>row.id===result.id);if(index>=0)rows[index]=result;
    history=[JSON.stringify(draft)];cursor=0;
    const tab=host.querySelector('[data-template="'+result.id+'"]');if(tab)tab.textContent=result.name+(result.is_default?'（默认）':'');
    // Keep the canvas, scroll positions, selection and property inputs in place.
    drawCanvas();const selectedId=[...ids][0];if(selectedId)drawProperties();refreshPaperPanels();
    host.dataset.saveMilliseconds=String(Math.round(performance.now()-started));
    toast('打印模板已保存');return result;
  }
  async function preview(){
    const started=performance.now();
    if(dirty||panels.size)await save();
    let id=latestDocuments.get(type);
    if(!id){const result=await api('/api/documents?type='+type+'&page=1');id=result.rows[0]?.id;if(id)latestDocuments.set(type,id);}
    if(!id)throw Error('请先保存一张此类型单据，再预览真实数据');
    await showPrintPreview([id],{api,showError,showSystemPrompt}, {[type]:selected.id});
    host.dataset.previewMilliseconds=String(Math.round(performance.now()-started));
  }
  const bind=()=>{
    host.querySelector('#pt-type').addEventListener('change',act(async event=>{
      if(dirty&&!await showSystemPrompt('切换单据类型会放弃尚未保存的设计，确认切换？',{cancelLabel:'取消'})){event.target.value=type;return;}
      type=event.target.value;await load();
    }));
    for(const el of host.querySelectorAll('[data-template]'))el.addEventListener('click',act(async()=>{
      if(dirty&&!await showSystemPrompt('放弃尚未保存的设计？',{cancelLabel:'取消'}))return;
      select(rows.find(row=>row.id===Number(el.dataset.template)));
    }));
    for(const el of host.querySelectorAll('[data-field]')) {
      bindPrintFieldDrag(el,{key:el.dataset.field,onDrop:dropField,onError:reportDesignerError});
      el.addEventListener('dblclick',()=>{if(!busy)try{addElement('field',el.dataset.field);}catch(error){reportDesignerError(error);}});
    }
    for(const el of host.querySelectorAll('[data-tool-kind]'))bindPrintFieldDrag(el,{key:el.dataset.toolKind,mime:'application/x-print-element',onDrop:(kind,region,point)=>dropField('element:'+kind,region,point),onError:reportDesignerError});
    host.querySelector('#pt-band').addEventListener('change',event=>{selectedBand=event.target.value;host.querySelectorAll('[data-band]').forEach(node=>node.classList.toggle('active',node.dataset.band===selectedBand));});
    host.querySelector('#pt-zoom').addEventListener('change',event=>{zoom=Number(event.target.value);drawCanvas();});
    const paperForm=host.querySelector('#pt-paper-form');
    const updatePaperInputs=change=>{
      const current={...draft.paper,preset:paperForm.elements.preset.value,width:Number(paperForm.elements.width.value),height:Number(paperForm.elements.height.value)};
      const next=selectPrintPaper(current,change);
      for(const key of ['preset','width','height','orientation'])paperForm.elements[key].value=next[key];
    };
    paperForm.elements.preset.addEventListener('change',event=>updatePaperInputs({preset:event.target.value}));
    paperForm.elements.orientation.addEventListener('change',event=>updatePaperInputs({orientation:event.target.value}));
    for(const key of ['width','height'])paperForm.elements[key].addEventListener('input',()=>updatePaperInputs({width:paperForm.elements.width.value,height:paperForm.elements.height.value}));
    watchPanel(paperForm,'paper');
    paperForm.addEventListener('submit',act(async event=>{
      event.preventDefault();
      try{
        let next=copy(draft);
        // Apply pending element edits before scaling them; no form is discarded on failure.
        for(const [key,raw] of panels)if(key!=='paper')next=applyPanel(next,key,raw);
        next=applyPanel(next,'paper',readPanel(paperForm));validatePrintTemplate(next);
        draft=next;panels.clear();remember();drawCanvas();drawProperties();drawColumns();refreshPaperPanels();
        host.querySelector('#pt-paper-status').textContent='纸张已应用到本地草稿，尚未保存';
        toast('纸张设置已应用到草稿，请点击「保存模板」');
      }catch(error){panelError(paperForm,error);}
    }));
    const paginationForm=host.querySelector('#pt-pagination-form');watchPanel(paginationForm,'pagination');
    paginationForm.addEventListener('submit',act(async event=>{
      event.preventDefault();
      try{const next=updatePrintPagination(draft,readPanel(paginationForm));validatePrintTemplate(next);draft=next;panels.delete('pagination');remember();drawCanvas();paginationForm.querySelector('.pt-form-error').textContent='';}
      catch(error){panelError(paginationForm,error);}
    }));
    host.querySelector('#pt-background-file').addEventListener('change',act(async event=>{
      const image=await imageUpload(event.target.files[0],api);draft.layout.background=image.id;remember();drawCanvas();
    }));
    host.querySelector('#pt-import').addEventListener('change',act(async event=>{
      const file=event.target.files[0];if(!file)return;if(file.size>10_000_000)throw Error('JSON 文件过大');
      const json=JSON.parse(await file.text());let value;
      try{value=await api('/api/print-templates/import',json);}
      catch(error){
        if(!error.message.includes('同名模板')||!await showSystemPrompt('同名模板已存在，确认使用导入内容覆盖？',{cancelLabel:'取消'}))throw error;
        value=await api('/api/print-templates/import',{...json,replace:true});
      }
      type=value.doc_type;await load(value.id);toast('打印模板导入成功：'+value.name);
    }));
    host.querySelectorAll('[data-pt]').forEach(el=>el.addEventListener('click',act(async()=>{
      const action=el.dataset.pt;
      if(action==='save')return save();
      if(action==='preview')return preview();
      if(action==='undo')return undo(-1);if(action==='redo')return undo(1);
      if(action==='copy-elements'){clipboard=copy(draft.layout.elements.filter(el=>ids.has(el.id)));return;}
      if(action==='paste')return paste();if(action==='remove')return remove();
      if(action.startsWith('add-')&&action!=='add-column')return addElement(action.slice(4));
      if(action.startsWith('align-')){
        const bands=new Set(draft.layout.elements.filter(item=>ids.has(item.id)).map(item=>item.band));
        if(bands.size>1)throw Error('请在同一区域内进行多选对齐');
        alignPrintElements(draft.layout.elements,ids,action.slice(6));remember();drawCanvas();return;
      }
      if(action==='up'||action==='down'){
        const elements=draft.layout.elements;
        const positions=elements.map((item,i)=>ids.has(item.id)?i:-1).filter(i=>i>=0);
        if(action==='up')positions.reverse();
        for(const i of positions){const next=i+(action==='up'?1:-1);if(next>=0&&next<elements.length&&!ids.has(elements[next].id))[elements[i],elements[next]]=[elements[next],elements[i]];}
        remember();drawCanvas();return;
      }
      if(action==='add-column'){
        const key=host.querySelector('#pt-add-column').value;
        const existing=draft.layout.table.columns.find(c=>c.key===key);
        if(existing)existing.visible=true;
        else draft.layout.table.columns.push({key,title:printLineFields[key],width:15,visible:true,decimals:2});
        remember();drawColumns();drawCanvas();return;
      }
      if(action==='clear-background'){draft.layout.background=null;remember();drawCanvas();return;}
      if(action==='new'){
        let name='新模板';for(let i=2;rows.some(row=>row.name===name);i++)name='新模板 '+i;
        name=await askName(name);if(!name)return;
        const value=defaultPrintTemplate(type);value.name=name;value.is_default=false;
        selected=await api('/api/print-templates',value);await load(selected.id);toast('打印模板已新建：'+name);return;
      }
      if(action==='copy'){
        let name=selected.name+' 副本';for(let i=2;rows.some(row=>row.name===name);i++)name=selected.name+' 副本 '+i;
        const value=await api('/api/print-templates/'+selected.id,{action:'copy',name});await load(value.id);toast('打印模板已复制：'+value.name);return;
      }
      if(action==='rename'){
        const name=await askName(selected.name);
        if(name){draft.name=name;remember();await save();}return;
      }
      if(action==='export'){
        const value=collectPanels();
        const bundle=await exportPrintDesign(value,async id=>{
          const blob=await api('/api/print-assets/'+id,undefined,true),bytes=new Uint8Array(await blob.arrayBuffer());let text='';
          for(const byte of bytes)text+=String.fromCharCode(byte);
          return {id,mime:blob.type,content:btoa(text)};
        });
        downloadJson(bundle,value.name);toast('模板JSON已生成（包含尚未保存的设计）');return;
      }
      if(action==='delete'||action==='restore'){
        if(!await showSystemPrompt(action==='delete'?'确认删除此模板？':'确认恢复所选模板为系统默认布局？',{cancelLabel:'取消'}))return;
      }
      const result=await api('/api/print-templates/'+selected.id,{action,revision:selected.revision});
      await load(result.id);
      toast(action==='default'?'已设为默认打印模板':action==='delete'?'打印模板已删除':'已恢复系统默认布局');
    })));
  };
  function select(value){panels.clear();selected=normalizePrintTemplate(value);draft=copy(selected);persist.remember?.(selected);draft.paper.orientation=paperOrientation(draft.paper);ids.clear();history=[JSON.stringify(draft)];cursor=0;dirty=false;draw();}
  async function load(id){rows=(await api('/api/print-templates?type='+type)).rows;if(!rows.length)throw Error('没有可用打印模板');select(rows.find(row=>row.id===id)||rows[0]);}
  if(!canDesign){host.innerHTML='<p>没有打印模板设计权限</p>';return;}
  await load();
}
function askName(current) {
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='pt-name-dialog';
    dialog.innerHTML='<form method="dialog" novalidate><label>模板名称<input name="name" maxlength="80" aria-required="true"></label><output aria-live="polite"></output><button value="save" class="btn primary">保存</button><button value="cancel" class="btn" formnovalidate>取消</button></form>';
    dialog.querySelector('input').value=current;document.body.append(dialog);dialog.showModal();
    dialog.querySelector('input').focus();dialog.querySelector('input').select();
    dialog.querySelector('form').addEventListener('submit',event=>{
      if(event.submitter?.value==='cancel')return;
      if(!dialog.querySelector('input').value.trim()){event.preventDefault();dialog.querySelector('output').textContent='请输入模板名称';dialog.querySelector('input').focus();}
    });
    dialog.addEventListener('close',()=>{const value=dialog.returnValue==='save'?dialog.querySelector('input').value.trim():null;dialog.remove();resolve(value);},{once:true});
  });
}
export async function showPrintPreview(ids,{api,showError,showSystemPrompt,beforePrint},initial={}) {
  const dialog=document.createElement('dialog');dialog.className='pt-preview-dialog';
  const response=await api('/api/print/preview',{ids,templates:initial}),values=response.documents;
  const types=[...new Set(values.map(item=>item.data.type))],available=response.templates||{};
  await Promise.all(types.filter(type=>!available[type]).map(async type=>{available[type]=(await api('/api/print-templates?type='+type)).rows;}));
  let templates={...Object.fromEntries(values.map(item=>[item.data.type,item.template.id])),...initial},documents=values,page=0,zoom=0.8,busy=false;
  dialog.innerHTML='<header><h2>打印预览</h2><button class="btn" id="pt-close">关闭</button></header><div class="toolbar">'+types.map(type=>
    label(families[type][0]+'模板','<select data-preview-type="'+type+'">'+available[type].map(row=>'<option value="'+row.id+'"'+(row.id===templates[type]?' selected':'')+'>'+esc(row.name)+'</option>').join('')+'</select>')).join('')+
    button('上一页','previous')+button('下一页','next')+'<output id="pt-page-status"></output>'+label('缩放','<select id="pt-preview-zoom">'+options({'0.5':'50%','0.8':'80%','1':'100%','1.25':'125%'},zoom)+'</select>')+
    button('打印','print')+button('导出 PDF（另存为 PDF）','pdf')+button('导出 Excel','excel')+'</div><div class="pt-preview-scroll"></div>';
  document.body.append(dialog);dialog.showModal();
  const setPreviewBusy=value=>{busy=value;dialog.setAttribute('aria-busy',String(value));for(const control of dialog.querySelectorAll('button,select'))control.disabled=value;};
  dialog.querySelector('#pt-close').onclick=()=>{if(!busy){dialog.close();dialog.remove();}};
  let renderedDocuments,pageItems=[],pageCache=new Map();
  const draw=()=>{
    if(renderedDocuments!==documents){renderedDocuments=documents;pageCache.clear();pageItems=documents.flatMap(({template,data})=>paginatePrint(template,data).map((_,index)=>({template,data,index})));}
    page=Math.max(0,Math.min(page,pageItems.length-1));
    const item=pageItems[page],container=dialog.querySelector('.pt-preview-scroll');
    const wrapper=document.createElement('div');if(!pageCache.has(page))pageCache.set(page,renderPrintPages(item.template,item.data,{preview:true,pageIndex:item.index}));wrapper.innerHTML=pageCache.get(page);
    const section=wrapper.firstElementChild;
    section.style.transform='scale('+zoom+')';section.style.transformOrigin='top left';
    container.replaceChildren(section);
    dialog.querySelector('#pt-page-status').textContent='第 '+(page+1)+' / '+pageItems.length+' 页';
  };
  dialog.querySelectorAll('[data-preview-type]').forEach(select=>select.addEventListener('change',async()=>{
    if(busy)return;setPreviewBusy(true);
    try {templates[select.dataset.previewType]=Number(select.value);documents=(await api('/api/print/preview',{ids,templates})).documents;page=0;draw();}
    catch(error){await showError(error);}finally{setPreviewBusy(false);}
  }));
  dialog.querySelector('#pt-preview-zoom').onchange=event=>{zoom=Number(event.target.value);draw();};
  for(const el of dialog.querySelectorAll('[data-pt]'))el.onclick=async()=>{
    if(busy)return;setPreviewBusy(true);
    try{
      const action=el.dataset.pt;
      if(action==='previous'){page--;draw();return;}if(action==='next'){page++;draw();return;}
      if(action==='excel'){
        const response=await api('/api/print/excel',{ids,templates},true);
        const url=URL.createObjectURL(response);const a=document.createElement('a');a.href=url;a.download='单据打印数据.xlsx';a.click();URL.revokeObjectURL(url);return;
      }
      if(action==='print'||action==='pdf'){
        if(beforePrint&&documents.some(row=>row.template.layout.autoSave))await beforePrint();
        documents=(await api('/api/print/preview',{ids,templates})).documents;
        // Snapshot the pages before recording so the page itself carries the new print ordinal.
        for(const {data} of documents){data.fields.printCount++;data.fields.reprint=data.fields.printCount>1?'重打':'';}
        await printTemplateDocuments(documents,{onReady:()=>api('/api/print/commit',{ids,templates,requestId:uid()})});
        documents=(await api('/api/print/preview',{ids,templates})).documents;draw();
      }
    }catch(error){await showError(error);}finally{setPreviewBusy(false);}
  };
  draw();
}
