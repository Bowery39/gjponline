import {families} from './catalog.js';
import {code39} from './barcode.js';
import {qrSvg} from './print-qr.js';
export const printBands=['pageHeader','header','body','footer','pageFooter'];
export const printFields={
  companyName:'公司名称',companyAddress:'公司地址',companyPhone:'公司电话',documentName:'单据名称',number:'单据编号',
  date:'日期',partner:'往来单位',contact:'联系人',phone:'联系电话',address:'地址',warehouse:'仓库',handler:'经手人',
  department:'部门',summary:'摘要',note:'备注',creator:'制单人',reviewer:'审核人',printCount:'打印次数',
  quantity:'合计数量',baseAmount:'合计金额',net:'合计折后金额',tax:'合计税额',gross:'合计含税金额',uppercase:'大写金额',
  reduction:'整单优惠',freight:'运费',total:'应收应付合计',paid:'本单收付款',outstanding:'本单未结',balance:'单位累计欠款',
  account:'收付款账户',printTime:'打印时间',page:'页码',reprint:'重打标记'
};
export const printLineFields={index:'行号',code:'商品编号',name:'商品名称',spec:'规格',model:'型号',barcode:'条码',
  unit:'单位',quantity:'数量',unitPrice:'单价',baseAmount:'金额',discount:'折扣',discountedUnit:'折后单价',net:'折后金额',
  rate:'税率',tax:'税额',grossUnit:'含税单价',gross:'含税金额',batch:'批号',production:'生产日期',note:'备注',
  debit:'借方金额',credit:'贷方金额',ledgerAccount:'会计科目'};
export const paperPresets={A4:[210,297],A5:[148,210],'241×93':[241,93],'241×140':[241,140]};
export const escapePrint=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=value=>JSON.parse(JSON.stringify(value));
const moneyFields=new Set(['baseAmount','net','tax','gross','reduction','freight','total','paid','outstanding','balance','unitPrice','discountedUnit','grossUnit','debit','credit']);
export const printNumber=value=>Math.round((value+Number.EPSILON)*10)/10;
export function normalizePrintTemplate(input) {
  const value=clone(input),layout=value?.layout;
  if(!layout)return value;
  // Split the historical full-width signature label before arranging it.
  const ids=new Set((layout.elements||[]).map(el=>el.id));
  layout.elements=(layout.elements||[]).flatMap(el=>{
    if(el.id!=='sign'||el.kind!=='text'||!['制单','审核','收货人'].every(label=>el.text?.includes(label)))return [el];
    const scale=el.w/190;
    return [['sign','制单：',0,12],['sign-audit','审核：',64,12],['sign-recipient','收货人：',128,18]]
      .filter(([id])=>id==='sign'||!ids.has(id)).map(([id,text,x,w])=>({...el,id,text,x:el.x+x*scale,w:w*scale}));
  });
  const round=(object,key,positive=false)=>{const n=object?.[key];if(typeof n==='number'&&Number.isFinite(n)&&n>=0)object[key]=positive&&n>0?Math.max(0.1,printNumber(n)):printNumber(n);};
  for(const key of ['width','height'])round(value.paper,key);
  for(const key of ['top','right','bottom','left'])round(value.paper?.margin,key);
  for(const el of layout.elements)for(const key of ['x','y','w','h','fontSize','lineWidth'])round(el,key,['w','h','lineWidth'].includes(key));
  for(const key of printBands)round(layout.bands,key);
  for(const c of layout.table?.columns||[])round(c,'width',true);
  const columns=layout.table?.columns?.filter(c=>c.visible!==false)||[],width=value.paper?.width-value.paper?.margin?.left-value.paper?.margin?.right;
  const sum=columns.reduce((total,c)=>total+c.width,0),last=columns.at(-1);
  if(last&&sum>width&&sum-width<1&&last.width-(sum-width)>=3)last.width=printNumber(last.width-(sum-width));
  return value;
}
export function defaultPrintTemplate(type) {
  const cash=families[type]?.[4]==='cash',journal=families[type]?.[4]==='journal';
  const keys=cash?['index','name','gross']:journal?['index','ledgerAccount','debit','credit']:['index','code','name','unit','quantity','unitPrice','gross'];
  const widths=cash?[10,120,60]:journal?[10,90,45,45]:[10,30,50,12,20,28,40];
  const field=(id,band,key,x,y,w,h=6)=>({id,kind:'field',band,key,x,y,w,h,font:'Microsoft YaHei',fontSize:10,align:'left',decimals:2,wrap:true});
  return normalizePrintTemplate({doc_type:type,name:'系统默认',is_default:true,
    paper:{preset:'A4',width:210,height:297,orientation:'portrait',margin:{top:10,right:10,bottom:10,left:10}},
    layout:{version:1,bands:{pageHeader:15,header:30,body:175,footer:40,pageFooter:10},
      elements:[{...field('company','pageHeader','companyName',0,0,190,8),fontSize:16,bold:true,align:'center'},
        {...field('title','header','documentName',0,0,190,8),fontSize:14,bold:true,align:'center'},
        field('no','header','number',0,10,105),field('date','header','date',110,10,80),
        field('partner','header','partner',0,20,105),field('warehouse','header','warehouse',110,20,80),
        field('total','footer','total',110,0,80),field('upper','footer','uppercase',0,8,190),
        {id:'sign','kind':'text',band:'footer',text:'制单：                         审核：                         收货人：',x:0,y:25,w:190,h:7,fontSize:10},
        field('creator','footer','creator',12,25,35),field('reviewer','footer','reviewer',76,25,35),
        {...field('page','pageFooter','page',0,0,190),align:'center'}],
      table:{columns:keys.map((key,i)=>({key,title:printLineFields[key],width:widths[i],visible:true,decimals:key==='index'?0:2,align:moneyFields.has(key)||key==='quantity'?'right':'left'})),
        rowHeight:6,headerHeight:7,rowsPerPage:0,fillBlank:true,subtotal:true,total:true},
      grid:2,snap:true,overlay:false,background:null,requireApproved:false,autoSave:false}});
}
function fail(message) {throw Error(message);}
const finite=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
export function validatePrintTemplate(value) {
  if (!value||typeof value!=='object'||!families[value.doc_type]) fail('请选择有效单据类型');
  if (typeof value.name!=='string'||!value.name.trim()||value.name.length>80) fail('模板名称须为 1–80 个字符');
  if(typeof value.is_default!=='boolean')fail('默认模板选项无效');
  const p=value.paper,l=value.layout;
  if (!p||!finite(p.width,50,1000)||!finite(p.height,50,1000)||!['portrait','landscape'].includes(p.orientation)) fail('纸张尺寸或方向无效');
  if (!p.margin||!['top','right','bottom','left'].every(key=>finite(p.margin[key],0,100))) fail('页边距无效');
  const width=p.width-p.margin.left-p.margin.right,height=p.height-p.margin.top-p.margin.bottom;
  if (width<20||height<30) fail('页边距超出纸张范围');
  if (!l||l.version!==1) fail('不支持此模板版本');
  if (!l.bands||!printBands.every(key=>finite(l.bands[key],0,1000))||printBands.reduce((sum,key)=>sum+l.bands[key],0)>height+0.01) fail('各区域总高度不能超过纸张可打印高度');
  if (!Array.isArray(l.elements)||l.elements.length>200) fail('模板元素最多 200 个');
  const ids=new Set();
  for (const el of l.elements) {
    if (!el||typeof el.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(el.id)||ids.has(el.id)||!['field','text','line','rect','image','barcode','qr','page','time','expression'].includes(el.kind)) fail('模板元素无效或编号重复');
    ids.add(el.id);
    if (!printBands.includes(el.band)||!['x','y','w','h'].every(key=>finite(el[key],0,1000))||el.w<0.1||el.h<0.1) fail('元素位置或尺寸无效');
    if (el.x+el.w>width+0.01||el.y+el.h>l.bands[el.band]+0.01) fail('元素超出所在区域，请调整纸张、区域或元素尺寸');
    if (el.kind==='field'&&!Object.hasOwn(printFields,el.key)) fail('未知打印字段');
    if (el.font!=null&&(typeof el.font!=='string'||!/^[\w\s\-\u3400-\u9fff,]+$/.test(el.font)||el.font.length>80)) fail('字体名称无效');
    if (el.fontSize!=null&&!finite(el.fontSize,5,72)) fail('字号须为 5–72');
    if (el.align!=null&&!['left','center','right'].includes(el.align)) fail('对齐方式无效');
    for (const key of ['text','expression']) if (el[key]!=null&&(typeof el[key]!=='string'||el[key].length>1000)) fail('文本或表达式过长');
    if (el.kind==='expression') evaluatePrintExpression(el.expression||'0',{});
    if(el.lineWidth!=null&&!finite(el.lineWidth,0.01,10))fail('线宽须为0.01–10mm');
    if(el.lineStyle!=null&&!['solid','dashed','dotted'].includes(el.lineStyle))fail('线型无效');
    if(el.color!=null&&(typeof el.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(el.color)))fail('颜色须为六位十六进制颜色');
    validateFormat(el);
    if (el.asset!=null&&!/^[a-f0-9]{64}$/.test(el.asset)) fail('图片编号无效');
  }
  for(const key of ['overlay','snap','requireApproved','autoSave'])if(l[key]!=null&&typeof l[key]!=='boolean')fail('打印选项必须为布尔值');
  const t=l.table;
  for(const key of ['fillBlank','subtotal','total'])if(t?.[key]!=null&&typeof t[key]!=='boolean')fail('分页开关必须为布尔值');
  if (!t||!Array.isArray(t.columns)||!t.columns.length||t.columns.length>30||!finite(t.rowHeight,3,30)||!finite(t.headerHeight,3,30)||!Number.isInteger(t.rowsPerPage)||t.rowsPerPage<0||t.rowsPerPage>500) fail('表体设置无效');
  const columns=new Set();
  for (const c of t.columns) {
    if (!Object.hasOwn(printLineFields,c.key)||columns.has(c.key)||typeof c.title!=='string'||c.title.length>60||!finite(c.width,3,500)) fail('表体列设置无效');
    columns.add(c.key);validateFormat(c);
  }
  if (t.columns.filter(c=>c.visible!==false).reduce((sum,c)=>sum+c.width,0)>width+0.01) fail('表体列宽合计超过可打印宽度');
  if (!t.columns.some(c=>c.visible!==false)) fail('至少显示一列表体');
  const extra=t.headerHeight+(t.subtotal?t.rowHeight:0)+(t.total?t.rowHeight:0);
  const capacity=Math.floor((l.bands.body-extra)/t.rowHeight);
  if (capacity<1||t.rowsPerPage>capacity) fail('每页行数超过表体高度可容纳的行数');
  if (!finite(l.grid??2,0.5,10)) fail('网格尺寸无效');
  if (l.background!=null&&!/^[a-f0-9]{64}$/.test(l.background)) fail('套打底图编号无效');
  return clone({...value,paper:{...p,orientation:p.width>p.height?'landscape':'portrait'}});
}
function validateFormat(value) {
  for(const key of ['visible','bold','border','wrap','hideZero','thousands','currency'])
    if(value[key]!=null&&typeof value[key]!=='boolean')fail('格式开关必须为布尔值');
  if (value.decimals!=null&&(!Number.isInteger(value.decimals)||value.decimals<0||value.decimals>8)) fail('小数位须为 0–8');
  if (value.dateFormat!=null&&!['YYYY-MM-DD','YYYY/MM/DD','YYYY年MM月DD日','YYYY-MM-DD HH:mm'].includes(value.dateFormat)) fail('日期格式无效');
  if (value.align!=null&&!['left','center','right'].includes(value.align)) fail('对齐方式无效');
}
export function evaluatePrintExpression(expression,fields) {
  const byLabel=Object.fromEntries(Object.entries(printFields).map(([key,label])=>[label,key]));
  Object.assign(byLabel,{'含税金额':'gross','合计金额':'baseAmount','应收/应付合计':'total'});
  const replaced=String(expression).replace(/\{([^}]+)\}/g,(_,name)=>{
    const key=Object.hasOwn(printFields,name)?name:byLabel[name];
    if (!key) fail('表达式字段不存在：'+name);
    const value=Number(fields[key]??0);
    if (!Number.isFinite(value)) fail('表达式只能使用数值字段');
    return '('+value+')';
  });
  if (replaced.length>5000||!/^[\d\s.+*/()\-]+$/.test(replaced)) fail('表达式仅支持字段、数字和加减乘除括号');
  const tokens=replaced.match(/\d+(?:\.\d+)?|\.\d+|[()+*/-]/g)||[];
  let index=0,depth=0;
  const atom=()=>{
    if (++depth>50) fail('表达式嵌套过深');
    let value;
    const token=tokens[index++];
    if (token==='(') {value=sum();if(tokens[index++]!==')') fail('表达式括号不匹配');}
    else if(token==='-'||token==='+') value=(token==='-'?-1:1)*atom();
    else {value=Number(token);if(token==null||!Number.isFinite(value)) fail('表达式无效');}
    depth--;return value;
  };
  const product=()=>{let value=atom();while(['*','/'].includes(tokens[index])){const op=tokens[index++],right=atom();value=op==='*'?value*right:right===0?0:value/right;}return value;};
  const sum=()=>{let value=product();while(['+','-'].includes(tokens[index])){const op=tokens[index++],right=product();value=op==='+'?value+right:value-right;}return value;};
  const result=sum();
  if(index!==tokens.length||!Number.isFinite(result)) fail('表达式无效');
  return result;
}
export function uppercaseRmb(value) {
  if (!Number.isSafeInteger(value)||Math.abs(value)>99999999999999) return '';
  const negative=value<0;value=Math.abs(value);
  const digits='零壹贰叁肆伍陆柒捌玖',units=['','拾','佰','仟'],groups=['','万','亿','兆'];
  let integer=Math.floor(value/100),result='',group=0,pending=false;
  while(integer>0) {
    const part=integer%10000;
    if(part) {
      let text='',zero=false;
      for(let i=3;i>=0;i--) {
        const digit=Math.floor(part/10**i)%10;
        if(digit){if(zero)text+='零';text+=digits[digit]+units[i];zero=false;}
        else if(text)zero=true;
      }
      result=text+groups[group]+(pending&&result?'零':'')+result;
      pending=part<1000;
    } else if(result)pending=true;
    integer=Math.floor(integer/10000);group++;
  }
  result=(negative?'负':'')+(result||'零')+'元';
  const jiao=Math.floor(value/10)%10,fen=value%10;
  if(jiao)result+=digits[jiao]+'角';
  if(fen)result+=(jiao?'':'零')+digits[fen]+'分';
  else result+='整';
  return result;
}
export function formatPrintValue(value,format={},key='') {
  if(value==null)return '';
  if(format.hideZero&&Number(value)===0)return '';
  if(key==='date'||key==='production'||key==='printTime') {
    const match=String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if(!match)return String(value);
    const [,y,m,d,h='00',minute='00']=match;
    return (format.dateFormat||'YYYY-MM-DD').replace('YYYY',y).replace('MM',m).replace('DD',d).replace('HH',h).replace('mm',minute);
  }
  if(typeof value==='number') {
    const digits=format.decimals??(moneyFields.has(key)?2:key==='quantity'?3:0);
    return (format.currency?'¥ ':'')+value.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits,useGrouping:!!format.thousands})+(['discount','rate'].includes(key)?'%':'');
  }
  return String(value);
}
export function paginatePrint(template,data) {
  validatePrintTemplate(template);
  const l=template.layout,t=l.table;
  const capacity=Math.floor((l.bands.body-t.headerHeight-(t.subtotal?t.rowHeight:0)-(t.total?t.rowHeight:0))/t.rowHeight);
  const size=t.rowsPerPage||capacity,lines=data.lines||[],pages=[];
  const total={quantity:0,baseAmount:0,net:0,tax:0,gross:0,debit:0,credit:0};
  const sum=rows=>{
    const sums={...total};
    for(const row of rows)for(const key of Object.keys(sums)){
      const scale=key==='quantity'?10000:100;
      sums[key]+=Math.round(Number(row[key]||0)*scale)*(row.totalSign??1);
    }
    return Object.fromEntries(Object.entries(sums).map(([key,value])=>[key,value/(key==='quantity'?10000:100)]));
  };
  for(let start=0;start<Math.max(1,lines.length);start+=size) {
    const rows=lines.slice(start,start+size);
    pages.push({rows,blanks:t.fillBlank?size-rows.length:0,subtotal:sum(rows)});
  }
  const totals=sum(lines);
  return pages.map((page,index)=>({...page,index:index+1,count:pages.length,last:index===pages.length-1,
    totals,fields:{...data.fields,page:'第 '+(index+1)+' 页 / 共 '+pages.length+' 页',uppercase:uppercaseRmb(Math.round(Number(data.fields.total||0)*100))}}));
}
export const shapePrintStyle=el=>(el.kind==='line'?'border-top:':'border:')+(el.lineWidth??0.2)+'mm '+(el.lineStyle||'solid')+' '+(el.color||'#222222')+';';
const styleOf=el=>'font-family:'+escapePrint(el.font||'Microsoft YaHei')+';font-size:'+(el.fontSize||10)+'pt;font-weight:'+(el.bold?'700':'400')+
  ';text-align:'+(el.align||'left')+';white-space:'+(el.wrap===false?'nowrap':'pre-wrap')+';border:'+(el.border?'0.2mm solid #111':'0')+';';
const symbolCache=new Map();let symbolBuilds=0;
export function cachedPrintSymbol(kind,value,build) {
  const key=kind+':'+String(value);
  if(symbolCache.has(key))return symbolCache.get(key);
  const result=build();symbolBuilds++;
  if(symbolCache.size>=256)symbolCache.delete(symbolCache.keys().next().value);
  symbolCache.set(key,result);return result;
}
export const printSymbolCacheInfo=()=>({size:symbolCache.size,builds:symbolBuilds});
export function renderPrintPages(template,data,{preview=true,pageMargins=false,pageIndex=null}={}) {
  const p=template.paper,l=template.layout;
  const left=pageMargins?0:p.margin.left,top=pageMargins?0:p.margin.top;
  const pageWidth=pageMargins?p.width-p.margin.left-p.margin.right:p.width;
  const pageHeight=pageMargins?p.height-p.margin.top-p.margin.bottom:p.height;
  const offsets={};let y=top;
  for(const band of printBands){offsets[band]=y;y+=l.bands[band];}
  const pages=paginatePrint(template,data);
  return pages.filter((_,index)=>pageIndex==null||index===pageIndex).map(page=>{
    const elements=l.elements.filter(el=>el.band!=='header'||page.index===1).filter(el=>el.band!=='footer'||page.last);
    const markup=elements.map(el=>{
      const key=el.key||'',value=el.kind==='expression'?evaluatePrintExpression(el.expression||'0',page.fields):
        el.kind==='page'?page.fields.page:el.kind==='time'?page.fields.printTime:el.kind==='text'?el.text:page.fields[key]??page.fields.number;
      let html=escapePrint(formatPrintValue(value,el,key));
      if(el.kind==='image')html=el.asset?'<img alt="" src="/api/print-assets/'+el.asset+'">':'';
      if(el.kind==='barcode') {
        const bars=cachedPrintSymbol('barcode',value,()=>code39(String(value||'')));
        if(!bars)html='<span>条码内容不支持</span>';
        else {let x=0;const rects=bars.map((w,i)=>{const rect=i%2?'':'<rect x="'+x+'" y="0" width="'+w+'" height="30"/>';x+=w;return rect;}).join('');
          html='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+x+' 36" preserveAspectRatio="none">'+rects+'<text x="'+x/2+'" y="35" text-anchor="middle" font-size="5">'+escapePrint(value)+'</text></svg>';}
      }
      if(el.kind==='qr'){try{html=cachedPrintSymbol('qr',value,()=>qrSvg(String(value||'')));}catch{html='二维码内容过长';}}
      if(el.kind==='line'||el.kind==='rect')html='';
      return '<div class="pt-element" style="left:'+(left+el.x)+'mm;top:'+(offsets[el.band]+el.y)+'mm;width:'+el.w+'mm;height:'+el.h+'mm;'+styleOf(el)+
        (['line','rect'].includes(el.kind)?shapePrintStyle(el):'')+'">'+html+'</div>';
    }).join('');
    const columns=l.table.columns.filter(c=>c.visible!==false);
    const cells=(row,totalLabel)=>{
      const firstTotal=columns.findIndex(c=>Object.hasOwn(page.totals,c.key));
      const span=totalLabel&&firstTotal>0?firstTotal:0;
      const label=span?'<td colspan="'+span+'"><div class="pt-cell-content">'+escapePrint(totalLabel)+'</div></td>':'';
      return label+columns.slice(span).map((c,index)=>{
        const value=formatPrintValue(row[c.key],c,c.key);
        const text=totalLabel&&!span&&index===0?totalLabel+(value?' '+value:''):value;
        return '<td style="text-align:'+(c.align||'left')+'"><div class="pt-cell-content" style="white-space:'+(c.wrap===false?'nowrap':'normal')+'">'+escapePrint(text)+'</div></td>';
      }).join('');
    };
    const rows=page.rows.map(row=>'<tr>'+cells(row)+'</tr>').join('')+
      Array.from({length:page.blanks},()=>'<tr>'+columns.map(()=>'<td><div class="pt-cell-content">&nbsp;</div></td>').join('')+'</tr>').join('')+
      (l.table.subtotal?'<tr class="pt-total">'+cells(page.subtotal,'本页小计')+'</tr>':'')+
      (l.table.total&&page.last?'<tr class="pt-total">'+cells(page.totals,'合计')+'</tr>':'');
    return '<section class="pt-page" style="width:'+pageWidth+'mm;height:'+pageHeight+'mm">'+
      (preview&&l.background?'<img class="pt-background" alt="" src="/api/print-assets/'+l.background+'">':'')+markup+
      '<table class="pt-body" style="left:'+left+'mm;top:'+offsets.body+'mm;width:'+columns.reduce((sum,column)=>sum+column.width,0)+'mm;--pt-row:'+l.table.rowHeight+'mm;--pt-head:'+l.table.headerHeight+'mm">'+
      '<colgroup>'+columns.map(c=>'<col style="width:'+c.width+'mm">').join('')+'</colgroup><thead><tr>'+columns.map(c=>'<th>'+escapePrint(c.title)+'</th>').join('')+
      '</tr></thead><tbody>'+rows+'</tbody></table></section>';
  }).join('');
}
