import { showSystemPrompt, clearSystemPrompts, chineseMessage, validateForm } from './system-prompt.js';
import { permits, permissionModules, permissionLabels, documentTypesFor } from './permissions.js';
import { costMethods, defaultSystemSettings, documentTaxInclusive, lineAmounts, roundDecimal, unitPrice } from './system-settings.js';
import { documentFields, documentDefaults, fieldSections } from './document-settings.js';
import { families, masters, reports, statusNames, stockEffects, relatedDocuments, settlementFooters, logisticsFooters, orderFulfillment } from './catalog.js';
import { productUnits, unitDetails, defaultProductUnit } from './units.js';
import { code39 } from './barcode.js';
import { showDocumentPicker, closePicker } from './document-picker.js';

const root=document.querySelector('#app');
const dialog=document.querySelector('#editor');
const systemPrompt=document.querySelector('#system-prompt');
const confirmAction=message=>showSystemPrompt(message,{cancelLabel:'取消'});
async function confirmDiscard(onDiscard) {
  if (await showSystemPrompt('确认退出？数据将不被保留。',{cancelLabel:'继续编辑',confirmLabel:'确认退出'})) return onDiscard();
}

const documentEditor=document.createElement('section');
documentEditor.id='document-editor';
documentEditor.className='document-editor';
const state={user:null,active:'home',tabs:['home'],group:'',folded:false,flow:'sale',pages:new Map(),editor:null};
const documentTabs=new Map();
const maxDocumentLines=500;
const hasLineItem=line=>Boolean(line?.product||line?.ledgerAccount);
let nextDocumentTab=0;
const tabRoute=id=>documentTabs.get(id)?.route||routes[id];
const roleNames={admin:'管理员',clerk:'制单员',reviewer:'审核员',viewer:'只读职员'};
const actions={submit:'提交审核',approve:'通过审核',unapprove:'反审核',reject:'驳回',post:'记账',settle:'确认结算',stop:'截停',delete:'删除',restore:'恢复'};
const transitions={draft:['submit','stop','delete'],pending:['approve','reject','stop'],approved:['post','unapprove'],posted:['settle'],rejected:['submit','delete'],stopped:['restore','delete'],deleted:['restore']};
const groups={'资料':'▦','采购':'⇣','销售':'⇡','客户':'♧','仓储':'▤','库存':'▥','财务':'¥','综合':'▧','系统':'⚙'};
const routes={home:{label:'工作台',group:'首页'}};
for (const group of Object.keys(groups)) routes['g:'+group]={label:group,group};
for (const [key,[label,group]] of Object.entries(masters)) routes['m:'+key]={label,group,kind:'master',key};
for (const [key,[label,,group]] of Object.entries(families)) {
  const newLabel=key==='count'?'新增盘点':label.includes('分摊')||group==='财务'||key.startsWith('opening')?label:'新增'+label;
  const listLabel=key==='count'?'盘点记录':key==='transfer'?'调拨单查询':label.endsWith('订单')||['inquiry','quote'].includes(key)?label+'管理':label+'查询';
  routes['n:'+key]={label:newLabel,group,kind:'new',key};
  routes['d:'+key]={label:listLabel,group,kind:'docs',key};
}
for (const [group,names] of Object.entries(reports)) for (const name of names) routes['r:'+name]={label:name,group,kind:'report',key:name};
for (const [key,label,group,status] of [
  ['all','单据中心','综合',''],['draft','单据草稿','综合','draft,rejected'],['pending','单据审核中心','综合','pending,approved'],
  ['purchase','采购单据查询','采购',''],['sales','销售单据查询','销售',''],['stock','库存变动单据查询','仓储',''],['finance','财务单据查询','财务','']
]) routes['l:'+key]={label,group,kind:'docs',filter:key==='all'||status?'':group,status};
routes['data-backups']={label:'数据备份',group:'系统',kind:'maintenance'};
routes['data-rebuild']={label:'数据重建',group:'系统',kind:'maintenance'};
routes['staff-permissions']={label:'职员权限',group:'系统',kind:'permissions'};
const allow=(id,action)=>permits(state.user,id,action);
const canSave=(type,action='create')=>allow('d:'+type,action);
const mayConfigure=type=>canSave(type)||canSave(type,'edit');
const canMaintain=key=>allow('m:'+key,'master');
const listedDocumentTypes=(route,action='view')=>documentTypesFor(state.user,action).filter(type=>
  (!route.key||route.key===type)&&(!route.filter||route.filter===families[type][2]));
function routeAllows(id,action='view') {
  const route=tabRoute(id);
  if (!route?.kind) return !!route;
  if (['permissions','maintenance'].includes(route.kind)) return state.user?.role==='admin';
  if (route.kind==='new') return canSave(route.key);
  if (route.kind==='docs') {
    const types=listedDocumentTypes(route,action);
    return action==='print'?types.length>0&&types.length===listedDocumentTypes(route).length:types.length>0;
  }
  if (route.kind==='document-view') return true;
  return allow(id,action);
}
const showRoute=id=>routeAllows(id);
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const e=escape;
const money=cents=>(Number(cents||0)/100).toFixed(2);
const currentDate=()=>new Date().toLocaleDateString('sv-SE');
const weekDate=()=>new Intl.DateTimeFormat('zh-CN',{dateStyle:'full'}).format(new Date());
const glyph=s=>'<span class="glyph" aria-hidden="true">'+e(s)+'</span>';
const btn=(label,action,value='',cls='')=>'<button type="button" class="btn '+e(cls)+'" data-act="'+e(action)+'" data-value="'+e(value)+'">'+e(label)+'</button>';
const go=(id,label,cls='')=>showRoute(id)?btn(label||routes[id].label,'open',id,cls):'';
const options=(list,value,placeholder='请选择')=>'<option value="">'+e(placeholder)+'</option>'+list.map(([key,label])=>'<option value="'+e(key)+'"'+(String(value??'')===String(key)?' selected':'')+'>'+e(label)+'</option>').join('');
const input=(key,value='',attrs='')=>'<input name="'+e(key)+'" value="'+e(value)+'" '+attrs+'>';
const select=(key,list,value,attrs='',placeholder)=>'<select name="'+e(key)+'" '+attrs+'>'+options(list,value,placeholder)+'</select>';
const field=(label,control,required=false,cls='')=>'<label class="field '+cls+'"><span>'+e(label)+(required?'<b class="req">*</b>':'')+'</span>'+control+'</label>';
const checkbox=(name,value,label)=>'<label class="check"><input type="checkbox" name="'+e(name)+'" '+(value?'checked':'')+'>'+e(label)+'</label>';
const searchParams = values => new URLSearchParams(Object.entries(values).filter(([,v])=>v!==''&&v!=null)).toString();
const table=(headers,rows,className="")=>'<div class="scroll-table"><table class="'+e(className)+'"><thead><tr>'+headers.map(h=>'<th>'+e(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
const cells=row=>'<tr>'+row.map(value=>'<td>'+e(value)+'</td>').join('')+'</tr>';
const empty=message=>'<div class="empty">'+e(message)+'</div>';
const skeleton=()=>'<div class="skeleton" aria-label="正在查询">'+Array(5).fill('<i></i>').join('')+'</div>';
const exportLink=(base,params)=>'<a class="btn" data-act="download-file" href="'+e(base+'?'+searchParams({...params,export:'1'}))+'">导出 Excel</a>';
const menu=(text,buttons)=>'<details class="details-menu"><summary class="btn">'+e(text)+' ⌄</summary><div class="menu-list">'+buttons.join('')+'</div></details>';
async function api(path,values) {
  let response;
  try {
    response=await fetch(path,values===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});
  } catch {
    throw Error('无法连接系统，请检查网络后重试。');
  }
  const data=await response.json().catch(()=>{throw Error('系统暂时无法响应，请稍后重试。');});
  if (!response.ok) {
    if (response.status===401&&state.user) {state.user=null;showLogin();}
    throw Object.assign(Error(data.message||data.error||'请求失败'),{code:data.code,field:data.field,documentId:data.documentId});
  }
  return data;
}
function showLogin() {
  closePicker();
  clearSystemPrompts();
  documentTabs.clear();
  documentEditor.replaceChildren();
  state.editor=null;
  if (dialog.open) dialog.close();
  root.innerHTML='<main class="login"><section class="login-art"><span class="brand-mark">恒</span><h1>恒序进销存</h1><p>管理门店与仓库的采购、销售、库存和资金往来。</p></section><section class="login-side"><h2>登录工作台</h2><form novalidate id="login-form">'+field('用户名',input('username','','required autocomplete="username"'),true)+field('密码',input('password','','required type="password" autocomplete="current-password"'),true)+'<button class="btn primary">登录</button></form></section></main>';
  document.querySelector('#login-form').addEventListener('submit', async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    form.querySelector('button').disabled=true;
    try {
      state.user=await api('/api/login',Object.fromEntries(new FormData(form)));
      state.active='home'; state.tabs=['home']; state.group='';state.pages.clear();
      await mount();
    } catch (error) {showError(error);}
    finally {form.querySelector('button').disabled=false;}
  });
}
function refreshTabs() {
  const strip=document.querySelector('.tabs');
  if (!strip) return;
  strip.innerHTML=state.tabs.map(id=>'<div class="tab '+(id===state.active?'active':'')+'"><button type="button" role="tab" aria-selected="'+(id===state.active)+'" data-act="open" data-value="'+e(id)+'">'+(id==='home'?'⌂　':'')+e(tabRoute(id).label)+'</button>'+(id==='home'?'':'<button type="button" class="close-tab" aria-label="关闭'+e(tabRoute(id).label)+'" data-act="close-tab" data-value="'+e(id)+'">×</button>')+'</div>').join('');
}
function removeTab(id) {
  const index=state.tabs.indexOf(id);
  if (index<=0) return;
  state.tabs.splice(index,1);
  if (documentTabs.delete(id)) state.pages.delete(id);
  if (state.active===id) {
    state.active=state.tabs[index-1];
    state.group=tabRoute(state.active).group;
  }
}
function closeTab(id) {
  const editor=documentTabs.get(id);
  if (editor?.busy) {
    showSystemPrompt('请等待单据保存完成');
    return;
  }
  const close=()=>{
    const active=state.active===id;
    removeTab(id);
    return active?mount():refreshTabs();
  };
  if (editor?.dirty) return confirmDiscard(close);
  return close();
}
function shell() {
  const selected=tabRoute(state.active);
  const nav=Object.entries(groups).map(([group,icon])=>{
    const open=state.group===group;
    const routeButtons=open?'<div class="subnav">'+Object.entries(routes).filter(([id,r])=>r.group===group&&r.kind&&showRoute(id)).map(([id,r])=>'<button type="button" data-act="open" data-value="'+e(id)+'" class="'+(id===state.active?'selected':'')+'">'+e(r.label)+'</button>').join('')+'</div>':'';
    return '<div><button class="nav-row '+(selected.group===group?'active':'')+'" aria-expanded="'+open+'" aria-label="'+e(group)+'" title="'+e(group)+'" data-act="group" data-value="'+e(group)+'"><span class="nav-icon">'+icon+'</span><span class="nav-copy">'+e(group)+'</span><span class="nav-arrow">›</span></button>'+routeButtons+'</div>';
  }).join('');
  root.innerHTML='<div class="shell '+(state.folded?'folded':'')+'"><aside class="sidebar"><div class="brand"><span class="brand-mark">恒</span><span class="nav-copy">恒序进销存</span></div><div class="nav-caption">工作空间</div><div class="nav-scroll"><button title="工作台" class="nav-row '+(state.active==='home'?'active':'')+'" data-act="open" data-value="home">'+glyph('⌂')+'<span class="nav-copy">工作台</span></button>'+nav+'</div><div class="nav-foot"><button class="nav-row" data-act="fold" title="折叠或展开导航">'+glyph('☰')+'<span class="nav-copy">折叠导航</span></button></div></aside>'+
    '<header class="topbar"><div class="top-heading"><span>◇</span> 零售批发工作台</div><div class="search">'+glyph('⌕')+'<input type="search" id="function-search" placeholder="输入关键词搜索功能" aria-label="搜索功能" autocomplete="off"><div id="search-results" class="search-results" hidden></div></div>'+
    '<div class="profile"><button class="icon-btn" data-act="notice" aria-label="消息通知">'+glyph('♧')+'</button><span class="avatar">'+e(state.user.name.slice(0,1))+'</span><span class="profile-name">'+e(state.user.name)+'</span><button class="icon-btn" title="退出登录" aria-label="退出登录" data-act="logout">↪</button></div></header>'+
    '<div class="tabs" role="tablist"></div><main class="content" id="content"></main></div>';
  refreshTabs();
  const input=document.querySelector('#function-search');
  const results=document.querySelector('#search-results');
  input.addEventListener('input',()=>{
    const term=input.value.trim().toLowerCase();
    results.hidden=!term;
    const matches=Object.entries(routes).filter(([id,value])=>showRoute(id)&&value.label.toLowerCase().includes(term)).slice(0,16);
    results.innerHTML=matches.map(([id,r])=>go(id,r.label+' · '+r.group)).join('')||'<div class="note">没有匹配的功能</div>';
  });
  input.addEventListener('keydown',event=>{
    if (event.key==='Escape') {results.hidden=true;input.blur();}
    if (event.key==='Enter'&&!results.hidden) results.querySelector('button')?.click();
  });
}
const shortcuts=[
  ['m:products','▦','blue'],['m:partners','♧','green'],['n:purchase','⇣','orange'],
  ['n:sale','⇡','purple'],['r:往来单位应收应付','¥','green'],['l:all','▤','blue'],
  ['m:supplierPrices','◈','orange'],['r:库存状况查询','▥','purple'],['r:经营报告','▧','blue']
];
const flowNodes={
  sale:[['n:quote','报价单'],['n:salesOrder','销售订单'],['n:sale','销售出库单'],['r:往来单位应收应付','应收'],['n:receipt','收款']],
  purchase:[['n:purchaseOrder','采购订单'],['n:purchase','采购入库'],['r:按单结算查询','可按单结算'],['r:往来单位应收应付','应付增加'],['r:库存状况查询','库存增加'],['n:payment','付款单'],['r:往来单位应收应付','应付减少'],['r:现金银行变动表','资产减少'],['r:往来单位应收应付','应付款查询'],['r:库存状况查询','库存查询'],['r:现金银行变动表','账户余额查询']]
};
function accessibleRoute(id) {return showRoute(id)?id:id.startsWith('n:')?'d:'+id.slice(2):id;}
function home() {
  const productUpdates=[['单据中心可查询草稿、待审核与已记账单据','l:all','单据'],['库存状况支持按仓库查询','r:库存状况查询','库存'],['经营报告支持按日和按月查看','r:经营报告','报表']];
  return '<div class="dashboard"><section class="hero"><div><p class="date">'+e(weekDate())+'</p><h1>工作台</h1></div><div class="hero-side">'+e(roleNames[state.user.role])+'</div></section>'+
  '<div class="dashboard-grid"><div class="stack"><section class="card"><div class="section-head"><h2>常用功能</h2></div><div class="shortcut-grid">'+shortcuts.filter(([id])=>showRoute(accessibleRoute(id))).map(([id,icon,tone])=>{
    const target=accessibleRoute(id);
    return '<button class="shortcut" data-act="open" data-value="'+e(target)+'"><span class="tile-icon" data-tone="'+tone+'">'+e(icon)+'</span><span>'+e(routes[target].label)+'</span><span class="chevron" aria-hidden="true">›</span></button>';
  }).join('')+'</div></section><section class="card"><div class="section-head"><h2>业务流程</h2><div class="segment"><button data-act="flow" data-value="sale" class="'+(state.flow==='sale'?'selected':'')+'">销售流程</button><button data-act="flow" data-value="purchase" class="'+(state.flow==='purchase'?'selected':'')+'">采购流程</button></div></div><div class="flow-list">'+flowNodes[state.flow].filter(([id])=>showRoute(accessibleRoute(id))).map(([id,label])=>'<button class="flow-node" data-act="open" data-value="'+e(accessibleRoute(id))+'">'+e(label)+'</button>').join('<span class="flow-arrow" aria-hidden="true">→</span>')+'</div></section></div>'+
  '<div class="stack"><section class="card"><div class="section-head"><h2>产品更新</h2></div><div class="updates">'+productUpdates.filter(([,id])=>showRoute(id)).map(([label,id,type])=>'<div class="update"><span class="dot"></span><a class="link" href="#" data-act="open" data-value="'+e(id)+'">'+e(label)+'</a><time>'+e(type)+'</time></div>').join('')+'</div></section><section class="card"><div class="section-head"><h2>帮助与支持</h2></div><div class="support-grid">'+[['◌','在线咨询'],['♧','专属客服'],['✎','需求反馈'],['↓','组件下载']].map(([icon,label])=>'<button data-act="support" data-value="'+e(label)+'">'+glyph(icon)+e(label)+'</button>').join('')+'</div></section></div></div></div>';
}
function pageState(id=state.active) {
  if (!state.pages.has(id)) state.pages.set(id,{params:{page:1,...(id==='m:partners'?{active:'1'}:{})},requested:id!=='r:库存状况查询',detail:null});
  return state.pages.get(id);
}
function openRoute(id) {
  const search = document.querySelector('#search-results');
  if (search) search.hidden=true;
  const route=tabRoute(id);
  if (!route||!showRoute(id)) return;
  if (route.kind==='new') return editDocument(route.key);
  if (!state.tabs.includes(id)) state.tabs.push(id);
  state.active=id;
  if (route.group!=='首页') state.group=route.group;
  return mount();
}
function title(route) {return '<div class="page-title"><div><p class="crumb">工作台　/　'+e(route.group)+'</p><h1>'+e(route.label)+'</h1></div></div>';}
function directory(route) {
  return title(route)+'<section class="card"><div class="section-head"><h2>功能目录</h2></div><div class="shortcut-grid">'+Object.entries(routes).filter(([id,r])=>r.group===route.group&&r.kind&&showRoute(id)).map(([id,r])=>'<button class="shortcut" data-act="open" data-value="'+e(id)+'"><span class="tile-icon" data-tone="blue">'+glyph(groups[route.group])+'</span>'+e(r.label)+'<span class="chevron">›</span></button>').join('')+'</div></section>';
}
async function renderSystemSettings(content) {
  content.innerHTML='<section class="card system-config">'+skeleton()+'</section>';
  try {
    const settings=await api('/api/system-settings');
    if (state.active!=='m:settings'||!content.isConnected) return;
    const choice=(key,values)=>select(key,values,settings[key],'required');
    const digits=[0,1,2,3,4].map(value=>[value,value]);
    const taxPrices=[['inclusive','默认含税'],['exclusive','默认不含税']];
    const notes={
      monthly:'以期初结余和本月入库计算统一的月出库成本。',
      moving:'按仓库库存金额与数量计算平均成本。可指定盘盈和无来源退货的入库成本来源。',
      individual:'按商品批次核算和结转成本，适用于批次成本不同的商品。'
    };
    const algorithms=costMethods.map(([key,label])=>'<div class="system-cost-method">'+
      checkbox('method.'+key,settings.costMethods.includes(key),label)+
      (key==='moving'?'<details class="system-cost-source"><summary>设置成本取值来源</summary>'+
        field('盘盈和无来源退货',choice('movingSource',[['stock','库存均价优先'],['document','单据单价优先']]))+'</details>':'')+
      '<p>'+e(notes[key])+'</p></div>').join('');
    content.innerHTML=title(routes['m:settings'])+'<div class="toolbar">'+go('staff-permissions')+'</div><form novalidate class="card system-config">'+
      '<section><h2>成本算法</h2>'+algorithms+'</section>'+
      '<section><h2>小数位数设置</h2><div class="system-config-row">'+
      field('数量',choice('quantityDigits',digits))+field('折扣',choice('discountDigits',digits))+
      field('单价',choice('priceDigits',digits))+'</div></section>'+
      '<section><h2>财务设置</h2><div class="system-config-row">'+checkbox('taxEnabled',settings.taxEnabled,'系统管税')+
      field('计税方式',choice('taxMode',[['general','一般计税'],['simple','简易计税']]))+'</div>'+
      '<div class="system-config-row">'+field('采购价格',choice('purchaseTax',taxPrices))+
      field('线下销售价格',choice('saleTax',taxPrices))+'</div><div class="system-config-row">'+
      checkbox('manualClose',settings.manualClose,'手工月结存')+
      '<span class="note">月结后，已结期间的单据受锁定保护。</span></div></section>'+
      '<button type="submit" class="btn primary">保存配置</button></form>';
    const form=content.querySelector('form');
    const bindTax=()=>{for (const key of ['taxMode','purchaseTax','saleTax']) form.elements[key].disabled=!form.elements.taxEnabled.checked;};
    bindTax();
    form.elements.taxEnabled.addEventListener('change',bindTax);
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const button=form.querySelector('[type=submit]');
      if (button.disabled) return;
      button.disabled=true;
      try {
        const values={costMethods:costMethods.map(([key])=>key).filter(key=>form.elements['method.'+key].checked)};
        for (const key of ['quantityDigits','discountDigits','priceDigits']) values[key]=Number(form.elements[key].value);
        for (const key of ['movingSource','taxMode','purchaseTax','saleTax']) values[key]=form.elements[key].value;
        for (const key of ['manualClose','taxEnabled']) values[key]=form.elements[key].checked;
        await api('/api/system-settings',values);
        showSystemPrompt('系统配置已保存');
      } catch (failure) {showError(failure);}
      finally {button.disabled=false;}
    });
  } catch (error) {
    if (state.active==='m:settings'&&content.isConnected) {content.innerHTML=empty('加载失败');showError(error);};
  }
}
async function renderStaffPermissions(content) {
  content.innerHTML=title(routes['staff-permissions'])+'<section class="card system-config">'+skeleton()+'</section>';
  const panel=content.querySelector('section');
  try {
    const {staff}=await api('/api/staff-permissions');
    if (!panel.isConnected) return;
    panel.innerHTML='<div class="toolbar">'+field('职员',select('staff',staff.map(person=>[
      person.id,person.name+' · '+person.username+' · '+roleNames[person.role]+(person.active?'':' · 已停用')
    ]),pageState().staffId,staff.length?'':'disabled',staff.length?'请选择职员':'暂无职员'))+
      btn('新增职员','permission-add-staff')+
      field('模块分组',select('group',Object.keys(groups).map(group=>[group,group]),'','','全部分组'))+
      btn('全部沿用角色权限','staff-permissions-reset')+
      btn('保存权限','staff-permissions-save','','primary')+'</div>'+
      '<p class="note">'+(staff.length?'直接勾选权限即可自定义该模块。取消「自定义」可恢复角色权限。':'新增一名制单员、审核员或只读职员后，即可设置下方模块的权限。')+'</p>'+
      '<div class="permission-matrix"></div>';
    const picker=panel.querySelector('[name=staff]');
    const group=panel.querySelector('[name=group]');
    const matrix=panel.querySelector('.permission-matrix');
    const save=panel.querySelector('[data-act=staff-permissions-save]');
    const reset=panel.querySelector('[data-act=staff-permissions-reset]');
    let selected, draft={}, dirty=false;
    function draw() {
      const scroll=matrix.querySelector('.scroll-table')?.scrollTop||0;
      const displayed=permissionModules.filter(module=>!group.value||module.group===group.value);
      const expanded=new Set([...matrix.querySelectorAll('details[open]')].map(node=>node.closest('tr').dataset.module));
      matrix.innerHTML=table(['功能模块','查看','操作','打印','权限来源'],displayed.map(module=>{
        const custom=Object.hasOwn(draft,module.id);
        const user=selected&&{role:selected.role,permissions:draft};
        const control=action=>'<label class="check"><input type="checkbox" data-action="'+action+'" aria-label="'+e(module.label+' · '+permissionLabels[action])+'"'+
          (permits(user,module.id,action)?' checked':'')+
          (!selected||action!=='view'&&!permits(user,module.id)?' disabled':'')+'><span>'+e(permissionLabels[action])+'</span></label>';
        const operations=module.actions.filter(action=>!['view','print'].includes(action));
        const count=operations.filter(action=>permits(user,module.id,action)).length;
        const operationPanel=operations.length?'<details'+(expanded.has(module.id)?' open':'')+'><summary>操作（'+count+'/'+operations.length+'）</summary>'+
          '<div class="permission-actions">'+operations.map(control).join('')+'</div></details>':'<span class="note">—</span>';
        const source='<label class="check"><input type="checkbox" name="custom"'+(custom?' checked':'')+
          (!selected?' disabled':'')+' aria-label="'+e(module.label+' · 自定义')+'">自定义</label>';
        return '<tr data-module="'+e(module.id)+'"><td><strong>'+e(module.label)+'</strong><small>'+e(module.group)+'</small></td>'+
          '<td>'+control('view')+'</td><td>'+operationPanel+'</td><td>'+control('print')+'</td><td>'+source+'</td></tr>';
      }));
      matrix.querySelector('.scroll-table').scrollTop=scroll;
    }
    const load=async()=>{
      if (dirty&&!await confirmAction('切换职员会放弃未保存的修改，确定切换？')) {
        picker.value=selected.id;
        return;
      }
      selected=staff.find(person=>String(person.id)===picker.value);
      pageState().staffId=picker.value;
      dirty=false;
      save.disabled=reset.disabled=true;
      matrix.innerHTML=selected?skeleton():'';
      const person=selected;
      if (!person) {draft={};draw();return;}
      try {
        const response=await api('/api/staff-permissions/'+person.id);
        if (person!==selected||!panel.isConnected) return;
        draft=response.permissions;
        draw();
        save.disabled=reset.disabled=false;
      } catch (error) {
        if (person===selected) {matrix.replaceChildren();showError(error);}
      }
    };
    picker.addEventListener('change',load);
    group.addEventListener('change',()=>{if (!selected||!save.disabled) draw();});
    matrix.addEventListener('change',event=>{
      const control=event.target;
      const id=control.closest('tr')?.dataset.module;
      if (!id) return;
      const module=permissionModules.find(item=>item.id===id);
      if (control.name==='custom') {
        if (control.checked) draft[id]=module.actions.filter(action=>permits({role:selected.role},id,action));
        else delete draft[id];
      } else if (control.dataset.action) {
        const action=control.dataset.action;
        draft[id]??=module.actions.filter(item=>permits({role:selected.role},id,item));
        draft[id]=control.checked?[...new Set([...draft[id],action])]:action==='view'?[]:draft[id].filter(item=>item!==action);
      }
      dirty=true;
      draw();
      const row=[...matrix.querySelectorAll('tr[data-module]')].find(item=>item.dataset.module===id);
      row?.querySelector(control.name==='custom'?'[name=custom]':'[data-action="'+control.dataset.action+'"]')?.focus();
    });
    reset.addEventListener('click',async ()=>{
      if (await confirmAction('将该职员的全部模块恢复为角色权限？')) {
        draft={};
        dirty=true;
        draw();
      }
    });
    save.addEventListener('click',async ()=>{
      const person=selected;
      if (!person||save.disabled) return;
      save.disabled=reset.disabled=picker.disabled=true;
      matrix.inert=true;
      group.disabled=true;
      try {
        await api('/api/staff-permissions/'+person.id,{permissions:draft});
        dirty=false;
        showSystemPrompt('职员权限已保存');
      } catch (error) {showError(error);}
      finally {save.disabled=reset.disabled=picker.disabled=false;matrix.inert=false;group.disabled=false;}
    });
    if (!picker.value&&staff.length) picker.value=staff[0].id;
    await load();
  } catch (error) {
    if (panel.isConnected) {panel.innerHTML=empty('加载失败');showError(error);};
  }
}
const maintenancePath='/api/data-maintenance/';
const rebuildOptions=[
  ['products','商品信息及分类'],['bundles','套餐'],['partners','客户／供应商及分类'],
  ['carriers','物流公司'],['prices','价格本及阶梯价']
];

function renderDataMaintenance(content,routeId) {
  content.innerHTML=title(routes[routeId])+'<section class="card system-config"></section>';
  const section=content.querySelector('section');
  if (routeId==='data-backups') {
    section.innerHTML='<p>备份包含当前账套的资料、单据、附件和配置。备份文件仅管理员可下载。</p>'+
      '<div class="toolbar"><button type="button" class="btn primary">立即备份</button>'+go('data-rebuild')+
      '</div><div class="maintenance-results">'+skeleton()+'</div>';
    const results=section.querySelector('.maintenance-results');
    const create=section.querySelector('button');
    const refresh=async()=>{
      const {backups}=await api(maintenancePath+'backups');
      results.innerHTML=backups.length?table(['备份时间','类型','文件大小','操作'],backups.map(backup=>
        '<tr><td>'+e(new Date(backup.created).toLocaleString('zh-CN'))+'</td><td>'+e(backup.reason)+'</td><td>'+
        e((backup.size/1024/1024).toFixed(2)+' MB')+'</td><td><a class="btn" data-act="download-file" href="'+
        e(maintenancePath+'backups/'+backup.filename)+'">下载备份</a></td></tr>')):empty('暂无备份');
    };
    create.addEventListener('click',async()=>{
      create.disabled=true;
      try {
        await api(maintenancePath+'backups',{});
        await refresh();
        void showSystemPrompt('数据备份已完成。');
      } catch (error) {showError(error);}
      finally {create.disabled=false;}
    });
    refresh().catch(error=>{results.innerHTML=empty('无法读取备份列表');showError(error);});
    return;
  }

  section.innerHTML='<p>重建会清除全部单据（含订单和期初）、业务流水、库存余额、对账链接及月结记录。可同时清除下列基础资料。</p>'+
    '<p class="note">清除商品会同时清除套餐和价格本。清除客户／供应商会同时清除价格本。重建前自动创建备份，完成后需要重新登录。</p>'+
    '<form novalidate><fieldset><legend>同时清除基础资料</legend><div class="toolbar">'+
    checkbox('all','', '全选')+rebuildOptions.map(([key,label])=>checkbox(key,false,label)).join('')+
    '</div></fieldset><div class="toolbar"><button type="button" class="btn">预览重建范围</button>'+go('data-backups')+
    '</div><div class="maintenance-results"></div><div class="maintenance-confirm" hidden>'+
    field('输入「重建数据」',input('confirmation','','required autocomplete="off"'),true)+
    '<button type="submit" class="btn danger">执行重建</button></div></form>';
  const form=section.querySelector('form');
  const previewButton=form.querySelector('button');
  const results=form.querySelector('.maintenance-results');
  const confirmPanel=form.querySelector('.maintenance-confirm');
  const execute=form.querySelector('[type=submit]');
  const groups=()=>rebuildOptions.map(([key])=>key).filter(key=>form.elements[key].checked);
  let plan;
  let version=0;
  form.addEventListener('change',event=>{
    if (event.target.type!=='checkbox') return;
    if (event.target.name==='all') for (const [key] of rebuildOptions) form.elements[key].checked=event.target.checked;
    const size=groups().length;
    form.elements.all.checked=size===rebuildOptions.length;
    form.elements.all.indeterminate=size>0&&size<rebuildOptions.length;
    version++;
    plan=null;
    results.replaceChildren();
    confirmPanel.hidden=true;
    form.elements.confirmation.value='';
  });
  previewButton.addEventListener('click',async()=>{
    const requestVersion=++version;
    previewButton.disabled=true;
    try {
      const response=await api(maintenancePath+'preview',{groups:groups()});
      if (requestVersion!==version||!form.isConnected) return;
      plan=response;
      results.innerHTML=table(['清理范围','记录数'],plan.rows.map(row=>cells([row.label,row.count])));
      confirmPanel.hidden=false;
    } catch (error) {showError(error);}
    finally {previewButton.disabled=false;}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if (!plan||execute.disabled) return;
    if (form.elements.confirmation.value.trim()!=='重建数据') return showSystemPrompt('请输入「重建数据」确认。');
    execute.disabled=true;
    previewButton.disabled=true;
    try {
      const result=await api(maintenancePath+'rebuild',{groups:plan.selected,token:plan.token,confirmation:'重建数据'});
      state.user=null;
      catalogData=null;
      state.pages.clear();
      showLogin();
      void showSystemPrompt('数据重建完成。请重新登录，在「数据备份」下载 '+result.backup.filename+'。');
    } catch (error) {showError(error);}
    finally {execute.disabled=false;previewButton.disabled=false;}
  });
}

async function mount() {
  const previous=state.editor;
  if (previous?.kind==='document') {
    stashDocument();
    previous.scroll=documentEditor.querySelector('.modal-main')?.scrollTop||0;
  }
  const tab=documentTabs.get(state.active);
  state.editor=tab?.kind==='document'?tab:null;
  shell();
  const route=tabRoute(state.active);
  const content=document.querySelector('#content');
  if (state.editor) {
    content.classList.add('document-content');
    documentEditor.replaceChildren();
    content.append(documentEditor);
    renderDocument();
    document.querySelector('.tab.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
    return;
  }
  documentEditor.replaceChildren();
  if (route.kind==='document-view') {
    content.innerHTML='<section id="detail-area" class="card document-readout"></section>';
    updateDetails(pageState().detailTab||'items');
    document.querySelector('.tab.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
    return;
  }
  if (state.active==='home') {content.innerHTML=home();return;}
  if (route.key==='settings') return renderSystemSettings(content);
  if (route.kind==='permissions') return renderStaffPermissions(content);
  if (route.kind==='maintenance') return renderDataMaintenance(content,state.active);
  if (!route.kind) {content.innerHTML=directory(route);return;}
  const id=state.active;
  const data=pageState();
  content.innerHTML=(route.key==='partners'?'':title(route))+'<div class="module-layout '+(route.key==='partners'?'partner-layout':'')+'">'+
    (route.key==='products'?'<div class="card product-query" id="product-query"></div>':'')+
    '<aside class="card filters" id="page-filter"></aside><div id="page-main"></div></div>';
  renderFilters(route,data);
  renderPage(route,data);
  if (data.requested && !data.result) await loadPage(id);
}
function endpoint(route) {
  if (route.kind==='docs') return ['/api/documents',{type:route.key,group:route.filter,status:route.status}];
  if (route.kind==='master') return ['/api/master/'+route.key,{}];
  return ['/api/report',{name:route.key}];
}
async function loadPage(id=state.active) {
  const page=pageState(id);
  const route=routes[id];
  page.requested=true;
  page.result=null;page.error='';page.loading=true;page.detail=null;page.count=null;
  const request=(page.request||0)+1;
  page.request=request;
  if (state.active===id) renderPage(route,page);
  const [path,defaults]=endpoint(route);
  const params={...defaults,...page.params};
  const fetchRows=api(path+'?'+searchParams(params));
  if (route.kind!=='report'&&route.key!=='users') {
    api(path+'?'+searchParams({...params,countOnly:'1'})).then(data=>{
      if (page.request!==request) return;
      page.count=data.count;
      if (state.active===id && !page.loading) updatePaging(page);
    }).catch(()=>{});
  }
  try {
    const result=await fetchRows;
    if (page.request!==request) return;
    page.result=result;
    if (Number.isInteger(result.count)) page.count=result.count;
    if (['products','partners'].includes(route.key)&&!page.categories) {
      api(categoryEndpoint(route.key)).then(({paths})=>{
        page.categories=paths;
        if (state.active===id) renderCategoryTree(page);
      }).catch(error=>{if (state.active===id) showError(error);});
    }
  } catch (error) {if (page.request===request) {page.error='查询失败';if (state.active===id) showError(error);}}
  finally {
    if (page.request===request) {
      page.loading=false;
      if (state.active===id) renderPage(route,page);
    }
  }
}
const categoryEndpoint=kind=>kind==='partners'?'/api/partner-categories':'/api/product-categories';
const categoryLabel=kind=>kind==='partners'?'客户/供应商分类':'商品分类';
function renderCategoryTree(page) {
  const area=document.querySelector('#product-category-tree');
  if (!area) return;
  const paths=page.categories||[];
  const partners=state.active==='m:partners';
  const chosen=page.params.uncategorized==='1'?'∕':page.params.category||'';
  const query=(page.categorySearch||'').trim().toLowerCase();
  const visible=query?paths.filter(path=>path.toLowerCase().includes(query)||
    paths.some(child=>child.startsWith(path+'/')&&child.toLowerCase().includes(query))):paths;
  page.collapsedCategories??=new Set();
  const children=new Map();
  for (const path of visible) {
    const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
    if (!children.has(parent)) children.set(parent,[]);
    children.get(parent).push(path);
  }
  function nodes(parent) {
    return '<ul>'+ (children.get(parent)||[]).map(path=>{
      const branch=children.has(path);
      const open=query||!page.collapsedCategories.has(path);
      return '<li><div class="category-node '+(chosen===path?'selected':'')+'">'+
        (branch?'<button type="button" class="category-toggle" data-act="category-toggle" data-value="'+e(path)+'" aria-label="'+(open?'折叠':'展开')+e(path)+'" aria-expanded="'+Boolean(open)+'">'+(open?'▾':'▸')+'</button>':'<span class="category-toggle"></span>')+
        '<button type="button" class="category-name" data-act="category" data-value="'+e(path)+'">'+e(path.split('/').at(-1))+'</button></div>'+
        (branch&&open?nodes(path):'')+'</li>';
    }).join('')+'</ul>';
  }
  area.innerHTML='<div class="category-node '+(!chosen?'selected':'')+'">'+btn('全部'+categoryLabel(partners?'partners':'products'),'category')+'</div>'+
    nodes('')+(partners?'<div class="category-node '+(chosen==='∕'?'selected':'')+'">'+btn('未分类','category','∕')+'</div>':'')+(query&&!visible.length?'<p class="note">未找到分类</p>':'');
}
function editCategory(action) {
  const page=pageState();
  const path=page.params.category||'';
  if (action==='update'&&!path) return;
  const parent=action==='create'?path:path.slice(0,Math.max(0,path.lastIndexOf('/')));
  const choices=(page.categories||[]).filter(candidate=>action==='create'||(candidate!==path&&!candidate.startsWith(path+'/')));
  state.editor={kind:'category',action,path,dirty:false};
  modal((action==='create'?'新增':'编辑')+categoryLabel(routes[state.active].key),'<form novalidate id="category-form"><div class="form-grid">'+
    field('分类名称',input('name',action==='update'?path.split('/').at(-1):'','required maxlength="40"'),true)+
    field('上级分类',select('parent',choices.map(candidate=>[candidate,candidate]),parent,'','顶级分类'))+'</div></form>',
    btn('保存','category-save','','primary'),true);
}
async function changeProductCategory(action,values={}) {
  const page=pageState();
  try {
    const endpoint=categoryEndpoint(routes[state.active].key);
    const result=await api(endpoint,{action,path:page.params.category||'',...values});
    const {paths}=await api(endpoint);
    page.categories=paths;
    page.params.category=result.path;
    page.params.uncategorized='';
    const branch=result.path.split('/');
    for (let level=1;level<branch.length;level++) page.collapsedCategories?.delete(branch.slice(0,level).join('/'));
    page.params.page=1;
    catalogData=null;
    dismiss(true);
    renderFilters(routes[state.active],page);
    await loadPage();
  } catch (error) {showError(error);}
}
function renderPartnerCategories(page) {
  const sidebar=document.querySelector('#page-filter');
  sidebar.innerHTML='<section class="product-categories"><div class="category-toolbar">'+
    input('categorySearch',page.categorySearch,'type="search" aria-label="搜索客户/供应商分类" placeholder="搜索客户/供应商分类"')+
    (canMaintain('partners')?'<button type="button" class="btn" data-act="category-edit" data-value="create" aria-label="新增客户/供应商分类">＋</button>':'')+
    '</div><div id="product-category-tree" class="category-tree" aria-label="客户/供应商分类树"></div>'+
    (canMaintain('partners')&&page.params.category?'<div class="category-toolbar">'+btn('编辑分类','category-edit','update')+
      btn('删除分类','category-delete',page.params.category,'danger')+'</div>':'')+'</section>';
  sidebar.querySelector('[name=categorySearch]').addEventListener('input',event=>{
    page.categorySearch=event.target.value;
    renderCategoryTree(page);
  });
  renderCategoryTree(page);
}
function renderProductFilters(page) {
  const existing=document.querySelector('#filters-form');
  const p=existing?{...page.params,...read(existing)}:page.params;
  document.querySelector('#product-query').innerHTML=
    '<form novalidate id="filters-form" class="toolbar product-query-form" aria-label="商品查询">'+
    field('关键词',input('keyword',p.keyword,'type="search" placeholder="编号 / 名称 / 条码"'),false,'product-keyword')+
    field('商品状态',select('active',[['1','启用'],['0','停用']],p.active,'','全部状态'))+
    field('商品类型',select('productType',[['stock','库存商品'],['service','服务/劳务'],['material','原材料'],['consumable','耗材']],p.productType,'','全部类型'))+
    '<button class="btn primary" type="submit">查询</button></form>';
  document.querySelector('#page-filter').innerHTML='<section class="product-categories"><div class="category-toolbar">'+
    input('categorySearch',page.categorySearch,'type="search" aria-label="搜索商品分类" placeholder="搜索商品分类"')+
    (canMaintain('products')?'<button type="button" class="btn" data-act="category-edit" data-value="create" aria-label="新增商品分类">＋</button>':'')+'</div><div id="product-category-tree" class="category-tree" aria-label="商品分类树"></div>'+
    (canMaintain('products')&&p.category?'<div class="category-toolbar">'+btn('编辑分类','category-edit','update')+btn('删除分类','category-delete',p.category,'danger')+'</div>':'')+'</section>';
  document.querySelector('[name=categorySearch]').addEventListener('input',event=>{
    page.categorySearch=event.target.value;
    renderCategoryTree(page);
  });
  renderCategoryTree(page);
}
function renderFilters(route,page) {
  if (route.key==='partners') return renderPartnerCategories(page);
  const p=page.params;
  if (route.key==='products') return renderProductFilters(page);
  const inventory=['库存状况查询','分仓库存查询','可销售库存查询','可发货库存查询','库存积压统计','库龄统计'].includes(route.key);
  const date=route.kind!=='master'&&!inventory;
  document.querySelector('#page-filter').innerHTML='<div class="filter-head">查询条件</div><form novalidate id="filters-form" class="stack">'+
    field('关键词',input('keyword',p.keyword,'placeholder="输入关键词"'))+
    (date?'<div class="segment"><button type="button" data-act="date" data-value="today">今天</button><button type="button" data-act="date" data-value="three">近 3 天</button></div>'+field('开始日期',input('from',p.from,'type="date"'))+field('结束日期',input('to',p.to,'type="date"')):'')+
    (route.kind==='docs'?field('状态',select('status',Object.entries(statusNames),p.status,'','全部状态')):'')+
    (orderFulfillment[route.key]?field('执行情况',select('execution',Object.entries(executionLabels),p.execution,'','全部执行状态')):'')+
    '<details><summary class="note">更多查询条件</summary>'+
    (inventory?field('停用过滤',select('inactive',[['1','包括停用']],p.inactive,'','仅启用'))+
      field('数量过滤',select('stockQuantity',[['positive','正库存'],['zero','零库存']],p.stockQuantity,'','不限数量'))+
      field('成本算法',select('method',costing,p.method,'','全部成本算法')):'')+
    (route.kind==='master'?field('资料状态',select('active',[['1','启用'],['0','停用']],p.active,'','全部状态')):field('仓库',select('warehouse',page.warehouses||[],p.warehouse,'','全部仓库')))+
    '</details><button class="btn primary">查询</button></form>';
  if (route.kind!=='master'&&!page.warehouses&&allow('m:warehouses')) api('/api/master/warehouses?active=1&all=1').then(data=>{
    page.warehouses=data.rows.map(r=>[r.id,r.name]);
    const node=document.querySelector('#filters-form select[name=warehouse]');
    if (node&&pageState()===page) node.innerHTML=options(page.warehouses,p.warehouse,'全部仓库');
  }).catch(()=>{});
}
function updatePaging(page) {
  const node=document.querySelector('#paging');
  if (!node) return;
  const number=page.params.page||1;
  node.innerHTML=(page.count===null||page.count===undefined?'第 '+number+' 页':'共 '+page.count+' 条 · 第 '+number+' / '+Math.max(1,Math.ceil(page.count/25))+' 页')+
    '<button class="btn" data-act="page" data-value="-1" '+(number<=1?'disabled':'')+'>上一页</button><button class="btn" data-act="page" data-value="1" '+((page.count!=null?number*25>=page.count:(page.result?.rows.length||0)<25)?'disabled':'')+'>下一页</button>';
}
const partnerTypeOptions=[['customer','客户'],['supplier','供应商'],['both','客户和供应商']];
function partnerTable(page) {
  const rows=page.result.rows;
  if (!rows.length) return empty('没有符合条件的往来单位');
  const editable=canMaintain('partners');
  const headers=['行号',...(editable?['操作']:[]),'单位编号','单位名称','类型','当前应付账款','当前应收账款','经手人','价格等级','公司地址','电话','状态'];
  return table(headers,rows.map((row,index)=>{
    const data=row.data;
    const tags=partnerTypeOptions.slice(0,2).filter(([type])=>data.type===type||data.type==='both')
      .map(([type,label])=>'<span class="partner-tag '+type+'">'+label+'</span>').join(' ');
    const actions=editable?'<td class="master-action-cell">'+masterActions('partners',row)+'</td>':'';
    return '<tr><td>'+(((page.params.page||1)-1)*25+index+1)+'</td>'+actions+'<td>'+e(row.code)+'</td><td>'+
      '<button class="link" data-act="master-edit" data-value="'+row.id+'">'+e(row.name)+'</button></td><td>'+tags+
      '</td><td class="partner-amount">'+money(row.payable)+'</td><td class="partner-amount">'+money(row.receivable)+
      '</td><td>'+e(data.handler)+'</td><td>'+e(data.priceLevel?'预设售价 '+data.priceLevel:'无')+
      '</td><td>'+e(data.companyAddress||data.address)+'</td><td>'+e(data.phone)+'</td><td><span class="'+(row.active?'partner-enabled':'partner-disabled')+'">'+
      (row.active?'● 启用':'● 停用')+'</span></td></tr>';
  }),'master-grid');
}
function renderPartnerPage(main,page) {
  const p=page.params;
  const remembered=main.querySelector('#filters-form');
  const filters=page.loading||!remembered?p:{...p,...read(remembered)};
  const search='<form novalidate id="filters-form" class="toolbar partner-search" aria-label="快速查询">'+
    input('keyword',filters.keyword,'type="search" aria-label="查询往来单位" placeholder="编号 / 名称 / 简名 / 拼音码 / 电话"')+
    select('active',[['1','仅显示启用'],['0','仅显示停用']],filters.active,'aria-label="状态"','全部状态')+
    select('partnerType',partnerTypeOptions,filters.partnerType,'aria-label="类型"','全部类型')+'<button class="btn">查询</button></form>';
  const actions=(canMaintain('partners')?btn('新增客户','partner-new','customer','primary')+
    btn('新增供应商','partner-new','supplier','primary'):'')+
    (allow('m:partners','import')?btn('导入往来单位','partner-import'):'');
  const display=page.loading?skeleton():page.error?empty(page.error):page.result?partnerTable(page):skeleton();
  main.innerHTML='<section class="card partner-grid">'+search+'<div class="toolbar">'+actions+
    '<span class="toolbar-end"></span>'+(allow('m:partners','print')?btn('打印','print-table'):'')+(allow('m:partners','export')?exportLink('/api/master/partners',p):'')+'</div>'+
    display+(page.result?'<div class="paging" id="paging"></div>':'')+'</section>';
  if (page.result) updatePaging(page);
}
function renderPage(route,page) {
  const main=document.querySelector('#page-main');
  if (!main) return;
  if (route.key==='partners') return renderPartnerPage(main,page);
  const [path,params]=endpoint(route);
  const key=route.key;
  const inventory=key==='库存状况查询';
  const business=['经营报告','综合统计月报','销售波动分析','采购波动分析'].includes(key);
  const editableMaster=route.kind==='master'&&canMaintain(key);
  let controls=key==='products'?'':btn('查询','query','','primary');
  if (route.kind==='docs') {
    const types=listedDocumentTypes(route,'create');
    if (page.result?.rows.length) {
      controls+=menu('批量操作',bulkDocumentActions.map(action=>btn(actions[action],'documents-bulk-action',action)))+
        '<span class="note" data-selection-count aria-live="polite">已选 0 张</span>';
    }
    if (types.length) controls+=route.key?go('n:'+key,'新增'):menu('新增单据',types.map(type=>go('n:'+type,families[type][0])));
  }
  if (editableMaster) controls+=btn('新增','master-edit');
  if (key==='users') controls+=go('staff-permissions');
  if (key==='products') controls+=(allow('m:products','print')?btn('条码打印','print-products'):'')+btn(page.expandUnits?'收起多单位':'展开多单位','expand-units');
  if (key==='products'&&allow('m:products','import')) controls+=menu('导入',[['new','导入新增'],['update','导入修改商品'],['barcode','导入条码'],['sku','导入商家编码'],['price','导入修改价格'],['attributes','导入追加属性']].map(([v,l])=>btn(l,'import',v)));
  if (key==='批次号跟踪') controls+='<div class="segment">'+
    [['current','当前批次'],['history','批次流水']].map(([v,label])=>'<button data-act="report-mode" data-value="'+v+'" class="'+((page.params.mode||'current')===v?'selected':'')+'">'+label+'</button>').join('')+'</div>';
  if (business) controls+='<div class="segment">'+['day','month'].map((v,i)=>'<button data-act="report-mode" data-value="'+v+'" class="'+(v===(page.params.mode||'day')?'selected':'')+'">'+(i?'按月':'按日')+'</button>').join('')+'</div>';
  if (key==='对账'&&allow('r:对账','share')) controls+=btn('生成对账链接','statement');
  if (key==='月结存'&&state.user.role==='admin') controls+=btn('执行月结','close-month');
  controls+='<span class="toolbar-end"></span>'+(routeAllows(state.active,'print')?btn('打印','print-table'):'')+(routeAllows(state.active,'export')?exportLink(path,{...params,...page.params}):'')+go('r:导出记录','导出记录');
  let display=page.loading?skeleton():page.error?empty(page.error):!page.requested?empty('输入查询条件,点击【查询】吧'):page.result?tableContent(route,page):skeleton();
  if (inventory) display='<div class="toolbar">'+[['','商品库存'],['serial','序列号库存'],['bundle','套餐库存']].map(([view,label])=>btn(label,'report-view',view,(page.params.view||'')===view?'primary':'')).join('')+'</div>'+display;
  main.innerHTML='<section class="card"><div class="toolbar">'+controls+'</div>'+display+(page.result&&key!=='users'?'<div class="paging" id="paging"></div>':'')+'</section>'+
    ((route.kind==='docs'||inventory)?'<section class="card detail-area" id="detail-area"><div class="section-head"><h3>'+ (inventory?'库存明细':'单据明细') +'</h3></div>'+empty(inventory?'可查看业务流水、分仓库存及批次、序列号':'选择一条单据查看明细')+
      (inventory?'<div class="toolbar">'+['库存变动统计','分仓库存查询','全月商品出库成本表','可销售库存查询','批次号跟踪','序列号跟踪'].map(name=>go('r:'+name)).join('')+'</div>':'')+'</section>':'');
  if (route.kind==='docs') {
    const head=main.querySelector('thead th');
    if (head) {
      head.firstChild.remove();
      head.insertAdjacentHTML('afterbegin','<input type="checkbox" name="documentSelectPage" aria-label="全选本页单据">');
    }
    updateDocumentSelection(main);
  }
  if (page.result) updatePaging(page);
}
const masterIcons={
  edit:'<path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M10 14l1-4 8-8 3 3-8 8z"/>',
  delete:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  enable:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  disable:'<circle cx="12" cy="12" r="9"/><path d="M10 9v6m4-6v6"/>'
};
function masterActions(kind,row,editing=false) {
  const ownAccount=kind==='users'&&row.id===state.user.id;
  const status=row.active?'停用':'启用';
  const icon=(key,label,action,value,disabled=false)=>'<button type="button" class="master-action-icon" title="'+label+
    '" aria-label="'+label+'" data-act="'+action+'" data-value="'+e(value)+'"'+(disabled?' disabled':'')+
    '><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+masterIcons[key]+'</svg></button>';
  return '<div class="master-row-actions">'+(editing?'':icon('edit','编辑','master-edit',row.id))+
    icon('delete','删除','master-record-action','delete:'+row.id,ownAccount)+
    icon(row.active?'disable':'enable',status,'master-record-action',(row.active?'disable:':'enable:')+row.id,ownAccount&&row.active)+'</div>';
}

const productWidthKey=()=> 'hengxu:product-columns:'+state.user.id;
const documentWidthKey=scope=>'hengxu:document-columns:'+state.user.id+':'+scope;

function savedColumnWidths(key) {
  try {return JSON.parse(localStorage.getItem(key))||{};}
  catch {return {};}
}

function columnWidths(columns,key) {
  const saved=savedColumnWidths(key);
  return columns.map(([id,,fallback])=>Number.isFinite(saved[id])?Math.max(44,Math.min(1000,saved[id])):fallback);
}

function columnHandle(id,label,width) {
  return '<span class="column-resizer" tabindex="0" role="separator" aria-orientation="vertical" aria-label="'+e('调整'+label+'列宽')+
    '" aria-valuemin="44" aria-valuemax="1000" aria-valuenow="'+width+'" data-column="'+e(id)+'"></span>';
}

function resizeTable(columns,rows,key,className='') {
  const widths=columnWidths(columns,key);
  const head=columns.map(([id,label],index)=>'<th scope="col">'+e(label)+columnHandle(id,label,widths[index])+'</th>').join('');
  return '<div class="scroll-table"><table class="resizable-table '+e(className)+'" data-width-key="'+e(key)+'" style="width:'+
    widths.reduce((a,b)=>a+b,0)+'px"><colgroup>'+widths.map(width=>'<col style="width:'+width+'px">').join('')+
    '</colgroup><thead><tr>'+head+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
}

const documentColumnDefaults={
  选择:62,行号:60,操作:84,单据编号:185,单据类型:122,日期:120,单据日期:120,往来单位:160,仓库:110,状态:100,
  商品编号:125,商品名称:190,'商品编号 / 名称':220,会计科目:190,单位:85,数量:96,商品单位:90,摘要:180,备注:165
};
function documentTable(scope,headers,rows,ids=[],defaults={}) {
  const columns=headers.map((label,index)=>{
    const id=ids[index]||label.replace(/^(?:含税|不含税)单价$/,'单价');
    return [id,label,defaults[id]||documentColumnDefaults[label]||Math.max(108,label.length*14+23)];
  });
  return resizeTable(columns,rows,documentWidthKey(scope));
}

function resizeDocumentPicker(table,scope) {
  const key=documentWidthKey(scope);
  const headers=[...table.tHead.rows[0].cells];
  const columns=headers.map((cell,index)=>[String(index),cell.textContent||'选择',Math.ceil(cell.getBoundingClientRect().width)||100]);
  const widths=columnWidths(columns,key);
  const group=document.createElement('colgroup');
  columns.forEach(([id,label],index)=>{
    const col=document.createElement('col');
    col.style.width=widths[index]+'px';
    group.append(col);
    headers[index].insertAdjacentHTML('beforeend',columnHandle(id,label,widths[index]));
  });
  table.prepend(group);
  table.classList.add('resizable-table');
  table.dataset.widthKey=key;
  table.style.width=widths.reduce((a,b)=>a+b,0)+'px';
}

function productTable(page) {
  const editable=canMaintain('products');
  const columns=[
    ...(editable?[['actions','操作',115]]:[]),
    ['code','商品编号',138],['name','商品名称',190],['unit','单位',80],['unitType','单位类型',100],
    ['factor','换算率',90],['latestPurchase','最近采购价',114],['latestSale','最近售价',105],
    ['retail','零售价',90],['preset','预设售价 1',110],['active','商品状态',98],['created','创建时间',180]
  ];
  const rows=page.result.rows.map(row=>{
    const d=row.data||{};
    const values=[row.code,row.name,d.unit||'',productUnits(d).size>1?'多单位':'固定单位',1,
      row.latestPurchase==null?'':money(row.latestPurchase),row.latestSale==null?'':money(row.latestSale),
      d.retail??'',d.preset1??'',row.active?'启用':'停用',row.created];
    const main='<tr data-row="master" data-id="'+row.id+'">'+(editable?'<td class="master-action-cell">'+masterActions('products',row)+'</td>':'')+
      values.map((value,index)=>'<td title="'+e(value)+'">'+(index===1?btn(value,'master-edit',row.id,'product-name'):e(value))+'</td>').join('')+'</tr>';
    const units=page.expandUnits?[...productUnits(d)].slice(1).map(([unit,factor])=>cells([
      ...(editable?['']:[]),row.code,'↳ '+row.name,unit,'换算单位',factor,'','',unitDetails(d,unit)?.retail??'','','',''
    ])).join(''):'';
    return main+units;
  });
  return resizeTable(columns,rows,productWidthKey(),'product-table master-grid');
}

function changeTableColumn(handle,requestedWidth) {
  const table=handle.closest('table');
  const columns=[...table.querySelectorAll('col')];
  const width=Math.max(44,Math.min(1000,Math.round(requestedWidth)));
  columns[handle.parentElement.cellIndex].style.width=width+'px';
  table.style.width=columns.reduce((sum,col)=>sum+parseInt(col.style.width,10),0)+'px';
  handle.setAttribute('aria-valuenow',width);
}

function storeTableColumn(handle) {
  const key=handle.closest('table').dataset.widthKey;
  const saved=savedColumnWidths(key);
  saved[handle.dataset.column]=Number(handle.getAttribute('aria-valuenow'));
  try {localStorage.setItem(key,JSON.stringify(saved));}
  catch {void showSystemPrompt('浏览器无法保存列宽。');}
}

document.addEventListener('pointerdown',event=>{
  const handle=event.target.closest('.column-resizer');
  if (!handle||event.button!==0) return;
  event.preventDefault();
  const origin=event.clientX;
  const originalWidth=Number(handle.getAttribute('aria-valuenow'));
  const move=next=>changeTableColumn(handle,originalWidth+next.clientX-origin);
  handle.setPointerCapture(event.pointerId);
  handle.addEventListener('pointermove',move);
  handle.addEventListener('lostpointercapture',()=>{
    handle.removeEventListener('pointermove',move);
    if (handle.isConnected) storeTableColumn(handle);
  },{once:true});
});
document.addEventListener('keydown',event=>{
  const handle=event.target.closest?.('.column-resizer');
  if (!handle||!['ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  changeTableColumn(handle,Number(handle.getAttribute('aria-valuenow'))+(event.key==='ArrowRight'?10:-10));
  storeTableColumn(handle);
});

function tableContent(route,page) {
  const {result}=page;
  if (route.kind==='docs') {
    return result.rows.length?documentTable('list:'+(route.key||state.active),['选择','单据编号','单据类型','日期','往来单位','仓库','状态','含税金额','摘要'],result.rows.map(r=>'<tr data-row="document" data-id="'+r.id+'" tabindex="0" title="双击打开原单"><td><input type="checkbox" name="documentSelection" value="'+r.id+'" aria-label="选择 '+e(r.number)+'"></td><td><button type="button" class="link" data-act="document-open-original" data-value="'+r.id+'">'+e(r.number)+'</button></td><td>'+e(families[r.type][0])+'</td><td>'+e(r.date)+'</td><td>'+e(r.partnerName||'—')+'</td><td>'+e(r.warehouseName||'—')+'</td><td><span class="badge" data-state="'+e(r.status)+'">'+e(statusOf(r))+'</span></td><td>'+money(r.total)+'</td><td>'+e(r.summary||'')+'</td></tr>')):empty('没有符合条件的单据');
  }
  if (route.kind==='master') {
    if (route.key==='products') return productTable(page);
    const names=route.key==='users'?['用户名','姓名','角色','部门','状态']:['编号','名称','状态','主要信息'];
    const editable=canMaintain(route.key);
    return result.rows.length?table(editable?['操作',...names]:names,result.rows.map(row=>{
      const data=row.data||{};
      const values=route.key==='users'?[row.username,row.name,roleNames[row.role],row.department,row.active?'启用':'停用']:
        [row.code,row.name,row.active?'启用':'停用',data.phone||data.address||data.description||data.price||''];
      return '<tr data-row="master" data-id="'+row.id+'">'+(editable?'<td class="master-action-cell">'+masterActions(route.key,row)+'</td>':'')+values.map((value,index)=>'<td>'+
        (index===1?'<button class="link" data-act="master-edit" data-value="'+row.id+'">'+e(value)+'</button>':e(value))+'</td>').join('')+'</tr>';
    }),'master-grid'):empty('没有符合条件的资料');
  }
  const sections=result.sections?'<div class="report-blocks">'+result.sections.map(section=>'<section class="report-block"><h3>'+e(section.name)+'</h3>'+section.values.map(([key,val])=>'<div class="metric"><span>'+e(key)+'</span><strong>'+e(val)+'</strong></div>').join('')+'</section>').join('')+'</div>':'';
  const max=Math.max(1,...result.rows.map(([,v])=>Math.abs(Number(v)||0)));
  const trend=result.sections?'<section class="trend"><h3>销售收入趋势</h3>'+(result.rows.length?result.rows.map(([period,v])=>'<div class="trend-bar"><span>'+e(period)+'</span><i style="width:'+Math.round(Math.abs(Number(v))/max*100)+'%"></i><b>'+e(v)+'</b></div>').join(''):'<p class="note">所选日期范围内暂无销售收入。</p>')+'</section>':'';
  const reportRows=result.rows.map((row,index)=>{
    const id=result.documentIds?.[index];
    if (!Number.isSafeInteger(id)) return cells(row);
    return '<tr data-row="report-document" data-id="'+id+'" tabindex="0" title="双击打开原单">'+row.map(value=>'<td>'+e(value)+'</td>').join('')+'</tr>';
  });
  return sections+trend+(reportRows.length?documentTable('report:'+route.key,result.columns,reportRows):result.sections?'':empty('没有符合条件的数据'));
}

function modal(title,content,footer='',small=false,closeLabel='关闭') {
  dialog.className=small?'small':'';
  dialog.innerHTML='<div class="modal-layout"><header class="modal-head"><h2>'+e(title)+'</h2><button class="icon-btn" data-act="dismiss" aria-label="关闭">×</button></header><div class="modal-main">'+content+'</div><footer class="modal-foot">'+footer+btn(closeLabel,'dismiss')+'</footer></div>';
  if (!dialog.open) dialog.showModal();
}
function dismiss(force=false) {
  if (!dialog.open) return;
  if (state.editor?.kind==='document') {dialog.close();return;}
  if (!force&&state.editor?.busy) return;
  if (!force&&state.editor?.dirty) {
    confirmDiscard(()=>dismiss(true));
    return;
  }
  state.editor=null;
  dialog.close();
}
dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
dialog.addEventListener('input',()=>{if (state.editor&&state.editor.kind!=='document') state.editor.dirty=true;});
documentEditor.addEventListener('input',()=>{if (state.editor?.kind==='document') state.editor.dirty=true;});
const typeChoices=[['stock','库存商品'],['service','服务/劳务'],['material','原材料'],['consumable','耗材']];
const costing=costMethods;
const configLabel={
  bundles:[['barcode','套餐条码'],['description','说明']],
  warehouses:[['address','地址'],['description','说明']], accounts:[['bank','开户行'],['accountNo','账户号']],
  expenses:[['category','科目分类'],['description','说明']], ledgerAccounts:[['description','说明']],
  carriers:[['phone','联系电话'],['description','说明']], shippingTemplates:[['service','服务名称'],['description','费用说明']],
  freight:[['reference','关联单号'],['amount','结算金额'],['settlementDate','结算日期']],
  owners:[['contact','联系人'],['phone','联系电话']], templates:[['title','打印标题'],['footer','页脚'],['logoText','抬头']],
  printers:[['printer','打印机名称'],['endpoint','设备地址'],['description','说明']],
  settings:[['value','设置值'],['description','说明']]
};
let catalogData;
async function catalog(refresh=false) {
  if (!catalogData||refresh) {
    catalogData=Promise.all(['products','partners','warehouses','accounts','expenses','ledgerAccounts','carriers'].map(async key=>[key,allow('m:'+key)?(await api('/api/master/'+key+'?active=1&all=1')).rows:[]]))
      .then(entries=>Object.fromEntries(entries)).catch(error=>{catalogData=null;throw error;});
  }
  return catalogData;
}
const rowsToOptions=rows=>rows.map(r=>[r.id,r.code+' · '+r.name]);
const numeric=(key,value,step='0.01')=>input(key,value,'type="number" min="0" step="'+step+'"');
function read(form) {return Object.fromEntries(new FormData(form));}
function unitRow(row={}) {
  const text=(key,label)=>input('unitRow.'+key,row[key],'aria-label="'+label+'" maxlength="64"');
  const decimal=(key,label,step)=>input('unitRow.'+key,row[key],'aria-label="'+label+'" type="number" min="'+(key==='factor'?'0.001':'0')+'" step="'+step+'"');
  return '<tr><td>'+btn('移除','unit-remove','','danger')+'</td><td>'+text('name','换算单位')+'</td><td>'+
    decimal('factor','单位换算率','any')+'</td><td>'+text('barcode','单位条码')+'</td><td>'+text('sku','单位商家编码')+'</td><td>'+
    decimal('weight','单位重量','any')+'</td><td>'+decimal('purchase','单位采购价','0.01')+'</td><td>'+decimal('retail','单位零售价','0.01')+'</td></tr>';
}
function unitSettings(data) {
  const rows=data.unitRows||[...productUnits(data)].slice(1).map(([name,factor])=>({name,factor}));
  const choices=[...productUnits(data).keys()].filter(Boolean).map(unit=>[unit,unit]);
  return '<section id="product-unit-settings"'+(rows.length||data.multiUnit?'':' hidden')+'><h3 class="form-section">单位及价格</h3>'+
    '<div class="toolbar">'+btn('添加换算单位','unit-add')+checkbox('autoUnitPrice',data.autoUnitPrice!==false,'自动计算价格')+'</div>'+
    '<div class="unit-table">'+table(['操作','商品单位','换算率（基本单位）','条码','商家编码','重量 kg','采购价','零售价'],(rows.length?rows:[{}]).map(unitRow),'master-grid')+'</div>'+
    '<h3 class="form-section">开单默认单位</h3><div class="form-grid">'+
    field('销售业务',select('salesUnit',choices,data.salesUnit,'','基本单位'))+
    field('采购业务',select('purchaseUnit',choices,data.purchaseUnit,'','基本单位'))+'</div></section>';
}
function refreshUnitDefaults(form) {
  const names=[form.elements.unit.value,...new FormData(form).getAll('unitRow.name')].map(name=>name.trim()).filter(Boolean);
  for (const key of ['salesUnit','purchaseUnit']) {
    const control=form.elements[key];
    control.innerHTML=options([...new Set(names)].map(name=>[name,name]),control.value,'基本单位');
  }
}
function productCategoryField(path='') {
  return field('商品分类',input('category',path,'type="hidden"')+
    '<button type="button" class="btn product-category-picker" data-act="product-category-picker" aria-haspopup="dialog">'+
    '<span>'+e(path||'未分类')+'</span><span aria-hidden="true">⌄</span></button>');
}

function openProductCategoryPicker(_,control) {
  const form=control.closest('form');
  const field=form.elements.category;
  const rowsFor=async()=>{
    const {paths}=await api(categoryEndpoint('products'));
    return [{id:'/',cells:['未分类','']},...paths.map(path=>({id:path,cells:[path,'第 '+path.split('/').length+' 级']}))];
  };
  let loading;
  showDocumentPicker({
    title:'选择商品分类',columns:['分类路径','层级'],selected:field.value||'/',
    async load(keyword,page) {
      loading??=rowsFor().catch(error=>{loading=null;throw error;});
      const rows=(await loading).filter(row=>row.cells[0].toLowerCase().includes(keyword.toLowerCase()));
      return {rows:rows.slice((page-1)*25,page*25),count:rows.length};
    },
    onPick(row) {
      if (!row||!form.isConnected) return;
      field.value=row.id==='/'?'':row.id;
      control.firstElementChild.textContent=field.value||'未分类';
      field.dispatchEvent(new Event('input',{bubbles:true}));
    }
  });
}
async function editMaster(id,copy=false,partnerType='customer') {
  const route=routes[state.active];
  const kind=route.kind==='permissions'?'users':route.key;
  const row=id?pageState().result?.rows.find(r=>r.id===Number(id)):null;
  const editable=canMaintain(kind);
  if (!row&&!editable) return;
  const pools=['users','products','bundles','supplierPrices','customerPrices','tiers'].includes(kind)?await catalog():null;
  const data=row?.data||{};
  const settings=kind==='products'?await api('/api/system-settings'):null;
  let details='';
  let units='';
  let base;
  const kv=(label,key,attrs='')=>field(label,input(key,data[key],attrs));
  const num=(label,key)=>field(label,numeric(key,data[key]));
  if (kind==='users') {
    base=field('用户名',input('username',row?.username,'required'),true)+field('姓名',input('name',row?.name,'required'),true)+
      field('角色',select('role',Object.entries(roleNames).filter(([role])=>route.kind!=='permissions'||role!=='admin'),row?.role||'clerk','required'),true)+
      field('部门',input('department',row?.department))+
      field('仓库范围','<select name="warehouses" multiple size="4">'+pools.warehouses.map(r=>'<option value="'+r.id+'" '+(row?.warehouses.includes(r.id)?'selected':'')+'>'+e(r.name)+'</option>').join('')+'</select>',false,'span2')+
      field(row?'重设密码':'密码',input('password','','type="password" minlength="12" maxlength="128" autocomplete="new-password" '+(row?'':'required')),!row,'span2');
  } else {
    base=field(kind==='products'?'商品编号':'编号',input('code',copy?'':row?.code,'required maxlength="64"'),true)+field(kind==='products'?'商品名称':'名称',input('name',row?.name,'required maxlength="160"'),true);
    if (kind==='products') {
      base+=productCategoryField(data.category??pageState().params.category)+field('商品类型',select('type',typeChoices,data.type||'stock'))+
        kv('基本单位','unit')+field('单位类型',select('unitMode',[['fixed','固定单位'],['multi','多单位']],data.multiUnit||productUnits(data).size>1?'multi':'fixed','required'))+kv('条码','barcode')+kv('商家编码','sku')+
        num('零售价','retail')+num('采购价','purchase')+num('参考成本价','referenceCost')+num('最低售价','minimum')+
        field('成本算法',select('method',costing.filter(([key])=>settings.costMethods.includes(key)||!!id&&!copy&&key===(data.method||'moving')),data.method|| (settings.costMethods.includes('moving')?'moving':settings.costMethods[0]),'required'))+
        '<div>'+checkbox('batch',data.batch,'批次管理')+checkbox('serial',data.serial,'序列号管理')+checkbox('attributeEnabled',data.attributeEnabled,'属性管理')+'</div>'+
        kv('属性','attributes')+field('备注','<textarea name="note" maxlength="300">'+e(data.note)+'</textarea>',false,'span2');
      units=unitSettings(data);
      const extra=[['开票名称','invoiceName'],['规格','spec'],['型号','model'],['品牌','brand'],['采购周期（天）','leadTime'],['简名','shortName'],['拼音码','pinyin'],['产地','origin'],['商品标签','tags'],['补货方式','replenish'],['税收编码','taxCode'],['商品税率 %','taxRate'],['重量 kg','weight'],['长 cm','length'],['宽 cm','width'],['高 cm','height'],['条码策略','barcodePolicy']];
      const warehouseOptions=rowsToOptions(pools.warehouses);
      const supplierOptions=rowsToOptions(pools.partners.filter(p=>['supplier','both'].includes(p.data.type)));
      details='<details><summary class="btn">更多字段</summary><div class="form-grid">'+
        field('默认仓库',select('defaultWarehouse',warehouseOptions,data.defaultWarehouse))+
        field('商品供应商','<select name="suppliers" multiple size="3">'+supplierOptions.map(([id,label])=>
          '<option value="'+e(id)+'" '+((data.suppliers||[]).includes(String(id))?'selected':'')+'>'+e(label)+'</option>').join('')+'</select>')+extra.map(([label,key])=>kv(label,key)).join('')+Array.from({length:10},(_,i)=>num('预设售价 '+(i+1),'preset'+(i+1))).join('')+
        Array.from({length:14},(_,i)=>kv('自定义字段 '+(i+1),'custom'+(i+1))).join('')+'</div></details>';
    } else if (kind==='partners') {
      base+=field('往来单位类型',select('type',partnerTypeOptions,data.type||partnerType,'required'),true)+
        field('分类',select('category',(pageState().categories||[]).map(path=>[path,path]),data.category??pageState().params.category,'','未分类'))+
        kv('简名','shortName')+kv('拼音码','pinyin')+kv('经手人','handler')+
        field('价格等级',select('priceLevel',Array.from({length:10},(_,index)=>[index+1,'预设售价 '+(index+1)]),data.priceLevel,'','无'))+
        kv('联系人','contact')+kv('电话','phone')+kv('公司地址','companyAddress')+kv('收货地址','address');
    } else if (kind==='accounts') {
      base+=field('账户类型',select('type',[['cash','现金'],['bank','银行']],data.type||'cash','required'),true);
    } else if (['customerPrices','supplierPrices','tiers'].includes(kind)) {
      base+=field('商品',select('product',rowsToOptions(pools.products),data.product,'required'),true)+num('单价','price');
      base+=kind==='tiers'?num('起订数量','minimum'):field('往来单位',select('partner',rowsToOptions(pools.partners.filter(p=>p.data.type==='both'||p.data.type===(kind==='supplierPrices'?'supplier':'customer'))),data.partner,'required'),true);
    }
    if (kind==='ledgerAccounts') base+=field('会计分类',select('category',[['asset','资产'],['liability','负债'],['equity','权益'],['income','收入'],['expense','费用']],data.category,'required'),true);
    for (const [key,label] of (configLabel[kind]||[])) base+=kv(label,key);
    if (kind==='bundles') {
      const items=(data.components||[]).map(c=>(pools.products.find(p=>p.id===c.product)?.code||c.product)+'='+c.quantity).join('\n');
      base+=field('套餐组成','<textarea name="components" required placeholder="每行：商品编号=数量">'+e(items)+'</textarea>',true,'span2');
    }
  }
  base+=field('状态',select('active',[['1','启用'],['0','停用']],String(row?.active??1)));
  state.editor={kind:'master',master:kind,row:copy?null:row,pools,dirty:copy,copyData:copy?data:null};
  const label=copy?'复制新增':row?'编辑':'新增';
  modal(editable?(kind==='partners'&&!row?'新增'+partnerTypeOptions.find(([type])=>type===partnerType)[1]:label+masters[kind][0]):masters[kind][0],'<form novalidate id="master-form"><div class="form-grid">'+base+'</div>'+units+details+(editable?'<button type="submit" hidden>保存</button>':'')+'</form>',editable?btn('保存','master-save','','primary')+(kind==='products'?btn('保存并新增','master-save','again')+(row&&!copy?btn('复制新增','master-copy',row.id)+masterActions(kind,row,true):''):''):'',kind!=='products');
  if (!editable) dialog.querySelectorAll('form input,form select,form textarea').forEach(node=>node.disabled=true);
  dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();saveMasterForm(false);});
  const form=dialog.querySelector('#master-form');
  if (kind==='products') {
    form.addEventListener('input',event=>{
      if (['unit','unitRow.name'].includes(event.target.name)) refreshUnitDefaults(form);
    });
    const settings=form.querySelector('#product-unit-settings');
    const showUnitSettings=()=>{
      settings.hidden=form.elements.unitMode.value!=='multi';
      settings.querySelectorAll('input,select,button').forEach(control=>{control.disabled=settings.hidden||!editable;});
    };
    form.elements.unitMode.addEventListener('change',showUnitSettings);
    showUnitSettings();
  }
}
async function saveMasterForm(again) {
  const editor=state.editor;
  const form=dialog.querySelector('#master-form');
  if (!validateForm(form)||editor.busy) return;
  const values=read(form);
  const active=Number(values.active);
  delete values.active;
  const row=editor.row;
  let payload;
  if (editor.master==='users') {
    payload={...values,id:row?.id,active,warehouses:new FormData(form).getAll('warehouses').map(Number)};
  } else {
    const {name,code,...data}=values;
    if (editor.master==='products') {
      for (const key of ['batch','serial','attributeEnabled']) data[key]=data[key]==='on';
      data.suppliers=new FormData(form).getAll('suppliers');
      data.multiUnit=data.unitMode==='multi';
      delete data.unitMode;
      const unitForm=new FormData(form);
      const columns=['name','factor','barcode','sku','weight','purchase','retail'];
      const entries=Object.fromEntries(columns.map(key=>[key,unitForm.getAll('unitRow.'+key)]));
      data.unitRows=data.multiUnit?entries.name.map((_,index)=>Object.fromEntries(columns.map(key=>[key,entries[key][index]]))).filter(row=>Object.values(row).some(Boolean)):[];
      for (const key of columns) delete data['unitRow.'+key];
      data.autoUnitPrice=unitForm.has('autoUnitPrice');
      if (!data.multiUnit) {data.salesUnit='';data.purchaseUnit='';}
      if (data.multiUnit&&!data.unitRows.length) return showError(Error('请至少填写一个换算单位'));

    }
    if (editor.master==='bundles') data.components=data.components.split(/\n+/).filter(Boolean).map(line=>{
      const [code,quantity]=line.split('=');
      return {product:editor.pools.products.find(p=>p.code===code.trim())?.id,quantity:Number(quantity)};
    });
    payload={id:row?.id,name,code,active,data:{...(row?.data||editor.copyData),...data}};
  }
  editor.busy=true;
  try {
    const result=await api('/api/master/'+editor.master,payload);
    catalogData=null;
    if (result.id&&editor.master==='users') pageState('staff-permissions').staffId=result.id;
    if (state.active==='staff-permissions'&&editor.master==='users') {
      dismiss(true);
      showSystemPrompt('职员已新增');
      await renderStaffPermissions(document.querySelector('#content'));
      return;
    }
    dismiss(true);
    showSystemPrompt('资料已保存');
    pageState().categories=null;
    await loadPage();
    if (again) return editMaster();
  } catch (error) {
    await showError(error);
    if (error.field&&form.isConnected) form.elements.namedItem(error.field)?.focus();
  } finally {editor.busy=false;}
}
async function showError(error) {
  if (error.code==='SOURCE_NOT_POSTED'&&error.documentId) {
    if (await showSystemPrompt(chineseMessage(error),{cancelLabel:'关闭',confirmLabel:'打开关联单据'})) {
      try {await openDocumentView(error.documentId);}
      catch (problem) {await showSystemPrompt(chineseMessage(problem));}
    }
    return;
  }
  return showSystemPrompt(chineseMessage(error));
}
const copyFrom={purchaseOrder:'purchase',inquiry:'purchaseOrder',quote:'salesOrder',salesOrder:'sale',purchase:'payment',purchaseExchange:'payment',sale:'receipt',transferOrder:'transfer'};
function rowValues(line) {
  return {...line.data,product:line.product,quantity:(line.data.enteredQuantity??line.quantity)/1000,price:unitPrice(line),
    serials:(line.data.serials||[]).join(' '),debit:Number(line.data.debit||0)/100,credit:Number(line.data.credit||0)/100};
}
const executionLabels={waiting:'未执行',partial:'部分完成',complete:'已完成',closed:'已终止'};
function sourceDocumentLines(type,ref,pools) {
  if (orderFulfillment[ref.type]!==type) {
    const bySource=new Map(ref.lines.map(line=>[ref.id+':'+line.position,rowValues(line)]));
    return [...bySource.values()];
  }
  if (['complete','closed'].includes(ref.execution.state)) throw Error('关联订单已完成或已终止');
  return ref.lines.flatMap((line,index)=>{
    const remaining=ref.execution.rows[index].remaining;
    if (!remaining) return [];
    const values=rowValues(line);
    const factor=line.data.unitFactor||1;
    const quantity=remaining/1000/factor;
    const rounded=roundDecimal(quantity,4);
    if (roundDecimal(rounded*factor*1000,1)===remaining) return [{...values,quantity:rounded}];
    const product=pools.products.find(item=>item.id===line.product);
    return [{...values,quantity:remaining/1000,unit:product?.data.unit||'',price:roundDecimal(unitPrice(line)/factor,4)}];
  });
}
function convertSourcePrices(lines,source,taxInclusive,digits) {
  for (const line of lines) {
    const factor=1+Number(line.tax||0)/100;
    if (taxInclusive&&!source.data.taxInclusive) line.price*=factor;
    if (!taxInclusive&&source.data.taxInclusive) line.price/=factor;
    line.price=roundDecimal(line.price,digits);
  }
}
function carrySourceTerms(type,ref,fields) {
  if (['receipt','payment'].includes(type)) {
    fields.amount=Math.max(0,(ref.unpaid??ref.total)/100);
  }
  if (orderFulfillment[ref.type]===type) fields.discount=ref.data.discount??1;
  if (['salesOrder','sale'].includes(type)) {
    for (const key of ['settlementPartner','due','delivery','request']) if (ref.data[key]) fields[key]=ref.data[key];
  }
}
async function editDocument(type,id,sourceId) {
  if (!canSave(type,id?'edit':'create')) return;
  const alreadyOpen=()=>id&&[...documentTabs.values()].find(editor=>editor.kind==='document'&&editor.doc?.id===Number(id));
  const existing=alreadyOpen();
  if (existing) return openRoute(existing.id);
  const user=state.user;
  const promise=id?api('/api/documents/'+id):Promise.resolve(null);
  const [pools,doc,directory,systemSettings,settings]=await Promise.all([catalog(true),promise,api('/api/document-directory'),api('/api/system-settings'),
    api('/api/document-settings?'+searchParams({type}))]);
  const ref=sourceId?await api('/api/documents/'+sourceId):null;
  let reference=ref;
  if (doc?.data.reference) {
    try {reference=await api('/api/documents/'+doc.data.reference);}
    catch {reference={id:doc.data.reference,number:'原关联单据'};}
  }
  const effect=families[type][4];
  const lineDefaults=()=>effect==='journal'?{debit:0,credit:0}:{quantity:effect==='count'?0:1,discount:1,tax:0};
  const defaults={};
  if (!doc) for (const {key,kind} of documentDefaults(type)) {
    const value=settings.defaults[key];
    if (value===undefined) continue;
    if (kind&&kind!=='boolean'&&!pickerRows({type,pools,directory},kind).some(row=>row.id===value)) continue;
    defaults[key]=value;
  }
  const warehouse=doc?doc.warehouse:(ref?.warehouse??defaults.warehouse??(pools.warehouses.length===1?pools.warehouses[0].id:''));
  const fields={...(doc?doc.data:defaults),date:doc?.date||currentDate(),
    partner:doc?doc.partner:ref?.partner??defaults.partner??'',warehouse,target:doc?doc.target:ref?.target??defaults.target??'',
    department:doc?.department||state.user.department,reference:doc?.data.reference||ref?.id||''};
  for (const k of ['amount','reduction','freight','advance','fee','paid']) fields[k]=Number(fields[k]||0)/100;
  fields.handlerId=doc?.data.handlerId??(doc?.data.handler?directory.staff.find(row=>row.name===doc.data.handler)?.id:state.user.id)??'';
  if (settlementFooters.includes(type)) {
    fields.receipts=(doc?.data.receipts||[]).map(row=>({...row,amount:row.amount/100}));
    fields.saleExpenses=(doc?.data.saleExpenses||[]).map(row=>({...row,amount:row.amount/100,paid:row.paid/100}));
  }
  if (ref) carrySourceTerms(type,ref,fields);
  const lines=doc?.lines?.map(rowValues)||(!['cash','journal'].includes(effect)&&ref?sourceDocumentLines(type,ref,pools):[]);
  if (state.user!==user) return;
  const openedWhileLoading=alreadyOpen();
  if (openedWhileLoading) return openRoute(openedWhileLoading.id);
  if (ref&&['exchange','purchaseExchange'].includes(type)) for (const line of lines) line.direction='return';
  const tabId='document:'+ ++nextDocumentTab;
  const title=doc?doc.number:'新增'+families[type][0];
  const usedLabels=new Set([...documentTabs.values()].map(editor=>editor.route.label));
  let label=title;
  for (let count=2;usedLabels.has(label);count++) label=title+' ('+count+')';
  const route={label,group:families[type][2],kind:'document'};
  const precision=doc ? doc.data.precision||defaultSystemSettings : systemSettings;
  const taxEnabled=doc ? doc.data.taxEnabled!==false : systemSettings.taxEnabled;
  const taxInclusive=doc ? doc.data.taxInclusive===true : documentTaxInclusive(systemSettings,families[type][3]);
  if (ref) convertSourcePrices(lines,ref,taxInclusive,precision.priceDigits);
  documentTabs.set(tabId,{id:tabId,route,kind:'document',type,doc,pools,directory,reference,fields,lines,tab:'main',
    precision,taxEnabled,taxInclusive,
    dirty:!!ref,lineDefaults,settings,files:[],removedAttachments:[]});
  return openRoute(tabId);
}
function stashDocument() {
  const editor=state.editor;
  const form=documentEditor.querySelector('#doc-form');
  if (!form) return;
  const values=read(form);
  const fields={};
  for (const [key,value] of Object.entries(values)) {
    const [scope,index,field]=key.split('.');
    if (scope==='line' && field) editor.lines[Number(index)][field]=value;
    else if (['receipts','saleExpenses'].includes(scope)&&field) editor.fields[scope][Number(index)][field]=value;
    else fields[key]=value;
  }
  if (form.elements.invoice) fields.invoice=form.elements.invoice.checked;
  if (form.elements.fuzzy) fields.fuzzy=form.elements.fuzzy.checked;
  if (form.elements.autoPrice) fields.autoPrice=form.elements.autoPrice.checked;
  Object.assign(editor.fields,fields);
}
function priceSummary(editor) {
  const values=editor.fields;
  if (['cash','fee'].includes(families[editor.type][4])) return Number(values.amount||0);
  const discount=Number(values.discount??1);
  let sum=0;
  for (const row of editor.lines.filter(hasLineItem)) {
    const rate=editor.taxEnabled?Number(row.tax||0):0;
    const {net,tax}=lineAmounts(Number(row.quantity||0),Number(row.price||0),Number(row.discount??1)*discount,rate,editor.taxInclusive);
    sum+=(net+tax)*(['exchange','purchaseExchange'].includes(editor.type)&&row.direction==='return'?-1:1);
  }
  return sum/100+Number(values.freight||0)-Number(values.reduction||0);
}
function updateDocumentAmounts(editor) {
  const total=priceSummary(editor);
  const settled=Number(editor.fields.paid||0)+Number(editor.fields.advance||0)+
    (editor.fields.receipts||[]).reduce((sum,row)=>sum+Number(row.amount||0),0);
  const current=total-settled;
  const prior=editor.priorBalance;
  const element=documentEditor.querySelector('#doc-total');
  const gridTotal=documentEditor.querySelector('#doc-grid-total');
  if (gridTotal&&families[editor.type][4]!=='journal') gridTotal.textContent='¥ '+total.toFixed(2);
  if (!element) return;
  const balanceLabel=editor.type==='purchase'?'应付':editor.type==='sale'?'应收':'';
  const summary=['含税金额 ¥ '+total.toFixed(2)];
  if (balanceLabel) summary.push('本单'+balanceLabel+' ¥ '+current.toFixed(2));
  if (balanceLabel&&prior!=null) summary.push('此前'+balanceLabel+' ¥ '+prior.toFixed(2),'合计'+balanceLabel+' ¥ '+(current+prior).toFixed(2));
  element.textContent=summary.join('　|　');
}
async function loadPriorBalance(editor) {
  const partner=String(editor.fields.partner||'');
  if (!partner||!allow('r:往来单位应收应付')) {editor.priorBalance=null;updateDocumentAmounts(editor);return;}
  const report=await api('/api/report?'+searchParams({name:'往来单位应收应付',partner}));
  if (state.editor===editor&&String(editor.fields.partner)===partner) {
    editor.priorBalance=Number(report.rows[0]?.[editor.type==='purchase'?2:1]||0);
    updateDocumentAmounts(editor);
  }
}
const pickers={
  customers:['客户','partners'], suppliers:['供应商','partners'], partners:['往来单位','partners'],
  warehouses:['仓库','warehouses'], products:['商品','products'],
  accounts:['资金账户','accounts'], expenses:['费用科目','expenses'], carriers:['物流公司','carriers'],
  direction:['换货方向','direction'], preset:['预设售价档位','preset'],
  ledgerAccounts:['会计科目','ledgerAccounts'], staff:['经手人','staff'], departments:['部门','departments']
};
function pickerRows(editor,kind) {
  const [,key]=pickers[kind];
  let rows=editor.pools[key]||editor.directory[key];
  if (kind==='direction') rows=[{id:'out',code:'OUT',name:editor.type==='purchaseExchange'?'换入':'换出'},{id:'return',code:'RETURN',name:editor.type==='purchaseExchange'?'退回供应商':'退回'}];
  if (kind==='preset') rows=Array.from({length:10},(_,i)=>({id:i+1,code:i+1,name:'预设售价 '+(i+1)}));
  if (kind==='customers'||kind==='suppliers') rows=rows.filter(row=>[kind==='customers'?'customer':'supplier','both'].includes(row.data.type));
  if (kind==='departments') {
    rows=rows.map((name,index)=>({id:name,code:'D-'+String(index+1).padStart(2,'0'),name}));
    if (state.user.role!=='admin'&&state.user.department) rows=rows.filter(row=>row.name===state.user.department);
  }
  return rows.map(row=>{
    const data=row.data||{};
    const cells=[row.code,row.name];
    if (kind==='products') cells.push(data.spec||'',data.model||'',data.barcode||'',data.unit||'',(families[editor.type][3]==='supplier'?data.purchase??data.retail:data.retail)??'');
    if (kind==='staff') cells.push(row.department||'');
    return {id:row.id,cells,category:data.category||'',search:[...cells,data.shortName,data.pinyin,...(data.unitRows||[]).map(unit=>unit.barcode)].join(' ')};
  });
}
function pickerPath(editor,key) {
  const [scope,index,field]=key.split('.');
  if (scope==='line'&&field) return [editor.lines[Number(index)],field];
  if (field) return [editor.fields[scope][Number(index)],field];
  return [editor.fields,key];
}
function pickControl(key,kind,value,label,required=false) {
  const editor=state.editor;
  const row=editor.pickerOptions.get(kind).find(row=>String(row.id)===String(value??''));
  const prior=key==='handlerId'?editor.fields.handler:'';
  const current=row?.cells.slice(0,2).join(' ')||prior||(key==='department'?value:'');
  return '<button type="button" class="btn doc-pick '+(kind==='products'?'product-select':'')+'" data-act="doc-picker" data-value="'+e([key,kind,label,required?'required':''].join('|'))+
    '" aria-label="'+e(label+(current?' '+current:''))+'" aria-haspopup="dialog"><span>'+e(current||(kind==='products'?'输入编号/名称':'请选择'))+'</span><span class="picker-mark" aria-hidden="true">…</span></button>';
}
function applyDocumentProduct(editor,index,product,unit) {
  const row=editor.lines[index];
  row.product=product.id;
  row.unit=unit??defaultProductUnit(product.data,families[editor.type][3]);
  row.tax=editor.taxEnabled?product.data.taxRate??0:0;
  if (!editor.fields.warehouse&&editor.pools.warehouses.some(w=>w.id===Number(product.data.defaultWarehouse))) editor.fields.warehouse=product.data.defaultWarehouse;
  return applyPrice(editor,index);
}
function fillPartnerAddress(editor) {
  const {fields,pools}=editor;
  const partner=pools.partners.find(row=>row.id===Number(fields.partner));
  if (!partner||fields.address) return;
  fields.address=[partner.data.contact,partner.data.phone,partner.data.address].filter(Boolean).join(' ');
  fields.deliveryName=partner.data.contact||'';
  fields.deliveryPhone=partner.data.phone||'';
  fields.deliveryAddress=partner.data.address||'';
}
function referenceLabels(type) {
  return ({salesOrder:'选择订单',quote:'选择报价单',purchaseOrder:'选择采购订单'})[type]||'选择'+families[type][0];
}
function openReference(type) {
  const editor=state.editor;
  stashDocument();
  showDocumentPicker({
    onTable:table=>resizeDocumentPicker(table,'sources:'+editor.type+':'+type),
    title:referenceLabels(type),columns:['单据编号','往来单位','单据日期','状态','金额'],
    selected:editor.reference?.type===type?editor.fields.reference:null,optional:true,
    async load(keyword,page) {
      const result=await api('/api/document-sources?'+searchParams({target:editor.type,type,keyword,page}));
      return {...result,rows:result.rows.map(row=>({id:row.id,cells:[row.number,row.partnerName||families[type][0],row.date,statusOf(row),money(row.total)]}))};
    },
    async onPick(row,isActive) {
      if (editor.sourceLoading) return;
      editor.sourceLoading=true;
      editor.sourceVersion=(editor.sourceVersion||0)+1;
      documentEditor.inert=true;
      try {
        await applyReference(row,isActive);
      } finally {
        editor.sourceLoading=false;
        documentEditor.inert=false;
      }
    }
  });
  async function applyReference(row,isActive) {
    const ref=row?await api('/api/documents/'+row.id):null;
    if (editor!==state.editor||!isActive()) return;
    const {fields}=editor;
    const imported=ref&&families[editor.type][4]!=='cash'?sourceDocumentLines(editor.type,ref,editor.pools):null;
    if (imported) convertSourcePrices(imported,ref,editor.taxInclusive,editor.precision.priceDigits);
    editor.reference=ref;
    fields.reference=ref?.id||'';
    if (ref) {
      fields.partner=ref.partner||fields.partner;
      fields.warehouse=ref.warehouse||fields.warehouse;
      fields.target=ref.target||fields.target;
      carrySourceTerms(editor.type,ref,fields);
      if (imported) {
        editor.lines=imported;
        if (['exchange','purchaseExchange'].includes(editor.type)) for (const line of editor.lines) line.direction='return';
      }
      if (['salesOrder','sale'].includes(editor.type)) fillPartnerAddress(editor);
    }
    editor.dirty=true;
    renderDocument();
  }
}
function openDocumentPicker(selection) {
  const [key,kind,label,required]=selection.split('|');
  const editor=state.editor;
  stashDocument();
  const [target,field]=pickerPath(editor,key);
  const multiple=kind==='products';
  const columns=multiple?['商品编号','商品名称','规格','型号','条码','单位','参考单价']:['编号','名称'];
  const rows=editor.pickerOptions.get(kind);
  const categories=[...new Set(multiple?rows.flatMap(row=>{
    if (!row.category) return [];
    const parts=row.category.split('/');
    return parts.map((_,index)=>parts.slice(0,index+1).join('/'));
  }):[])].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  if (kind==='staff') columns.push('部门');
  const create=['expenses','carriers'].includes(kind)&&canMaintain(kind)?{
    label:masters[kind][0],
    async save(data) {
      await api('/api/master/'+kind,{...data,data:{}});
      editor.pools[kind]=(await api('/api/master/'+kind+'?active=1&all=1')).rows;
      editor.pickerOptions.set(kind,pickerRows(editor,kind));
      showSystemPrompt('资料已保存');
    }
  }:null;
  showDocumentPicker({title:multiple?'商品SKU选择框':'选择'+label,columns,selected:target[field],
    selectedItem:multiple?rows.find(row=>row.id===Number(target[field])):null,optional:!required,create,multiple,categories,
    load:async(keyword,page,category)=>{
      const words=keyword.toLowerCase().split(/[\s,，]+/).filter(Boolean);
      const matches=editor.pickerOptions.get(kind).filter(row=>{
        const inCategory=!category||(category==='/'?!row.category:row.category===category||row.category.startsWith(category+'/'));
        return inCategory&&words.every(word=>row.search.toLowerCase().includes(word));
      });
      return {rows:matches.slice((page-1)*25,page*25),count:matches.length};
    },
    async onPick(row) {
      if (editor!==state.editor) return;
      if (multiple) {
        const products=row.map(item=>editor.pools.products.find(product=>product.id===item.id));
        const remaining=editor.lines.filter(hasLineItem).length-Number(hasLineItem(target));
        if (remaining+products.length>maxDocumentLines) throw Error('单据明细最多 500 行');
        const index=editor.lines.indexOf(target);
        if (products.length) {
          editor.lines.splice(index+1,0,...products.slice(1).map(()=>editor.lineDefaults()));
          editor.dirty=true;
          await Promise.all(products.map((product,offset)=>applyDocumentProduct(editor,index+offset,product)));
        } else {
          Object.assign(target,{product:'',unit:'',price:'',source:''});
          editor.dirty=true;
        }
        if (state.editor===editor) renderDocument();
        return;
      }
      if (row&&kind==='ledgerAccounts'&&!hasLineItem(target)&&editor.lines.filter(hasLineItem).length>=maxDocumentLines) throw Error('单据明细最多 500 行');
      target[field]=row?.id??'';
      editor.dirty=true;
      if (key==='handlerId') editor.fields.handler=row?.cells[1]||'';
      if (key==='partner'&&['sale','salesOrder'].includes(editor.type)) {
        editor.priorBalance=null;
        fillPartnerAddress(editor);
      }
      if (state.editor===editor) renderDocument();
    }
  });
}
let settingsPanel;
const settingsGroups=['销售','采购','仓储','财务','资料'].map(group=>[
  group==='仓储'?'库存类':group==='资料'?'期初类':group+'类',
  Object.keys(families).filter(type=>families[type][2]===group||group==='仓储'&&families[type][2]==='库存')
]);
const settingsPath='/api/document-settings';
async function openDocumentSettings(mode) {
  const editor=state.editor;
  const {type}=editor;
  const data=await api(settingsPath+'?'+searchParams({type}));
  if (state.editor!==editor) return;
  settingsPanel={mode,type,section:'head',data,editor,dirty:false,saving:false,copying:false};
  renderDocumentSettings();
}
function renderDocumentSettings() {
  const panel=settingsPanel;
  const {mode,type,section,data,editor,copying}=panel;
  const title=families[type][0];
  const save=btn(copying?'确认应用':'保存','settings-save','','primary');
  if (mode==='defaults') {
    const presets={businessType:families[type][3]==='supplier'?['普通采购','委托采购']:['普通销售','批发','零售'],delivery:['配送','自提','快递','物流'],marker:['普通','加急','重点']};
    const controls=documentDefaults(type).map(({key,label,kind})=>{
      const value=data.defaults[key];
      if (kind==='boolean') return checkbox(key,value??(key==='autoPrice'),label);
      let control;
      if (kind) {
        control=select(key,pickerRows({...editor,type},kind).map(row=>[row.id,row.cells.slice(0,2).join(' ')]),value,'','不设置');
      } else {
        control=input(key,value,'maxlength="100" list="doc-default-'+key+'" placeholder="可选择或填写"')+
          '<datalist id="doc-default-'+key+'">'+presets[key].map(option=>'<option value="'+e(option)+'"></option>').join('')+'</datalist>';
      }
      return field('默认'+label,control);
    });
    modal('开单默认设置','<form novalidate id="document-settings-form" class="doc-default-values">'+controls.join('')+
      '<p class="note">仅用于当前账号以后新建的'+e(title)+'。关联单据优先沿用来源信息。</p></form>',save,true,'取消');
    dialog.classList.add('doc-default-dialog');
  } else {
    const tree=choices=>settingsGroups.map(([group,types])=>'<details open><summary>'+e(group)+'</summary>'+types
      .filter(kind=>mayConfigure(kind)&&(!choices||kind!==type)).map(kind=>choices?checkbox('target',false,families[kind][0]).replace('name="target"','name="target" value="'+e(kind)+'"'):
        '<button type="button" class="btn '+(kind===type?'active':'')+'" data-act="settings-type" data-value="'+e(kind)+'"'+
        (kind===type?' aria-current="true"':'')+'>▤ '+e(families[kind][0])+'</button>').join('')+'</details>').join('');
    const fields=documentFields(type)[section];
    const rows=fields.map((f,i)=>{
      const rule=data.fields[section]?.[f.key]||{};
      return '<tr><td>'+(i+1)+'</td><td>'+e(f.label)+'</td><td>'+input('alias.'+f.key,rule.alias,'maxlength="40" aria-label="'+e(f.label+'修改后名称')+'"')+
        '</td><td>'+e(f.kind)+'</td><td><input type="checkbox" name="required.'+f.key+'" aria-label="'+e(f.label+'必录')+'"'+
        (f.locked||rule.required?' checked':'')+(f.locked||f.readOnly?' disabled':'')+'</td><td><input type="checkbox" name="visible.'+f.key+'" aria-label="'+e(f.label+'显示')+'"'+
        ((rule.visible??!f.hidden)?' checked':'')+(f.locked||rule.required?' disabled':'')+'></td></tr>';
    });
    const details=copying?'<p>将保存 '+e(title)+' 的当前配置，并覆盖所选单据的同类字段配置。</p>'+
      '<form novalidate id="document-settings-form" class="doc-settings-targets">'+tree(true)+'</form>':
      '<div class="toolbar">'+btn('还原默认配置','settings-reset')+btn('应用到其他单据','settings-copy')+'</div>'+
      '<p class="note">配置仅对当前账号生效。隐藏字段仍保留单据中的值，系统必录字段始终显示。</p>'+
      '<div class="doc-footer-tabs" aria-label="字段分组">'+fieldSections.map(([key,label])=>btn(label,'settings-section',key,key===section?'primary':'')).join('')+'</div>'+
      '<form novalidate id="document-settings-form">'+(fields.length?documentTable('settings:'+type+':'+section,['行号','字段名称','修改后名称','类型','是否必录','是否显示'],rows):empty('此类单据没有这组字段'))+'</form>';
    modal('单据字段设置','<div class="doc-field-layout"><aside class="doc-field-tree"><strong>单据类型</strong>'+tree(false)+'</aside>'+
      '<section class="doc-field-content">'+details+'</section></div>',(copying?btn('返回字段设置','settings-back'):'')+save,false,'取消');
    dialog.classList.add('doc-fields-dialog');
  }
  const form=dialog.querySelector('#document-settings-form');
  form.addEventListener('submit',event=>{event.preventDefault();saveDocumentSettings().catch(showError);});
  form.addEventListener('input',event=>{
    if (copying) return;
    panel.dirty=true;
    if (mode!=='fields'||!event.target.name.startsWith('required.')) return;
    const visibility=form.elements.namedItem(event.target.name.replace(/^required\./,'visible.'));
    if (event.target.checked) visibility.checked=true;
    visibility.disabled=event.target.checked;
  });
}
function stashSettingsSection() {
  const {type,section,data}=settingsPanel;
  const {elements}=dialog.querySelector('#document-settings-form');
  data.fields[section]=Object.fromEntries(documentFields(type)[section].map(f=>[f.key,{
    alias:elements.namedItem('alias.'+f.key).value,required:elements.namedItem('required.'+f.key).checked,
    visible:elements.namedItem('visible.'+f.key).checked
  }]));
}
async function saveDocumentSettings() {
  const panel=settingsPanel;
  if (panel.saving) return;
  const {type,mode,copying}=panel;
  const form=dialog.querySelector('#document-settings-form');
  let values,targets;
  if (mode==='defaults') {
    values=Object.fromEntries(new FormData(form));
    for (const {key,kind} of documentDefaults(type)) if (kind==='boolean') values[key]=form.elements.namedItem(key).checked;
  } else {
    if (copying) {
      targets=new FormData(form).getAll('target');
      if (!targets.length) return showError(Error('请选择要应用的单据类型'));
    } else stashSettingsSection();
    values=panel.data.fields;
  }
  panel.saving=true;
  try {
    const result=await api(settingsPath,{type,mode,values,targets});
    for (const editor of documentTabs.values()) {
      if (result.updated&&Object.hasOwn(result.updated,editor.type)) editor.settings.fields=result.updated[editor.type];
      if (editor.type===type&&result.defaults) editor.settings.defaults=result.defaults;
    }
    if (settingsPanel!==panel||!dialog.open) return;
    dialog.close();
    if (result.updated&&state.editor?.kind==='document') renderDocument();
    showSystemPrompt(copying?'字段设置已保存并应用':mode==='fields'?'字段设置已保存':'默认设置已保存，下次新建生效');
  } finally {panel.saving=false;}
}
async function switchSettingsType(type) {
  const panel=settingsPanel;
  if (panel.saving||type===panel.type) return;
  if (panel.dirty&&!await confirmAction('切换单据类型会放弃未保存的更改，确定切换？')) return;
  panel.saving=true;
  try {
    const data=await api(settingsPath+'?'+searchParams({type}));
    if (settingsPanel!==panel||!dialog.open) return;
    Object.assign(panel,{data,type,dirty:false,copying:false});
    renderDocumentSettings();
  } finally {panel.saving=false;}
}
function renderDocument() {
  const editor=state.editor;
  editor.pickerOptions??=new Map(Object.keys(pickers).map(kind=>[kind,pickerRows(editor,kind)]));
  const scroll=documentEditor.querySelector('.modal-main')?.scrollTop??editor.scroll??0;
  const {type,pools,reference,fields,lines,doc}=editor;
  const [label,,,partnerType,effect]=families[type];
  const cash=effect==='cash';
  if (!cash&&lines.filter(hasLineItem).length<maxDocumentLines&&(!lines.length||hasLineItem(lines.at(-1)))) {
    lines.push(editor.lineDefaults());
  }
  const journal=effect==='journal';
  const fee=effect==='fee';
  const sale=type==='sale';
  const inbound=type==='purchase';
  const salesHeader=sale||type==='salesOrder';
  const amounts=settlementFooters.includes(type);
  const shipping=logisticsFooters.includes(type);
  const purchasing=families[type][3]==='supplier';
  const hasStock=stockEffects.includes(effect)||['purchaseOrder','salesOrder','transferOrder','purchaseFee'].includes(type);
  const optionalWarehouse=['inquiry','quote'].includes(type);
  const hasTarget=effect==='transfer'||type==='transferOrder';
  const stash=key=>fields[key]??'';
  const fieldMap=documentFields(type);
  const step=key=>String(10**(-editor.precision[key+'Digits']));
  const rule=(section,f)=>editor.settings.fields[section]?.[f.key]||{visible:!f.hidden};
  const visible=(section,f)=>rule(section,f).visible;
  const configuredField=(section,key,control,required=false,cls='')=>{
    const f=fieldMap[section].find(item=>item.key===key);
    if (!visible(section,f)) return '';
    const config=rule(section,f);
    return field(config.alias||f.label,control,required||f.locked||config.required,cls);
  };
  const head=(...args)=>configuredField('head',...args);
  const foot=(...args)=>configuredField('foot',...args);
  const tabs=[['main',sale?'销售出库单':'单据主体'],['defaults','开单默认设置'],['prices','价格策略'],['fields','字段设置'],['config','单据配置']];
  let inner='';
  if (editor.tab==='main') {
    const partyLabel=type==='purchase'?'供货单位':sale?'购买单位':purchasing?'供应商':'客户';
    const party=partnerType?head('partner',pickControl('partner',purchasing?'suppliers':'customers',fields.partner,partyLabel,true),true):'';
    const warehouseLabel=inbound?'收货仓库':sale?'发货仓库':hasTarget?'调出仓库':'仓库';
    const references=(relatedDocuments[type]||[]).filter(source=>allow('d:'+source));
    const sourceTools=references.map(kind=>btn(referenceLabels(kind),'doc-reference',kind,'doc-tool')).join(' ')+
      (reference?'<span class="note">'+e(reference.number+' '+(reference.partnerName||''))+'</span>':'');
    inner='<form novalidate id="doc-form"><p id="doc-limit-warning" class="doc-limit-warning" aria-live="polite"></p><div class="doc-header-fields form-grid">'+party+
      (hasStock||optionalWarehouse?head('warehouse',pickControl('warehouse','warehouses',fields.warehouse,warehouseLabel,hasStock),hasStock):'')+
      (hasTarget?head('target',pickControl('target','warehouses',fields.target,'调入仓库',true),true):'')+
      head('handlerId',pickControl('handlerId','staff',fields.handlerId,'经手人'))+
      (inbound||salesHeader?head('due',input('due',stash('due'),'type="date"')):'')+
      '<details class="doc-more"'+(editor.headerExpanded?' open':'')+'><summary class="btn">更多</summary><div class="form-grid">'+
      head('date',input('date',fields.date,'required type="date" '+(doc?'readonly':'')),true)+
      head('department',pickControl('department','departments',fields.department,'部门',state.user.role!=='admin'&&!!state.user.department))+
      (salesHeader?head('settlementPartner',pickControl('settlementPartner','partners',stash('settlementPartner'),'结算单位')):'')+
      head('summary',input('summary',stash('summary'),'maxlength="200"'))+
      (partnerType?head('businessType',input('businessType',stash('businessType'),'maxlength="100"'))+head('delivery',input('delivery',stash('delivery'),'maxlength="100"')):'')+
      (salesHeader?head('request',input('request',stash('request'))):'')+
      head('marker',input('marker',stash('marker'),'maxlength="100"'))+
      fieldMap.headCustom.map(f=>configuredField('headCustom',f.key,input(f.key,stash(f.key),'maxlength="200"'))).join('')+
      head('note',input('note',stash('note')),false,'span2')+'</div></details></div>';
    if (!cash) {
      const entries=['body','bodyCustom'].flatMap(section=>fieldMap[section].map(f=>[section,f]));
      const shown=entries.map(([section,f],index)=>({f,index,section})).filter(({section,f})=>visible(section,f)&&(editor.taxEnabled||f.key!=='tax'));
      const list=['行号','操作',...shown.map(({section,f})=>{
        const config=rule(section,f);
        return (config.alias||(f.key==='price'&&editor.taxInclusive?'含税单价':f.label))+(config.required?' *':'');
      })];
      const itemRows=lines.map((line,i)=>{
        const n=key=>'line.'+i+'.'+key;
        const lineNum=(key,step)=>numeric(n(key),line[key],step);
        const item=pools.products.find(r=>r.id===Number(line.product));
        const base=item?.data.unit||'';
        const unitOptions=item?[...productUnits(item.data)].filter(([label])=>label).map(([label,factor])=>[label,factor===1?label:label+'（'+factor+base+'）']):[];
        const columns=journal?[pickControl(n('ledgerAccount'),'ledgerAccounts',line.ledgerAccount,'会计科目',true),lineNum('debit'),lineNum('credit'),input(n('note'),line.note)]:
          [input(n('batch'),line.batch),input(n('production'),line.production,'type="date"'),
            pickControl(n('product'),'products',line.product,'商品'),e(unitDetails(item?.data||{},line.unit)?.barcode||item?.data.barcode||''),input(n('serials'),line.serials),
            ...(effect==='exchange'?[pickControl(n('direction'),'direction',line.direction||'out','换货方向',true)]:[]),
            lineNum('quantity',step('quantity')),(unitOptions.length>1?select(n('unit'),unitOptions,line.unit||base):e(base)),lineNum('price',step('price')),lineNum('discount',step('discount')),lineNum('tax'),input(n('expiry'),line.expiry,'type="date"'),e(line.source||'手工'),input(n('note'),line.note)];
        columns.push(...fieldMap.bodyCustom.map(f=>input(n(f.key),line[f.key],'maxlength="200"')));
        const pending=i===lines.length-1&&!hasLineItem(line);
        const actions='<button type="button" class="btn" data-act="line-add" data-value="'+i+'" aria-label="在第 '+(i+1)+' 行后插入">+</button>'+
          (pending?'':'<button type="button" class="btn danger" data-act="line-remove" data-value="'+i+'" aria-label="删除第 '+(i+1)+' 行">−</button>');
        return '<tr'+(pending?' class="doc-entry-row"':'')+'><td class="doc-line-number">'+(i+1)+'</td><td class="doc-line-actions">'+actions+'</td>'+
          shown.map(({index})=>'<td>'+columns[index]+'</td>').join('')+'</tr>';
      });
      inner+='<div class="toolbar doc-tools" aria-label="明细工具">'+btn('增行','line-add')+(!journal?input('scan','','placeholder="条码扫描输入" aria-label="条码扫描输入"')+btn('扫码添加','scan','','doc-tool')+checkbox('fuzzy',fields.fuzzy,'扫码枪模糊匹配')+'<label class="btn doc-import-label">导入商品<input type="file" id="doc-import-file" aria-label="导入商品" accept=".xlsx"></label>':'')+sourceTools+'</div>'+
        '<div class="doc-grid"><div class="editor-table">'+documentTable('editor:'+type,list,itemRows,['rowNumber','rowActions',...shown.map(({section,f})=>section+':'+f.key)],{
          'body:product':220,'body:ledgerAccount':190,'body:production':125,'body:expiry':125,'body:barcode':126
        })+'</div>'+
        '<div class="doc-grid-summary"><strong>合计</strong><output id="doc-grid-total">'+(journal?'':'¥ '+priceSummary(editor).toFixed(2))+'</output></div></div>';
    } else if (sourceTools) {
      inner+='<div class="toolbar doc-tools">'+sourceTools+'</div>';
    }
    const footerPanels=[['amounts','表尾信息'],...(amounts?[['expenses',purchasing?'采购费用':'销售费用']]:[]),
      ...(shipping?[['shipping','物流与发票']]:[]),['attachments','附件']];
    const currentFooter=editor.footerTab||'amounts';
    const panel=key=>'<section class="doc-footer-panel"'+(currentFooter===key?'':' hidden')+'>';
    inner+='<div class="doc-audit"><span>制单人 '+e(doc?.creatorName||state.user.name)+'</span>'+
      (doc?.created?'<span>创建时间 '+e(doc.created)+'</span>':'')+'</div>'+
      '<div class="doc-footer-tabs" aria-label="单据页脚">'+footerPanels.map(([key,title])=>
        btn(title,'doc-footer-tab',key,key===currentFooter?'primary':'')).join('')+'</div>'+panel('amounts')+
      '<div class="form-grid">'+      (cash||fee?foot('amount',numeric('amount',stash('amount')),true):!journal?foot('discount',numeric('discount',fields.discount??1,step('discount')))+foot('reduction',numeric('reduction',stash('reduction')))+foot('freight',numeric('freight',stash('freight'))):'')+
      (amounts?foot('advance',numeric('advance',stash('advance')))+foot('paid',numeric('paid',stash('paid'))):'')+
      ((cash&&!['openingAR','openingAP'].includes(type)||fee||amounts)?foot('account',pickControl('account','accounts',stash('account'),'资金账户')):'')+
      (type==='cashTransfer'?foot('targetAccount',pickControl('targetAccount','accounts',stash('targetAccount'),'转入账户',true),true):'')+
      (['expense','income','deferred'].includes(type)?foot('subject',pickControl('subject','expenses',stash('subject'),'费用/收入科目')):'')+'</div>';
    if (amounts) {
      const extraSale=(group,headers,fieldsToShow,optionsByField={})=>documentTable('editor:'+type+':'+group,['操作',...headers],fields[group].map((row,i)=>{
        const groupField=key=>group+'.'+i+'.'+key;
        const cols=fieldsToShow.map(key=>optionsByField[key]?pickControl(groupField(key),optionsByField[key][0],row[key],optionsByField[key][1]):
          ['amount','paid'].includes(key)?numeric(groupField(key),row[key]):input(groupField(key),row[key]));
        return '<tr><td>'+btn('移除','sale-extra-remove',group+'|'+i,'danger')+'</td>'+cols.map(control=>'<td>'+control+'</td>').join('')+'</tr>';
      }));
      const direction=purchasing?'付款':'收款';
      const expense=purchasing?'采购费用':'销售费用';
      inner+='<div class="toolbar doc-payment-tools"><strong>'+direction+'信息</strong>'+btn('添加'+direction+'账户','sale-extra','receipts')+'</div>'+
        (fields.receipts.length?extraSale('receipts',[direction+'账户','金额'],['account','amount'],{account:['accounts',direction+'账户']}):'')+
        '</section>'+panel('expenses')+'<div class="toolbar">'+btn('添加'+expense,'sale-extra','saleExpenses')+'</div>'+
        extraSale('saleExpenses',['费用往来单位','费用科目','费用金额','付款账户','付款金额','明细备注'],
          ['partner','subject','amount','account','paid','note'],{account:['accounts','付款账户'],partner:['suppliers','费用往来单位'],subject:['expenses','费用科目']});
    }
    inner+='</section>';
    if (shipping) {
      inner+=panel('shipping')+'<div class="form-grid">'+
        foot('address',input('address',stash('address'),'placeholder="粘贴联系人 / 电话 / 地址"'),false,'span2')+
        '<div class="span2">'+btn('识别收货地址','parse-address')+(salesHeader&&canMaintain('partners')?' '+btn('保存为客户收货资料','save-address'):'')+'</div>'+
        foot('deliveryName',input('deliveryName',stash('deliveryName')))+foot('deliveryPhone',input('deliveryPhone',stash('deliveryPhone')))+
        foot('deliveryAddress',input('deliveryAddress',stash('deliveryAddress')),false,'span2')+
        foot('sender',input('sender',stash('sender')),false,'span2')+
        foot('carrier',pickControl('carrier','carriers',stash('carrier'),'物流公司'))+foot('tracking',input('tracking',stash('tracking')))+
        foot('carrierFee',numeric('carrierFee',stash('carrierFee')))+(visible('foot',fieldMap.foot.find(f=>f.key==='invoice'))?checkbox('invoice',fields.invoice,editor.settings.fields.foot?.invoice?.alias||'需要开票'):'')+'</div></section>';
    }
    const existing=(doc?.attachments||[]).filter(f=>!editor.removedAttachments.includes(f.id));
    inner+=panel('attachments')+'<div class="toolbar">'+btn('附件上传','attachment-add')+
      '<input id="attachment-files" type="file" multiple accept=".jpg,.jpeg,.gif,.png,.bmp,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf,.zip,.rar" hidden>'+
      existing.map(f=>'<span><a data-act="download-file" href="/api/attachments/'+f.id+'">'+e(f.name)+'</a> '+btn('移除','attachment-remove',f.id,'danger')+'</span>').join('')+
      editor.files.map((f,i)=>'<span>'+e(f.name)+' '+btn('移除','attachment-remove','new:'+i,'danger')+'</span>').join('')+'</div>';
    inner+='</section></form>';
  } else if (editor.tab==='prices') {
    inner='<form novalidate id="doc-form"><div class="form-grid">'+field('预设售价档位',pickControl('preset','preset',fields.preset||1,'预设售价档位',true))+'</div><p class="note">取价顺序为往来单位价格本、数量阶梯价、预设售价和默认商品价。</p></form>';
  } else {
    inner='<p class="note">单据保存后进入草稿。提交审核并通过后，在单据中心记账。</p>';
  }
  const footer=(!journal?'<output class="doc-total left" id="doc-total"></output>':'')+
    btn('保存','doc-save','','primary')+(doc&&allow('d:'+type,'print')?btn('打印单据','print-doc',doc.id):'')+
    (allow('d:'+type,'print')?btn('保存并打印','doc-save','print'):'')+(canSave(type)?btn('保存并新增','doc-save','again'):'');
  documentEditor.innerHTML='<div class="modal-layout"><div class="modal-main"><div class="doc-title-bar"><div class="doc-identity"><span>单据编号　'+
    e(doc?.number||'保存时生成')+'</span><span>录单时间　'+e(doc?.created||'保存时记录')+
    '</span></div><strong>'+e(label)+'</strong><div class="doc-settings">'+tabs.filter(([key])=>key!=='main'||editor.tab!=='main').map(([key,title])=>
      btn(key==='main'?'返回单据':title,'doc-tab',key,key===editor.tab?'primary':'')).join('')+'</div></div>'+inner+
    '</div><footer class="modal-foot">'+footer+btn('关闭','close-tab',editor.id)+'</footer></div>';
  documentEditor.querySelector('.modal-main').scrollTop=scroll;
  updateDocumentAmounts(editor);
  const form=documentEditor.querySelector('#doc-form');
  scheduleDocumentCheck(editor);
  form?.querySelector('.doc-more')?.addEventListener('toggle',event=>{editor.headerExpanded=event.target.open;});
  form?.addEventListener('submit',event=>{
    event.preventDefault();
    if (document.activeElement?.name==='scan') scanLine();
    else saveDocumentForm('');
  });
  form?.addEventListener('input',()=>{
    stashDocument();
    updateDocumentAmounts(editor);
    scheduleDocumentCheck(editor);
  });
  if ((sale||inbound)&&editor.tab==='main') loadPriorBalance(editor).catch(showError);
  form?.addEventListener('change',async event=>{
    const match=event.target.name?.match(/^line\.(\d+)\.(quantity|unit)$/);
    if (match) await applyPrice(editor,Number(match[1]),form);
  });
  documentEditor.querySelector('#attachment-files')?.addEventListener('change', event=>{
    const selected=Array.from(event.target.files);
    const existing=(doc?.attachments||[]).filter(f=>!editor.removedAttachments.includes(f.id));
    const files=[...editor.files,...selected];
    if (files.some(f=>f.size>15*1024*1024||!f.size)) return showError(Error('单个附件须大于 0 字节且不超过 15 MB'));
    if (files.length+existing.length>10||[...files,...existing].reduce((sum,file)=>sum+file.size,0)>30*1024*1024)
      return showError(Error('每单最多 10 个附件，合计不超过 30 MB'));
    stashDocument();
    editor.files=files;
    editor.dirty=true;
    renderDocument();
  });
  documentEditor.querySelector('#doc-import-file')?.addEventListener('change',async event=>{
    const file=event.target.files[0];
    if (!file||editor.sourceLoading) return;
    const sourceVersion=editor.sourceVersion;
    try {
      const workbook=await excelUpload(file,200_000);
      const parsed=await api('/api/document-lines/import',{type,workbook});
      const rows=parsed.rows.map(row=>row.map(cell=>cell.trim()));
      if (state.editor!==editor||sourceVersion!==editor.sourceVersion) return;
      const keys=rows[0]||[];
      const header=keys.some(key=>['商品编号','条码','code','barcode'].includes(key));
      const indexOf=(aliases,fallback)=>header?keys.findIndex(key=>aliases.includes(key)):fallback;
      const indexes={
        code:indexOf(['商品编号','code'],0),barcode:indexOf(['条码','barcode'],0),quantity:indexOf(['数量','quantity'],1),
        price:indexOf(['含税单价','不含税单价','单价','price'],2),unit:indexOf(['单位','unit'],-1)
      };
      const existing=editor.lines.filter(hasLineItem);
      const insertAt=hasLineItem(editor.lines.at(-1))?editor.lines.length:Math.max(0,editor.lines.length-1);
      const data=header?rows.slice(1):rows;
      if (!data.length) throw Error('文件中没有商品明细');
      if (data.length+existing.length>maxDocumentLines) throw Error('单据明细最多 500 行');
      const added=data.map((row,i)=>{
        const code=row[indexes.code];
        const barcode=row[indexes.barcode];
        const quantity=Number(row[indexes.quantity]);
        const price=row[indexes.price];
        const matches=pools.products.filter(p=>header?((code&&p.code===code)||(barcode&&p.data.barcode===barcode)):
          (p.code===code||p.data.barcode===code));
        const at='第 '+(i+(header?2:1))+' 行：';
        if (matches.length!==1) throw Error(at+'商品编号或条码未找到唯一商品');
        if (!(quantity>0&&quantity<=1e6)) throw Error(at+'请填写有效的数量');
        if (price&&(Number.isNaN(Number(price))||Number(price)<0||Number(price)>1e8)) throw Error(at+'请填写有效的单价');
        const product=matches[0];
        const unit=row[indexes.unit]||product.data.unit||'';
        if (!productUnits(product.data).has(unit)) throw Error(at+'单位与商品资料不符');
        const tax=editor.taxEnabled?Number(product.data.taxRate??0):0;
        const priceHeader=keys[indexes.price];
        const factor=1+tax/100;
        let enteredPrice=Number(price);
        if (priceHeader==='含税单价'&&!editor.taxInclusive) enteredPrice/=factor;
        if (priceHeader==='不含税单价'&&editor.taxInclusive) enteredPrice*=factor;
        return {product:product.id,unit,quantity:roundDecimal(quantity,editor.precision.quantityDigits),
          price:price?roundDecimal(enteredPrice,editor.precision.priceDigits):'',discount:1,tax};
      });
      editor.lines.splice(insertAt,0,...added);
      editor.dirty=true;
      await Promise.all(added.map((row,index)=>row.price===''?applyPrice(editor,insertAt+index):null));
      if (state.editor!==editor) return;
      renderDocument();
      showSystemPrompt('已导入 '+added.length+' 行商品明细');
    } catch (error) {showError(error);}
  });
}
async function applyPrice(editor,i,form) {
  const row=editor.lines[i];
  if (!row?.product||editor.fields.autoPrice===false) return;
  const snapshot=[row.product,row.quantity,row.unit,editor.fields.partner].join('|');
  const product=editor.pools.products.find(p=>p.id===Number(row.product));
  const factor=productUnits(product?.data||{}).get(row.unit||product?.data.unit||'')||1;
  const params={product:row.product,quantity:Number(row.quantity||0)*factor,partner:editor.fields.partner,side:families[editor.type][3],preset:editor.fields.preset||1};
  try {
    const price=await api('/api/price?'+searchParams(params));
    if (!documentTabs.has(editor.id)||editor.lines[i]!==row||snapshot!==[row.product,row.quantity,row.unit,editor.fields.partner].join('|')) return;
    const override=unitDetails(product.data,row.unit)?.[params.side==='supplier'?'purchase':'retail'];
    const unitPrice=product.data.autoUnitPrice===false&&override!=null;
    row.price=roundDecimal(unitPrice?override:price.price*factor,editor.precision.priceDigits);
    row.source=unitPrice?'单位价格':price.source;
    if (state.editor===editor) {
      const liveForm=documentEditor.querySelector('#doc-form')||form;
      if (liveForm?.elements['line.'+i+'.price']) liveForm.elements['line.'+i+'.price'].value=row.price;
      updateDocumentAmounts(editor);
    }
  } catch (error) {if (state.editor===editor) showError(error);}
}
async function scanLine() {
  const editor=state.editor;
  const term=documentEditor.querySelector('input[name=scan]')?.value.trim();
  if (!term) return;
  const choices=editor.pools.products;
  const exact=choices.filter(p=>p.data.barcode===term||p.code===term||p.data.unitRows?.some(unit=>unit.barcode===term));
  const matches=exact.length?exact:editor.fields.fuzzy?choices.filter(p=>[p.data.barcode,p.code,p.name].some(v=>String(v||'').toLowerCase().includes(term.toLowerCase()))):[];
  if (matches.length!==1) return showError(Error(matches.length?'匹配多个商品，请扫描完整条码':'未找到对应商品'));
  if (editor.lines.filter(hasLineItem).length>=maxDocumentLines) return showError(Error('单据明细最多 500 行'));
  const i=hasLineItem(editor.lines.at(-1))?editor.lines.push(editor.lineDefaults())-1:editor.lines.length-1;
  editor.dirty=true;
  editor.fields.scan='';
  documentEditor.querySelector('input[name=scan]').value='';
  await applyDocumentProduct(editor,i,matches[0],matches[0].data.unitRows?.find(unit=>unit.barcode===term)?.name);
  if (editor===state.editor) {
    renderDocument();
    documentEditor.querySelector('input[name=scan]')?.focus();
  }
}
function documentPayload(editor) {
  const {date,partner,warehouse,target,department,scan,...data}=editor.fields;
  if (settlementFooters.includes(editor.type)) {
    data.receipts=data.receipts.filter(row=>row.account||Number(row.amount));
    data.saleExpenses=data.saleExpenses.filter(row=>Number(row.amount)||Number(row.paid));
  }
  return {id:editor.doc?.id,revision:editor.doc?.data.revision,type:editor.type,date,partner,warehouse,target,
    department,data,lines:editor.lines.filter(hasLineItem)};
}

function scheduleDocumentCheck(editor) {
  const review=documentEditor.querySelector('#doc-limit-warning');
  if (!review) return;
  clearTimeout(editor.validationTimer);
  review.textContent='';
  const payload=documentPayload(editor);
  if (!payload.partner&&families[editor.type][3]) return;
  if (['receipt','payment'].includes(editor.type)?!Number(payload.data.amount):!payload.lines.length||!payload.warehouse) return;
  const snapshot=JSON.stringify(payload);
  editor.validationTimer=setTimeout(async()=>{
    if (state.editor!==editor||!review.isConnected||editor.sourceLoading||editor.busy) return;
    try {await api('/api/documents/validate',JSON.parse(snapshot));}
    catch (error) {
      if (error.code==='DOCUMENT_LIMIT'&&state.editor===editor&&review.isConnected&&snapshot===JSON.stringify(documentPayload(editor)))
        review.textContent=chineseMessage(error);
    }
  },300);
}
async function saveDocumentForm(action) {
  const editor=state.editor;
  if (editor?.kind!=='document'||editor.busy||editor.sourceLoading) return;
  if (editor.tab!=='main') {
    stashDocument();editor.tab='main';renderDocument();
  }
  const form=documentEditor.querySelector('#doc-form');
  for (const node of form.elements) {
    if (!node.willValidate||node.validity.valid) continue;
    const more=node.closest('details');
    if (more) more.open=true;
  }
  if (!validateForm(form)) return;
  stashDocument();
  const {type}=editor;
  for (const control of form.querySelectorAll('[data-act="doc-picker"]')) {
    const [key,,label,required]=control.dataset.value.split('|');
    if (!required||key.startsWith('line.')) continue;
    const [target,field]=pickerPath(editor,key);
    if (!target[field]) {
      await showSystemPrompt('请选择'+label+'。');
      control.focus();
      return;
    }
  }
  const payload=documentPayload(editor);
  editor.busy=true;
  try {
    const attachments=await Promise.all(editor.files.map(file=>new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve({name:file.name,content:String(reader.result).split(',')[1]});
      reader.onerror=()=>reject(Error('无法读取附件：'+file.name));
      reader.readAsDataURL(file);
    })));
    const result=await api('/api/documents',{...payload,attachments,removedAttachments:editor.removedAttachments});
    if (!documentTabs.has(editor.id)) return;
    const wasActive=state.active===editor.id;
    removeTab(editor.id);
    const savedMessage='单据已保存 · '+result.number;
    const list='d:'+type;
    pageState(list).result=null;
    for (const id of state.tabs.filter(id=>routes[id]?.kind==='docs')) pageState(id).result=null;
    if (wasActive) await openRoute(list);
    else refreshTabs();
    if (action==='print') await printDocument(result);
    showSystemPrompt(savedMessage);
    if (action==='again') await editDocument(type);
  } catch (error) {
    if (state.editor===editor) showError(error);
    else showSystemPrompt(editor.route.label+' · '+chineseMessage(error));
  } finally {editor.busy=false;}
}
async function openDocumentView(id,neighbors) {
  const origin=state.active;
  const user=state.user;
  const source=pageState();
  const series=neighbors||(tabRoute(origin)?.kind==='docs'?source.result?.rows.map(row=>row.id):source.result?.documentIds)||[];
  const doc=await api('/api/documents/'+id+'?detail=1');
  if (state.user!==user||state.active!==origin) return;
  const tabId='view:'+doc.id;
  documentTabs.set(tabId,{kind:'document-view',route:{label:doc.number,group:families[doc.type][2],kind:'document-view'}});
  const view=pageState(tabId);
  view.detail=doc;
  if (series.length) view.neighbors=[...new Set(series)];
  return openRoute(tabId);
}
async function documentDetails(id) {
  const routeId=state.active;
  const page=pageState();
  page.selected=Number(id);
  const result=await api('/api/documents/'+id+'?detail=1');
  if (routeId!==state.active||page.selected!==result.id) return;
  page.detail=result;
  updateDetails(tabRoute(routeId)?.kind==='document-view'?page.detailTab||'items':result.execution?'execution':'items');
}
function statusOf(doc) {
  if (doc.status==='posted') {
    const effect=families[doc.type][4];
    if (effect==='in') return '已入库';
    if (effect==='out') return '已出库';
  }
  return statusNames[doc.status];
}
function updateDetails(tab) {
  const page=pageState();
  const doc=page.detail;
  const panel=document.querySelector('#detail-area');
  if (!panel||!doc) return;
  page.detailTab=tab;
  const viewing=tabRoute(state.active)?.kind==='document-view';
  const navigation=page.neighbors||[];
  const position=navigation.indexOf(doc.id);
  const pager=viewing&&position>=0?'<div class="toolbar">'+
    (position>0?btn('上一单','document-neighbor',navigation[position-1]):'')+
    (position+1<navigation.length?btn('下一单','document-neighbor',navigation[position+1]):'')+
    '<span class="note">'+(position+1)+' / '+navigation.length+'</span></div>':'';
  document.querySelectorAll('tr[data-row=document]').forEach(row=>row.classList.toggle('picked',Number(row.dataset.id)===doc.id));
  const execution=doc.execution;
  const executable=!execution||!['complete','closed'].includes(execution.state);
  const downstream=copyFrom[doc.type];
  const mayGenerate=downstream&&executable&&['posted','settled'].includes(doc.status)&&canSave(downstream);
  const returnTypes=doc.type==='purchase'?['purchaseReturn','purchaseExchange']:doc.type==='sale'?['salesReturn','exchange']:[];
  const mayReturn=['posted','settled'].includes(doc.status);
  const toolbar=(['draft','rejected'].includes(doc.status)&&canSave(doc.type,'edit')?btn('编辑','doc-edit',doc.id):'')+
    (transitions[doc.status]||[]).filter(action=>allow('d:'+doc.type,action)&&!(execution?.state==='complete'&&action==='settle')).map(action=>btn(execution&&action==='settle'?'终止余量':actions[action],'transition',action,action==='delete'?'danger':['submit','approve','post'].includes(action)?'primary':'')).join('')+
    (mayGenerate&&(!['receipt','payment'].includes(downstream)||doc.unpaid>0)?btn('生成'+families[downstream][0],'derive',doc.id):'')+
    (mayReturn?returnTypes.filter(type=>canSave(type)).map(type=>btn('生成'+families[type][0],'derive-return',type+'|'+doc.id)).join(''):'')+
    (allow('d:'+doc.type,'print')?btn('打印单据','print-doc',doc.id)+
      (doc.type==='sale'?btn('打印物流单','print-logistics',doc.id)+btn('全部条码打印','print-barcodes',doc.id):''):'');
  const tabs=[...(execution?[['execution','执行情况']]:[]),['items','商品明细'],['amounts','金额与结算'],['shipping','收货与物流'],['invoice','发票信息'],['related','关联单据'],['record','单据信息'],['history','操作日志'],['attachments','附件']];
  const info=doc.data;
  const detailTable=(headers,rows)=>documentTable('detail:'+doc.type+':'+headers[0]+':'+headers.length,headers,rows);
  const effect=families[doc.type][4];
  const progress=execution?'<div class="toolbar"><strong>'+e(executionLabels[execution.state])+'</strong></div>'+
    detailTable(['商品编号','商品名称','订购数量（基本单位）','已执行数量','剩余数量'],execution.rows.map((row,index)=>
      cells([doc.lines[index].productCode,doc.lines[index].productName,row.ordered/1000,row.done/1000,row.remaining/1000])))+
    '<div class="toolbar">'+(execution.documents.length?execution.documents.map(row=>btn(row.number,'doc-details',row.id)).join(''):'<span class="note">暂无已记账的关联出入库单</span>')+'</div>':'';
  const names=doc.names||{};
  const fieldName=id=>names[id]||id||'—';
  const amounts=[['含税金额',money(doc.total)],['整单折扣',info.discount??1],['整单优惠',money(info.reduction)],
    ['运费',money(info.freight)],['预付款或预收款冲抵',money(info.advance)],['本单已录收付款',money(info.paid)]];
  if (doc.unpaid!=null&&['posted','settled'].includes(doc.status)) amounts.push(['当前未结金额',money(doc.unpaid)]);
  if (info.account) amounts.push(['资金账户',fieldName(info.account)]);
  if (info.targetAccount) amounts.push(['转入账户',fieldName(info.targetAccount)]);
  const receipts=info.receipts?.length?detailTable(['账户','收付款金额'],info.receipts.map(row=>cells([fieldName(row.account),money(row.amount)]))):'';
  const expenses=info.saleExpenses?.length?detailTable(['费用往来单位','费用科目','费用金额','付款金额','付款账户','备注'],
    info.saleExpenses.map(row=>cells([fieldName(row.partner),fieldName(row.subject),money(row.amount),money(row.paid),fieldName(row.account),row.note]))):'';
  const relationRows=doc.relations||[];
  const components={
    execution:progress,
    amounts:detailTable(['项目','数值'],amounts.map(cells))+receipts+expenses,
    history:doc.history?.length?detailTable(['操作时间','操作员','动作'],doc.history.map(row=>cells([row.date,row.operator,actions[row.action]||row.action]))):empty('暂无操作日志'),
    items:effect==='journal'?detailTable(['会计科目 ID','借方金额','贷方金额','备注'],doc.lines.map(r=>cells([r.data.ledgerAccount,money(r.data.debit),money(r.data.credit),r.data.note]))):
      doc.lines.length?detailTable(['商品编号','商品名称','数量','单位',info.taxInclusive?'含税单价':'不含税单价','不含税金额','税额','批次号','序列号','备注'],doc.lines.map(r=>cells([r.productCode,r.productName,(r.data.enteredQuantity??r.quantity)/1000,r.data.unit,unitPrice(r).toFixed(info.precision?.priceDigits??2),money(r.net),money(r.tax),r.data.batch,(r.data.serials||[]).join('、'),r.data.note]))):
      detailTable(['金额','资金账户 ID','摘要'],[cells([money(doc.total),info.account||'—',info.summary||''])]),
    shipping:detailTable(['收货信息','寄件信息','物流公司','物流单号','物流运费'],[cells([[info.deliveryName,info.deliveryPhone,info.deliveryAddress].filter(Boolean).join(' ')||info.address||'—',info.sender||'—',fieldName(info.carrier),info.tracking||'—',info.carrierFee||'—'])]),
    invoice:detailTable(['需要开票','往来单位','含税金额'],[cells([info.invoice?'是':'否',doc.partnerName,money(doc.total)])]),
    related:relationRows.length?detailTable(['关系','单据编号','单据类型','日期','状态'],relationRows.map(row=>
      '<tr data-row="report-document" data-id="'+row.id+'" tabindex="0" title="双击打开原单">'+
      [row.id===info.reference?'来源单据':'后续单据',row.number,families[row.type][0],row.date,statusOf(row)].map(value=>'<td>'+e(value)+'</td>').join('')+'</tr>')):
      empty('暂无关联单据'),
    attachments:doc.attachments.length?'<div class="toolbar">'+doc.attachments.map(f=>'<a class="btn" data-act="download-file" href="/api/attachments/'+f.id+'">'+e(f.name)+'</a>').join('')+'</div>':empty('暂无附件'),
    record:detailTable(['制单人' ,'经手人','部门','录单时间','日期','附加说明'],[cells([doc.creatorName,info.handler,doc.department,doc.created,doc.date,info.note])])
  };
  panel.innerHTML='<div class="section-head"><h3>'+e(doc.number)+' <span class="badge" data-state="'+doc.status+'">'+e(statusOf(doc))+'</span></h3></div>'+
    (viewing?detailTable(['单据类型','单据日期','往来单位','仓库','含税金额','摘要'],[cells([families[doc.type][0],doc.date,doc.partnerName,doc.warehouseName,money(doc.total),info.summary])])+pager:'')+
    '<div class="toolbar">'+toolbar+'</div><div class="toolbar">'+tabs.map(([v,l])=>btn(l,'detail-tab',v,v===tab?'primary':'')).join('')+'</div>'+components[tab];
}
async function changeStatus(action) {
  const page=pageState();
  if (!page.detail) return;
  const {id,number,execution}=page.detail;
  const message=execution&&action==='settle'?'确认终止订单 '+number+' 的剩余数量？':'确认'+actions[action]+' '+number+'？';
  if (['delete','post','settle','reject','unapprove'].includes(action)&&!(await confirmAction(message))) return;
  const button=Array.from(document.querySelectorAll('#detail-area button')).find(b=>b.dataset.value===action);
  if (button) button.disabled=true;
  const route=state.active;
  try {
    await api('/api/documents/'+id,{action});
    showSystemPrompt('已'+actions[action]);
    for (const tab of state.tabs.filter(tab=>routes[tab]?.kind==='docs'||routes[tab]?.kind==='report')) pageState(tab).result=null;
    if (tabRoute(route)?.kind!=='document-view') await loadPage(route);
    if (state.active===route) await documentDetails(id);
  } finally {if (button) button.disabled=false;}
}
function print(title,html) {
  document.querySelector('.print-only')?.remove();
  const sheet=document.createElement('section');
  sheet.className='print-only';
  sheet.innerHTML='<h1>'+e(title)+'</h1>'+html;
  document.body.append(sheet);
  window.print();
}
function printBarcodes(items) {
  const labels=items.filter(item=>item.value).map(item=>{
    const widths=code39(item.value);
    const bars=widths?'<div aria-hidden="true" class="barcode-band">'+widths.map(w=>'<i style="width:'+w+'px"></i>').join('')+'</div>':'';
    return '<figure class="barcode-label"><figcaption>'+e(item.name)+'</figcaption>'+bars+'<span class="barcode-value">'+e(item.value)+'</span>'+(widths?'':'<p class="note">此条码仅打印字符</p>')+'</figure>';
  });
  if (!labels.length) return showSystemPrompt('没有可打印的商品条码');
  print('商品条码','<div class="barcode-sheet">'+labels.join('')+'</div>');
}
async function printDocument(doc,mode='document') {
  const {template}=await api('/api/documents/'+doc.id+'/print-template');
  const pools=await catalog();
  if (mode==='logistics') {
    return print('物流单',table(['单据编号','物流公司','物流单号','收货信息','寄件信息'],[cells([doc.number,pools.carriers.find(c=>c.id===Number(doc.data.carrier))?.name,doc.data.tracking,[doc.data.deliveryName,doc.data.deliveryPhone,doc.data.deliveryAddress].filter(Boolean).join(' ')||doc.data.address,doc.data.sender])]));
  }
  if (mode==='barcodes') {
    return printBarcodes(doc.lines.map(l=>({name:l.productName,value:pools.products.find(p=>p.id===l.product)?.data.barcode})));
  }
  const label=families[doc.type][0];
  const heading=(template?.logoText?'<p>'+e(template.logoText)+'</p>':'')+'<p>'+e(doc.number)+'　'+e(doc.date)+'</p><p>往来单位　'+e(doc.partnerName||'—')+'　　仓库　'+e(doc.warehouseName||'—')+'</p>';
  const lineTable=doc.lines.some(l=>l.product)?table(['商品编号','商品名称','数量','单位',doc.data.taxInclusive?'含税单价':'不含税单价','税额','含税金额'],doc.lines.map(l=>cells([l.productCode,l.productName,(l.data.enteredQuantity??l.quantity)/1000,l.data.unit,unitPrice(l).toFixed(doc.data.precision?.priceDigits??2),money(l.tax),money(l.net+l.tax)]))):
    doc.lines.length?table(['科目','借方','贷方'],doc.lines.map(l=>cells([pools.ledgerAccounts.find(a=>a.id===l.data.ledgerAccount)?.name,money(l.data.debit),money(l.data.credit)]))):'';
  print(template?.title||label,heading+lineTable+'<p>合计　¥ '+money(doc.total)+'</p><p>'+e(template?.footer||'')+'</p>');
}
function excelUpload(file,maxBytes=1_000_000) {
  if (!file||!file.name.toLowerCase().endsWith('.xlsx')) throw Error('请选择 Excel 文件（.xlsx）');
  if (!file.size||file.size>maxBytes) throw Error('Excel 文件须大于 0 字节且不超过 '+(maxBytes/1000)+' KB');
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);
    reader.onerror=()=>reject(Error('无法读取 Excel 文件'));
    reader.readAsDataURL(file);
  });
}
function openImport(mode) {
  state.editor={kind:'import',mode,dirty:false};
  modal('导入商品 Excel','<form novalidate id="import-form">'+field('Excel 文件','<input name="file" type="file" accept=".xlsx" required>',true)+'<p class="note">读取第一个工作表。表头包含商品编号，新增商品还需商品名称。可用导出的 Excel 商品列表作模板。</p></form>',btn('导入','import-save','','primary'),true);
}
async function saveImport() {
  const form=dialog.querySelector('#import-form');
  if (!validateForm(form)||state.editor.busy) return;
  const editor=state.editor;
  editor.busy=true;
  try {
    const file=form.elements.file.files[0];
    const result=await api('/api/products/import',{mode:editor.mode,workbook:await excelUpload(file)});
    catalogData=null;
    pageState().categories=null;
    dismiss(true);
    showSystemPrompt('已导入 '+result.count+' 条商品记录');
    await loadPage();
  } catch (error) {showError(error);}
  finally {editor.busy=false;}
}
async function showStatement() {
  const pools=await catalog();
  const params=pageState().params;
  state.editor={kind:'statement',dirty:false};
  modal('生成对账链接','<form novalidate id="statement-form"><div class="form-grid">'+
    field('往来单位',select('partner',rowsToOptions(pools.partners),'','required'),true,'span2')+
    field('开始日期',input('from',params.from,'type="date"'))+field('结束日期',input('to',params.to||currentDate(),'type="date"'))+
    '</div><p class="note">链接保留当前对账流水，有效期 7 天。收到链接的人可以查看该对账单。</p></form>',
    btn('生成链接','statement-save','','primary'),true);
}
async function saveStatement() {
  const editor=state.editor;
  const form=dialog.querySelector('#statement-form');
  if (!validateForm(form)||editor.busy) return;
  editor.busy=true;
  try {
    const response=await api('/api/statements',read(form));
    const link=location.origin+response.path;
    state.editor=null;
    modal('对账链接已生成',field('对账链接',input('statementLink',link,'readonly'))+
      '<p class="note">如需从其他设备打开，应用须通过对方可访问的地址运行。</p>',
      '<a class="btn" href="'+e(response.path)+'" target="_blank" rel="noreferrer">预览对账单</a>'+btn('复制链接','statement-copy','','primary'),true);
  } catch (error) {showError(error);}
  finally {editor.busy=false;}
}
async function showCloseMonth() {
  if (!(await api('/api/system-settings')).manualClose) return showSystemPrompt('请先在系统配置中启用手工月结存。');
  state.editor={kind:'close',dirty:false};
  modal('月结存','<form novalidate id="close-form">'+field('结存月份',input('month','','required type="month"'),true)+'<p class="note">结存后禁止修改本月及之前期间。尚未记账的单据需要先处理。</p></form>',btn('确认月结','close-month-save','','primary'),true);
}
async function saveCloseMonth() {
  const form=dialog.querySelector('#close-form');
  if (!validateForm(form)||state.editor.busy) return;
  const editor=state.editor;
  const month=form.elements.month.value;
  if (!(await confirmAction('确认结存 '+month+' 及之前期间？'))) return;
  editor.busy=true;
  try {
    await api('/api/close',{month});
    dismiss(true);showSystemPrompt(month+' 已结存');
    for (const tab of state.tabs.filter(tab=>routes[tab]?.kind==='report')) pageState(tab).result=null;
    await loadPage();
  } catch (error) {showError(error);}
  finally {editor.busy=false;}
}
function openPartnerImport() {
  state.editor={kind:'partnerImport',dirty:false,busy:false};
  modal('导入往来单位','<form novalidate id="partner-import-form">'+
    field('Excel 文件','<input type="file" name="file" accept=".xlsx" required>',true)+
    '<p class="note">第一个工作表至少包含单位编号、单位名称和类型。类型填写「客户」「供应商」或「客户和供应商」。</p></form>',
    btn('导入','partner-import-save','','primary'),true);
}
async function savePartnerImport() {
  const form=dialog.querySelector('#partner-import-form');
  const editor=state.editor;
  if (editor.busy||!validateForm(form)) return;
  editor.busy=true;
  try {
    const file=form.elements.file.files[0];
    const result=await api('/api/partners/import',{workbook:await excelUpload(file)});
    catalogData=null;
    pageState().categories=null;
    dismiss(true);
    showSystemPrompt('已导入 '+result.count+' 条往来单位');
    await loadPage();
  } catch (error) {showError(error);}
  finally {editor.busy=false;}
}
function submitQuery(extra={}) {
  const node=document.querySelector('#filters-form');
  const data=pageState();
  data.params={...data.params,...(node?read(node):{}),...extra,page:1};
  return loadPage();
}
async function downloadFile(_value,link) {
  let response;
  try {response=await fetch(link.href);}
  catch {throw Error('无法下载文件，请检查网络后重试。');}
  if (!response.ok) {
    const data=await response.json().catch(()=>null);
    throw Error(data?.error||'文件下载失败，请重试。');
  }
  const disposition=response.headers.get('Content-Disposition')||'';
  const encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const filename=encoded?decodeURIComponent(encoded):disposition.match(/filename="([^"]+)"/i)?.[1];
  const url=URL.createObjectURL(await response.blob());
  try {
    const download=document.createElement('a');
    download.href=url;
    download.download=filename||'下载文件';
    download.click();
  } finally {setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
async function masterRecordAction(value) {
  const kind=routes[state.active]?.key;
  if (!kind||!canMaintain(kind)) return;
  const [action,id]=value.split(':');
  const page=pageState();
  const record=page.result?.rows.find(row=>row.id===Number(id));
  const editor=dialog.open?state.editor:null;
  if (!record||page.recordAction||editor?.busy) return;
  const deleting=action==='delete';
  const active=action==='enable'?1:0;
  const label=deleting?'删除':active?'启用':'停用';
  page.recordAction=true;
  if (editor) editor.busy=true;
  try {
    const message='确定'+label+'「'+record.name+'」？'+(editor?.dirty?'未保存的修改将被放弃。':'');
    if (!await showSystemPrompt(message,{cancelLabel:'取消',confirmLabel:label})) return;
    await api('/api/master/'+kind+'/'+id+'/'+(deleting?'delete':'status'),deleting?{}:{active});
    catalogData=null;
    if (editor&&state.editor===editor) dismiss(true);
    if (routes[state.active]?.key===kind) {
      if (page.result?.rows.length===1&&page.params.page>1&&(deleting||page.params.active==='0'||page.params.active==='1')) page.params.page--;
      await loadPage();
    }
    void showSystemPrompt('已'+label+'「'+record.name+'」。');
  } finally {
    page.recordAction=false;
    if (editor) editor.busy=false;
  }
}

const bulkDocumentActions=['submit','approve','unapprove','post','delete'];

function updateDocumentSelection(main) {
  const selected=main.querySelectorAll('input[name=documentSelection]:checked').length;
  const all=main.querySelectorAll('input[name=documentSelection]').length;
  const selectPage=main.querySelector('input[name=documentSelectPage]');
  if (selectPage) {
    selectPage.checked=all>0&&selected===all;
    selectPage.indeterminate=selected>0&&selected<all;
  }
  const count=main.querySelector('[data-selection-count]');
  if (count) count.textContent='已选 '+selected+' 张';
}

document.addEventListener('change',event=>{
  const input=event.target;
  if (!['documentSelectPage','documentSelection'].includes(input.name)) return;
  const main=input.closest('#page-main');
  if (!main) return;
  if (input.name==='documentSelectPage') {
    for (const row of main.querySelectorAll('input[name=documentSelection]')) row.checked=input.checked;
  }
  updateDocumentSelection(main);
});

async function bulkDocumentAction(action,button) {
  const origin=state.active;
  const ids=[...document.querySelectorAll('#page-main input[name=documentSelection]:checked')].map(control=>Number(control.value));
  if (!ids.length) return showSystemPrompt('请勾选要操作的单据。');
  const records=new Map((pageState().result?.rows||[]).map(row=>[row.id,row]));
  const invalid=ids.map(id=>records.get(id)).find(row=>row&&
    (!(transitions[row.status]||[]).includes(action)||!allow('d:'+row.type,action)));
  const label=actions[action];
  if (invalid) return showSystemPrompt('单据 '+invalid.number+' 当前无法'+label+'，请调整所选单据。');
  if (!await confirmAction('确定'+label+'选中的 '+ids.length+' 张单据？')) return;
  button.disabled=true;
  try {
    const {count}=await api('/api/documents/bulk-action',{ids,action});
    for (const id of state.tabs.filter(id=>['docs','report'].includes(routes[id]?.kind))) pageState(id).result=null;
    if (state.active===origin) await loadPage(origin);
    void showSystemPrompt('已'+label+' '+count+' 张单据。');
  } finally {button.disabled=false;}
}
const handlers={
  'documents-bulk-action':bulkDocumentAction,
  'document-open-original':id=>openDocumentView(Number(id)),
  'master-record-action':masterRecordAction,
  'download-file':downloadFile,
  open:openRoute,
  group(group) {
    if (state.folded||window.innerWidth<=850) return openRoute('g:'+group);
    state.group=state.group===group?'':group;
    return mount();
  },
  fold() {state.folded=!state.folded;return mount();},
  flow(flow) {state.flow=flow;document.querySelector('#content').innerHTML=home();},
  notice() {modal('消息通知','<p class="note">可在单据审核中心查看待审核及待记账单据。</p>',go('l:pending','打开单据审核中心'),true);},
  support(label) {
    const copy={在线咨询:'业务操作问题可联系本单位的进销存管理员。',专属客服:'请联系本单位系统管理员获取支持。',需求反馈:'请将使用场景和预期行为记录后交给系统管理员。',组件下载:'CSV 导入导出和浏览器打印可直接在各模块使用。'};
    modal(label,'<p class="note">'+e(copy[label])+'</p>','',true);
  },
  'close-tab':closeTab,
  async logout() {
    await api('/api/logout',{});
    state.user=null;catalogData=null;state.pages.clear();showLogin();
  },
  query() {return submitQuery();},
  date(value) {
    const form=document.querySelector('#filters-form');
    const from=new Date();
    if (value==='three') from.setDate(from.getDate()-2);
    form.elements.from.value=from.toLocaleDateString('sv-SE');
    form.elements.to.value=currentDate();
    return submitQuery();
  },
  'expand-units'() {
    const page=pageState();page.expandUnits=!page.expandUnits;renderPage(routes[state.active],page);
  },
  'unit-add'() {
    const table=dialog.querySelector('.unit-table tbody');
    if (table.rows.length>=20) return showError(Error('最多设置 20 个换算单位'));
    table.insertAdjacentHTML('beforeend',unitRow());
    table.lastElementChild.querySelector('input').focus();
    state.editor.dirty=true;
  },
  'unit-remove'(_,control) {
    const form=control.closest('form');
    control.closest('tr').remove();
    refreshUnitDefaults(form);
    state.editor.dirty=true;
  },
  'product-category-picker':openProductCategoryPicker,
  'category-edit':editCategory,
  'category-save'() {
    const form=dialog.querySelector('#category-form');
    if (validateForm(form)) return changeProductCategory(state.editor.action,read(form));
  },
  async 'category-delete'(path) {
    if (await confirmAction('删除分类「'+path+'」？')) return changeProductCategory('delete',{path});
  },
  'category-toggle'(path) {
    const page=pageState();
    if (page.collapsedCategories.has(path)) page.collapsedCategories.delete(path);
    else page.collapsedCategories.add(path);
    renderCategoryTree(page);
  },
  category(category) {
    const pending=submitQuery({category:category==='∕'?'':category,uncategorized:category==='∕'?'1':''});
    renderFilters(routes[state.active],pageState());
    return pending;
  },
  page(value) {
    pageState().params.page=Math.max(1,(pageState().params.page||1)+Number(value));
    return loadPage();
  },
  'report-mode'(mode) {return submitQuery({mode});},
  'report-view'(view) {
    const page=pageState();
    page.params.view=view;
    if (!page.requested) return renderPage(routes[state.active],page);
    return submitQuery({view});
  },
  'print-table'() {
    if (!routeAllows(state.active,'print')) return;
    const node=document.querySelector('#page-main table');
    if (!node) return showSystemPrompt('请先查询需要打印的数据');
    print(routes[state.active].label,node.outerHTML);
  },
  'permission-add-staff':()=>editMaster(),
  'master-edit':id=>editMaster(id),
  'partner-new':type=>editMaster(null,false,type),
  'partner-import':openPartnerImport,
  'partner-import-save':savePartnerImport,
  'master-copy':id=>editMaster(id,true),
  'print-products'() {
    if (!allow('m:products','print')) return;
    const rows=pageState().result?.rows||[];
    return printBarcodes(rows.map(row=>({name:row.name,value:row.data.barcode})));
  },
  'master-save':value=>saveMasterForm(value==='again'),
  import:openImport,'import-save':saveImport,
  dismiss:()=>dismiss(),
  'doc-details':id=>tabRoute(state.active).kind==='document-view'?openDocumentView(id):documentDetails(id),
  'document-neighbor':id=>openDocumentView(id,pageState().neighbors),
  'detail-tab':updateDetails,
  transition:changeStatus,
  'doc-edit':id=>editDocument(pageState().detail.type,id),
  derive:id=>editDocument(copyFrom[pageState().detail.type],null,id),
  'derive-return'(value) {
    const [type,id]=value.split('|');
    return editDocument(type,null,id);
  },
  'doc-footer-tab'(tab) {
    stashDocument();state.editor.footerTab=tab;renderDocument();
  },
  'settings-save':saveDocumentSettings,
  'settings-type':switchSettingsType,
  'settings-section'(section) {
    if (settingsPanel.saving||settingsPanel.copying||section===settingsPanel.section) return;
    stashSettingsSection();
    settingsPanel.section=section;
    renderDocumentSettings();
  },
  'settings-reset'() {
    if (settingsPanel.saving) return;
    settingsPanel.data.fields={};
    settingsPanel.dirty=true;
    renderDocumentSettings();
    showSystemPrompt('已恢复默认配置，保存后生效');
  },
  'settings-copy'() {
    if (settingsPanel.saving) return;
    stashSettingsSection();
    settingsPanel.copying=true;
    renderDocumentSettings();
  },
  'settings-back'() {
    if (settingsPanel.saving) return;
    settingsPanel.copying=false;
    renderDocumentSettings();
  },
  'doc-tab'(tab) {
    stashDocument();
    if (tab==='defaults'||tab==='fields') return openDocumentSettings(tab);
    state.editor.tab=tab;renderDocument();
  },
  'doc-save':saveDocumentForm,
  'print-doc':async id=>printDocument(await api('/api/documents/'+id)),
  'print-logistics':async id=>printDocument(await api('/api/documents/'+id),'logistics'),
  'print-barcodes':async id=>printDocument(await api('/api/documents/'+id),'barcodes'),
  'line-add'(value) {
    stashDocument();
    const editor=state.editor;
    if (editor.lines.length>=maxDocumentLines) return showError(Error('单据明细最多 500 行'));
    const index=value===''?editor.lines.length-1:Math.min(Number(value)+1,editor.lines.length-1);
    editor.lines.splice(index,0,editor.lineDefaults());
    renderDocument();
    documentEditor.querySelector('[data-value^="line.'+index+'."][data-act="doc-picker"]')?.focus();
  },
  'line-remove'(value) {
    stashDocument();state.editor.lines.splice(Number(value),1);state.editor.dirty=true;renderDocument();
  },
  'parse-address'() {
    stashDocument();
    const editor=state.editor;
    const text=editor.fields.address||'';
    const match=text.match(/(?:\+?86[ -]?)?1[3-9]\d{9}|0\d{2,3}-\d{7,8}/);
    if (!match) return showError(Error('未识别到电话号码，请手动填写收货信息'));
    editor.fields.deliveryName=text.slice(0,match.index).replace(/^(收货人|联系人)[：:\s]*/,'').trim();
    editor.fields.deliveryPhone=match[0];
    editor.fields.deliveryAddress=text.slice(match.index+match[0].length).replace(/^[，,；;：:\s]*((收货)?地址[：:\s]*)?/,'').trim();
    editor.dirty=true;
    renderDocument();
  },
  async 'save-address'() {
    stashDocument();
    const data=state.editor.fields;
    if (!data.partner||!data.deliveryAddress) return showError(Error('请选择购买单位并填写收货地址'));
    await api('/api/partners/'+data.partner+'/shipping',{contact:data.deliveryName,phone:data.deliveryPhone,address:data.deliveryAddress});
    catalogData=null;
    showSystemPrompt('客户收货资料已保存');
  },
  scan:scanLine,
  'sale-extra'(group) {
    stashDocument();
    const editor=state.editor;
    if (editor.fields[group].length>=30) return showError(Error('最多 30 行'));
    editor.fields[group].push({});
    editor.dirty=true;renderDocument();
  },
  'sale-extra-remove'(value) {
    stashDocument();
    const [group,index]=value.split('|');
    state.editor.fields[group].splice(Number(index),1);
    state.editor.dirty=true;renderDocument();
  },
  'attachment-add':()=>documentEditor.querySelector('#attachment-files')?.click(),
  'attachment-remove'(value) {
    stashDocument();
    if (value.startsWith('new:')) state.editor.files.splice(Number(value.slice(4)),1);
    else state.editor.removedAttachments.push(Number(value));
    state.editor.dirty=true;renderDocument();
  },
  statement:showStatement,'statement-save':saveStatement,
  async 'statement-copy'() {
    const link=dialog.querySelector('[name=statementLink]');
    try {await navigator.clipboard.writeText(link.value);showSystemPrompt('链接已复制');}
    catch {link.select();showSystemPrompt('请复制已选中的链接');}
  },
  'doc-picker':openDocumentPicker,
  'doc-reference':openReference,
  'close-month':showCloseMonth,'close-month-save':saveCloseMonth
};
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-act]');
  try {
    if (button) {
      event.preventDefault();
      const details=button.closest('details');
      if (details&&!details.matches('.doc-more,.doc-field-tree details')) details.open=false;
      if (dialog.open && button.dataset.act==='open') dismiss(true);
      const {act,value}=button.dataset;
      if (Object.hasOwn(handlers,act)) await handlers[act](value,button);
    } else {
      const row=event.target.closest('[data-row]');
      if (row?.dataset.row==='document'&&!event.target.closest('input[type=checkbox]')) await documentDetails(row.dataset.id);
      if (row?.dataset.row==='master') await editMaster(row.dataset.id);
      if (!event.target.closest('.search')) {
        const results=document.querySelector('#search-results');
        if (results) results.hidden=true;
      }
    }
  } catch (error) {showError(error);}
});
document.addEventListener('submit',event=>{
  if (event.target.id==='category-form') {event.preventDefault();handlers['category-save']();}
  if (event.target.id==='partner-import-form') {event.preventDefault();savePartnerImport();}
  if (event.target.id==='filters-form') {event.preventDefault();submitQuery();}
  if (event.target.id==='import-form') {event.preventDefault();saveImport();}
  if (event.target.id==='statement-form') {event.preventDefault();saveStatement();}
  if (event.target.id==='close-form') {event.preventDefault();saveCloseMonth();}
});
document.addEventListener('dblclick',event=>{
  if (event.target.closest('input,button,a,.column-resizer')) return;
  const row=event.target.closest('tr[data-row="report-document"],tr[data-row="document"]');
  if (row) openDocumentView(Number(row.dataset.id)).catch(showError);
});
document.addEventListener('keydown',event=>{
  if (dialog.open||systemPrompt.open||document.querySelector('#document-picker').open) return;
  const reportRow=event.target.matches?.('tr[data-row="report-document"],tr[data-row="document"]')?event.target:null;
  if (event.key==='Enter'&&reportRow) {
    event.preventDefault();
    openDocumentView(Number(reportRow.dataset.id)).catch(showError);
  }
  if (event.key==='Escape'&&documentEditor.contains(event.target)) {
    event.preventDefault();closeTab(state.active);
  }
  if (event.shiftKey&&event.altKey&&event.code==='KeyX'&&state.editor?.type==='sale') {
    event.preventDefault();saveDocumentForm('print');
  }
});
try {
  const session=await api('/api/me');
  state.user=session.user===null?null:session;
  if (state.user) await mount();
  else showLogin();
} catch {showLogin();}
