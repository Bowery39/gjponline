import {printBands,normalizePrintTemplate} from './print-layout.js';
export const mm=value=>Math.round((Number(value)+Number.EPSILON)*10)/10;
const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
export function editorNumber(value,label,{min=0,max=1000,integer=false,field=label}={}) {
  const number=Number(value);
  if(value==null||String(value).trim()===''||!Number.isFinite(number)||number<min||number>max||(integer&&!Number.isInteger(number)))
    throw Object.assign(Error(label+'须为'+(integer?'整数':'有效数字')+'（'+min+'–'+max+'）'),{field});
  return number;
}
export function elementsOverlap(a,b,gap=0) {
  return a.x<b.x+b.w+gap-0.001&&a.x+a.w+gap>b.x+0.001&&a.y<b.y+b.h+gap-0.001&&a.y+a.h+gap>b.y+0.001;
}
export function resolvePrintOverlaps(value,{gap=1}={}) {
  Object.assign(value,normalizePrintTemplate(value));
  const l=value.layout,height=mm(value.paper.height-value.paper.margin.top-value.paper.margin.bottom);
  for(const band of printBands){
    const sorted=l.elements.filter(el=>el.band===band).map((el,index)=>({el,index}))
      .sort((a,b)=>a.el.y-b.el.y||a.el.x-b.el.x||a.index-b.index);
    const placed=[];
    for(const {el} of sorted){
      let collisions;
      while((collisions=placed.filter(other=>elementsOverlap(el,other))).length)
        el.y=mm(Math.max(...collisions.map(other=>other.y+other.h))+gap);
      placed.push(el);
    }
    l.bands[band]=mm(Math.max(l.bands[band],...l.elements.filter(el=>el.band===band).map(el=>el.y+el.h)));
  }
  const other=printBands.filter(band=>band!=='body').reduce((sum,band)=>sum+l.bands[band],0);
  l.bands.body=mm(Math.min(l.bands.body,height-other));
  const t=l.table,minBody=t.headerHeight+t.rowHeight*(1+Number(!!t.total)+Number(!!t.subtotal));
  const bodyEnd=Math.max(0,...l.elements.filter(el=>el.band==='body').map(el=>el.y+el.h));
  if(l.bands.body<minBody-0.01||l.bands.body<bodyEnd-0.01)throw Error('纸张高度不足以容纳适配后的元素，请增大纸张、减小字号或减少元素');
  const capacity=Math.floor((l.bands.body-t.headerHeight-(t.subtotal?t.rowHeight:0)-(t.total?t.rowHeight:0))/t.rowHeight);
  if(t.rowsPerPage>capacity)t.rowsPerPage=0;
  return Object.assign(value,normalizePrintTemplate(value));
}
export function updatePrintElement(value,id,raw) {
  const next=copy(value),el=next.layout.elements.find(el=>el.id===id);
  if(!el)throw Error('所选元素已不存在');
  const shape=['line','rect'].includes(el.kind);
  const labels={x:'X 坐标',y:'Y 坐标',w:'宽度',h:'高度',fontSize:'字号',decimals:'小数位',lineWidth:'线宽'};
  for(const key of ['x','y','w','h',...(shape?['lineWidth']:['fontSize','decimals'])]){
    if(raw[key]==null)continue;
    el[key]=editorNumber(raw[key],labels[key],{min:['w','h'].includes(key)?0.1:key==='fontSize'?5:key==='lineWidth'?0.01:0,
      max:key==='fontSize'?72:key==='decimals'?8:key==='lineWidth'?10:1000,integer:key==='decimals',field:key});
  }
  const keys=shape?['band','lineStyle','color']:['band','key','text','expression','font','align','dateFormat','bold','border','wrap','hideZero','thousands','currency'];
  for(const key of keys)if(raw[key]!=null)el[key]=raw[key];
  return next;
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function mergePrintTemplates(base,local,remote) {
  const merge=(old,ours,theirs)=>{
    if(same(ours,old))return copy(theirs);
    if(same(theirs,old)||same(ours,theirs))return copy(ours);
    if(Array.isArray(ours)&&Array.isArray(theirs)){
      const key=ours.concat(theirs).every(item=>item&&typeof item==='object'&&('id' in item||'key' in item))?'idOrKey':null;
      if(key){
        const id=item=>item.id??item.key,previous=new Map((old||[]).map(item=>[id(item),item]));
        const left=new Map(ours.map(item=>[id(item),item])),right=new Map(theirs.map(item=>[id(item),item]));
        const order=[...new Set([...ours.map(id),...theirs.map(id)])];
        return order.flatMap(k=>{
          if(!left.has(k))return previous.has(k)?[]:[copy(right.get(k))];
          if(!right.has(k))return previous.has(k)&&same(left.get(k),previous.get(k))?[]:[copy(left.get(k))];
          return [merge(previous.get(k),left.get(k),right.get(k))];
        });
      }
      return copy(ours);
    }
    if(ours&&theirs&&typeof ours==='object'&&typeof theirs==='object'){
      const result={};
      for(const key of new Set([...Object.keys(theirs),...Object.keys(ours)])){
        if(['revision','version','updated_at'].includes(key)&&key!=='version'){result[key]=theirs[key];continue;}
        if(!(key in ours)){if(!old||!(key in old))result[key]=copy(theirs[key]);continue;}
        if(!(key in theirs)){if(!same(ours[key],old?.[key]))result[key]=copy(ours[key]);continue;}
        result[key]=merge(old?.[key],ours[key],theirs[key]);
      }
      return result;
    }
    return copy(ours);
  };
  const result=merge(base,local,remote);
  result.id=remote.id;result.revision=remote.revision;result.version=remote.revision;result.updated_at=remote.updated_at;
  return normalizePrintTemplate(result);
}
const isVersionConflict=error=>error.code==='TEMPLATE_VERSION_CONFLICT'||error.field==='revision'||(!error.code&&error.status===409);
export function createTemplateSaver(api,{onRetry=()=>{}}={}) {
  let tail=Promise.resolve();const saved=new Map();
  const persist=input=>{
    const baseKnown=saved.has(input.id),snapshot=normalizePrintTemplate(input),base=copy(saved.get(input.id)||input);
    const save=async()=>{
      const known=saved.get(snapshot.id),revision=Math.max(known?.revision||0,snapshot.revision??snapshot.version??0);
      let candidate=baseKnown&&known?.revision>snapshot.revision?mergePrintTemplates(base,snapshot,known):snapshot;
      const put=async()=>api('/api/print-templates/'+snapshot.id,{...candidate,revision:candidate.revision,version:candidate.revision},false,'PUT');
      candidate.revision=revision;
      try{
        let result;
        try{result=await put();}
        catch(error){
          if(!isVersionConflict(error))throw error;
          const latest=await api('/api/print-templates/'+snapshot.id);
          candidate=mergePrintTemplates(base,snapshot,latest);
          onRetry('检测到版本更新，已合并本地修改并重试一次（同字段以本地修改为准）');
          result=await put();
        }
        saved.set(snapshot.id,copy(result));return result;
      }catch(error){
        if(isVersionConflict(error))error.message='模板仍存在版本冲突，当前修改已保留，可导出JSON备份后重试';
        if(!error.code?.startsWith('TEMPLATE_')){error.originalCode=error.code;error.code='TEMPLATE_SAVE_FAILED';}throw error;
      }
    };
    const result=tail.then(save);tail=result.catch(()=>{});return result;
  };
  persist.remember=value=>saved.set(value.id,normalizePrintTemplate(value));
  return persist;
}
const toastStates=new WeakMap();
export function createPrintToast(ownerDocument=globalThis.document,{schedule=setTimeout,cancel=clearTimeout}={}) {
  if(!toastStates.has(ownerDocument))toastStates.set(ownerDocument,{timer:null,node:null,cancel});
  const state=toastStates.get(ownerDocument);
  return message=>{
    if(state.timer)Reflect.apply(state.cancel,globalThis,[state.timer]);
    state.cancel=cancel;
    state.node??=ownerDocument.createElement('div');const node=state.node;
    node.className='pt-toast';node.setAttribute('role','status');node.setAttribute('aria-live','polite');
    node.textContent=message;if(!node.isConnected)ownerDocument.body.append(node);
    state.timer=schedule(()=>{node.remove();state.timer=null;},2000);state.timer?.unref?.();
  };
}
export function updatePrintPagination(value,raw) {
  const next=copy(value),l=next.layout;
  for(const key of printBands)l.bands[key]=editorNumber(raw[key],'区域高度',{field:key});
  for(const key of ['rowsPerPage','rowHeight','headerHeight'])l.table[key]=editorNumber(raw[key],{rowsPerPage:'每页行数',rowHeight:'行高',headerHeight:'列标题高度'}[key],
    {field:key,min:key==='rowsPerPage'?0:3,max:key==='rowsPerPage'?500:30,integer:key==='rowsPerPage'});
  l.grid=editorNumber(raw.grid,'网格',{field:'grid',min:0.5,max:10});
  for(const key of ['fillBlank','subtotal','total'])l.table[key]=raw[key]===true;
  for(const key of ['snap','overlay','requireApproved','autoSave'])l[key]=raw[key]===true;
  return next;
}
export function printPaperFromInput(raw) {
  const paper={preset:raw.preset,width:editorNumber(raw.width,'纸张宽度',{field:'width',min:50}),height:editorNumber(raw.height,'纸张高度',{field:'height',min:50}),margin:{}};
  for(const key of ['top','right','bottom','left'])paper.margin[key]=editorNumber(raw[key],{top:'上边距',right:'右边距',bottom:'下边距',left:'左边距'}[key],{field:key,max:100});
  paper.orientation=paper.width>paper.height?'landscape':'portrait';return paper;
}
export const printDropPosition=(bounds,point,zoom)=>({x:mm((point.x-bounds.left)/(zoom*3.779527559)),y:mm((point.y-bounds.top)/(zoom*3.779527559))});
export function bindPrintFieldDrag(button,{key,ownerDocument=globalThis.document,onDrop,onError=()=>{},mime='application/x-print-field'}) {
  let cleanup=()=>{};button.draggable=true;
  button.addEventListener('dragstart',event=>{cleanup();event.dataTransfer.setData(mime,key);event.dataTransfer.effectAllowed='copy';});
  button.addEventListener('pointerdown',event=>{
    if(button.disabled||event.button!==0)return;
    cleanup();const start={x:event.clientX,y:event.clientY};let moved=false,ghost;
    const finish=point=>{
      const drop=moved&&point?ownerDocument.elementFromPoint(point.x,point.y)?.closest('[data-band]'):null;
      cleanup();if(drop)try{onDrop(key,drop,point);}catch(error){onError(error);}
    };
    const move=point=>{
      if(Math.hypot(point.clientX-start.x,point.clientY-start.y)<5&&!moved)return;
      moved=true;
      if(!ghost){ghost=ownerDocument.createElement('div');ghost.className='pt-drag-ghost';ghost.textContent=button.textContent;ownerDocument.body.append(ghost);}
      ghost.style.left=point.clientX+10+'px';ghost.style.top=point.clientY+10+'px';
      if(point.cancelable)point.preventDefault();
    };
    const up=point=>finish({x:point.clientX,y:point.clientY});
    const cancel=()=>finish(null);
    ownerDocument.addEventListener('pointermove',move);ownerDocument.addEventListener('pointerup',up);ownerDocument.addEventListener('pointercancel',cancel);
    cleanup=()=>{ghost?.remove();ownerDocument.removeEventListener('pointermove',move);ownerDocument.removeEventListener('pointerup',up);ownerDocument.removeEventListener('pointercancel',cancel);cleanup=()=>{};};
    // Touch/pen must suppress scrolling; mouse remains free to initiate HTML5 drag.
    if(event.pointerType!=='mouse'&&event.cancelable)event.preventDefault();
  });
}
export function bindPrintCanvasDrop(canvas,{onDrop,canDrop=()=>true,onError=()=>{}}) {
  canvas.ondragover=event=>event.preventDefault();
  canvas.ondrop=event=>{
    event.preventDefault();if(!canDrop())return;
    const kind=event.dataTransfer.getData('application/x-print-element');
    const key=event.dataTransfer.getData('application/x-print-field')||(kind?'element:'+kind:''),region=event.target.closest('[data-band]');
    if(!key||!region)return;
    try{onDrop(key,region,{x:event.clientX,y:event.clientY});}catch(error){onError(error);}
  };
}
export async function exportPrintDesign(value,loadAsset) {
  const checked=JSON.parse(JSON.stringify(value));
  const ids=[...new Set([checked.layout.background,...checked.layout.elements.map(el=>el.asset)].filter(Boolean))];
  return {format:'hengxu-print-template',version:1,
    template:{doc_type:checked.doc_type,name:checked.name,is_default:checked.is_default,paper:checked.paper,layout:checked.layout},
    assets:await Promise.all(ids.map(loadAsset))};
}
