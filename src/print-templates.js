import {createHash} from 'node:crypto';
import {families} from '../public/catalog.js';
import {permits} from '../public/permissions.js';
import {defaultPrintTemplate,validatePrintTemplate,paginatePrint,normalizePrintTemplate} from '../public/print-layout.js';
import {storedTradeLine,tradeLineSign} from '../public/system-settings.js';
import {getDocument,check,parse,log} from './engine.js';
import {getSystemSettings} from './system-settings.js';

export function initializePrintTemplates(s) {
  s.db.exec(`CREATE TABLE IF NOT EXISTS print_templates (
    id INTEGER PRIMARY KEY,doc_type TEXT NOT NULL,name TEXT NOT NULL,is_default INTEGER NOT NULL DEFAULT 0,
    paper TEXT NOT NULL,layout_json TEXT NOT NULL,created_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,is_system INTEGER NOT NULL DEFAULT 0,
    UNIQUE(doc_type,name));
    CREATE UNIQUE INDEX IF NOT EXISTS print_default ON print_templates(doc_type) WHERE is_default=1;
    CREATE TABLE IF NOT EXISTS print_assets(id TEXT PRIMARY KEY,mime TEXT NOT NULL,content BLOB NOT NULL,created_by INTEGER REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS print_jobs(id INTEGER PRIMARY KEY,doc INTEGER NOT NULL REFERENCES documents(id),
      template INTEGER REFERENCES print_templates(id) ON DELETE SET NULL,user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,request_id TEXT NOT NULL,UNIQUE(user_id,request_id,doc));`);
  s.tx(()=>{
    for(const type of Object.keys(families)) {
      if(s.one('SELECT id FROM print_templates WHERE doc_type=? LIMIT 1',type))continue;
      const value=defaultPrintTemplate(type);
      const old=s.one("SELECT data FROM master WHERE kind='templates' AND active=1 AND json_extract(data,'$.title')=? ORDER BY code LIMIT 1",families[type][0]);
      if(old) {
        const legacy=parse(old.data);
        if(legacy.logoText){const el=value.layout.elements.find(el=>el.id==='company');el.kind='text';el.text=legacy.logoText;}
        if(legacy.footer)value.layout.elements.push({id:'legacy-footer',band:'footer',kind:'text',text:String(legacy.footer).slice(0,1000),x:0,y:33,w:190,h:6,fontSize:9});
      }
      s.run('INSERT INTO print_templates(doc_type,name,is_default,paper,layout_json,updated_at,is_system) VALUES(?,?,1,?,?,?,1)',
        type,value.name,JSON.stringify(value.paper),JSON.stringify(value.layout),new Date().toISOString());
    }
  });
}
const map=row=>{
  const paper=parse(row.paper);paper.orientation=paper.width>paper.height?'landscape':'portrait';
  const {layout_json,...metadata}=row;
  return normalizePrintTemplate({...metadata,version:row.revision,paper,layout:parse(layout_json),is_default:!!row.is_default,is_system:!!row.is_system});
};
const designer=user=>check(permits(user,'m:templates','design'),'没有打印模板设计权限',403);
export function listPrintTemplates(s,user,type) {
  check(!type||Object.hasOwn(families,type),'未知单据类型');
  return s.all('SELECT * FROM print_templates'+(type?' WHERE doc_type=?':'')+' ORDER BY doc_type,is_default DESC,id',...(type?[type]:[]))
    .filter(row=>permits(user,'m:templates','design')||permits(user,'d:'+row.doc_type,'print')).map(map);
}
export function getPrintTemplate(s,user,id,type) {
  const row=id?s.one('SELECT * FROM print_templates WHERE id=?',Number(id)):s.one('SELECT * FROM print_templates WHERE doc_type=? AND is_default=1',type);
  check(row&&(!type||row.doc_type===type),'打印模板不存在或单据类型不匹配',404);
  check(permits(user,'m:templates','design')||permits(user,'d:'+row.doc_type,'print'),'没有模板访问权限',403);
  return map(row);
}
function validateAssets(s,value) {
  const ids=[value.layout.background,...value.layout.elements.map(el=>el.asset)].filter(Boolean);
  let size=0;
  for(const id of new Set(ids)) {
    const asset=s.one('SELECT length(content) size FROM print_assets WHERE id=?',id);
    check(asset,'模板引用的图片不存在，请连同图片导入');size+=asset.size;
  }
  check(size<=6_000_000,'模板图片合计不能超过 6 MB');
}
export function savePrintTemplate(s,user,input) {
  designer(user);
  let value;
  try {value=validatePrintTemplate(normalizePrintTemplate(input));}catch(error){check(false,error.message);}
  return s.tx(()=>{
    const current=input.id?s.one('SELECT * FROM print_templates WHERE id=?',Number(input.id)):null;
    check(!input.id||current,'模板不存在',404);
    if(current) {
      if((input.revision??input.version)!==current.revision)throw Object.assign(Error('模板已被其他人修改，请刷新后重试'),{status:409,code:'TEMPLATE_VERSION_CONFLICT',field:'revision'});
      check(current.doc_type===value.doc_type,'不能更改单据类型');
      check(!current.is_default||value.is_default,'请先将其他模板设为默认',409);
    }
    if(s.one('SELECT id FROM print_templates WHERE doc_type=? AND name=? AND id<>?',value.doc_type,value.name.trim(),current?.id||0))
      throw Object.assign(Error('同类单据的模板名称已存在'),{status:409,code:'TEMPLATE_NAME_CONFLICT',field:'name'});
    validateAssets(s,value);
    if(current){const previous=map(current);if(previous.name===value.name.trim()&&previous.is_default===value.is_default&&JSON.stringify(previous.paper)===JSON.stringify(value.paper)&&JSON.stringify(previous.layout)===JSON.stringify(value.layout))return previous;}
    if(value.is_default)s.run('UPDATE print_templates SET is_default=0,revision=revision+1 WHERE doc_type=? AND is_default=1 AND id<>?',value.doc_type,current?.id||0);
    const now=new Date().toISOString();
    let id=current?.id;
    if(current)s.run('UPDATE print_templates SET name=?,is_default=?,paper=?,layout_json=?,updated_at=?,revision=revision+1 WHERE id=?',
      value.name.trim(),value.is_default?1:0,JSON.stringify(value.paper),JSON.stringify(value.layout),now,id);
    else id=Number(s.run('INSERT INTO print_templates(doc_type,name,is_default,paper,layout_json,created_by,updated_at) VALUES(?,?,?,?,?,?,?)',
      value.doc_type,value.name.trim(),value.is_default?1:0,JSON.stringify(value.paper),JSON.stringify(value.layout),user.id,now).lastInsertRowid);
    log(s,user,'保存打印模板',value.doc_type+' '+value.name);
    return getPrintTemplate(s,user,id);
  });
}
export function changePrintTemplate(s,user,id,input) {
  designer(user);
  if(input.action==='copy') {
    const value=getPrintTemplate(s,user,id);
    return savePrintTemplate(s,user,{...value,id:undefined,name:input.name||value.name+' 副本',is_default:false});
  }
  return s.tx(()=>{
    const row=s.one('SELECT * FROM print_templates WHERE id=?',Number(id));
    check(row,'模板不存在',404);
    check(input.revision===row.revision,'模板已变更，请刷新',409);
    if(input.action==='delete') {
      check(!row.is_default,'默认模板不能删除，请先设置其他默认模板',409);
      s.run('DELETE FROM print_templates WHERE id=?',row.id);
    } else if(input.action==='default') {
      s.run('UPDATE print_templates SET is_default=0,revision=revision+1 WHERE doc_type=? AND is_default=1',row.doc_type);
      s.run('UPDATE print_templates SET is_default=1,revision=revision+1 WHERE id=?',row.id);
    } else if(input.action==='restore') {
      const value=defaultPrintTemplate(row.doc_type);
      s.run('UPDATE print_templates SET paper=?,layout_json=?,revision=revision+1,updated_at=? WHERE id=?',
        JSON.stringify(value.paper),JSON.stringify(value.layout),new Date().toISOString(),row.id);
    } else check(false,'不支持此模板操作');
    log(s,user,'打印模板'+input.action,row.name);
    return input.action==='delete'?{deleted:true}:getPrintTemplate(s,user,row.id);
  });
}
export function savePrintAsset(s,user,input) {
  designer(user);
  const bytes=Buffer.from(input.content||'','base64');
  const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':
    bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':
    bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
  check(mime&&bytes.length<=1_000_000,'请上传不超过 1 MB 的 PNG、JPEG 或 WebP 图片');
  const id=createHash('sha256').update(bytes).digest('hex');
  s.run('INSERT OR IGNORE INTO print_assets VALUES(?,?,?,?)',id,mime,bytes,user.id);
  return {id,mime};
}
export function exportPrintTemplate(s,user,id) {
  designer(user);
  const value=getPrintTemplate(s,user,id);
  const ids=[...new Set([value.layout.background,...value.layout.elements.map(el=>el.asset)].filter(Boolean))];
  return {format:'hengxu-print-template',version:1,template:{doc_type:value.doc_type,name:value.name,is_default:value.is_default,paper:value.paper,layout:value.layout},
    assets:ids.map(id=>{const row=s.one('SELECT * FROM print_assets WHERE id=?',id);return {id,mime:row.mime,content:Buffer.from(row.content).toString('base64')};})};
}
export function importPrintTemplate(s,user,input) {
  designer(user);
  check(input.format==='hengxu-print-template'&&input.version===1&&Array.isArray(input.assets)&&input.assets.length<=100,'模板 JSON 格式或版本无效');
  return s.tx(()=>{
    for(const asset of input.assets)check(savePrintAsset(s,user,asset).id===asset.id,'模板图片校验失败');
    return savePrintTemplateWithin(s,user,input.template,input.replace===true);
  });
}
function savePrintTemplateWithin(s,user,value,replace) {
  value=normalizePrintTemplate(value);
  // Save uses a transaction; SQLite savepoints preserve the outer JSON import transaction.
  s.db.exec('SAVEPOINT template_import');
  try {
    let checked;
    try {checked=validatePrintTemplate(value);}catch(error){check(false,error.message);}
    validateAssets(s,checked);
    const current=s.one('SELECT * FROM print_templates WHERE doc_type=? AND name=?',value.doc_type,value.name);
    if(current&&!replace) {
      const existing=map(current);
      check(JSON.stringify(existing.paper)===JSON.stringify(value.paper)&&JSON.stringify(existing.layout)===JSON.stringify(value.layout)&&existing.is_default===!!value.is_default,
        '同名模板已存在，请确认覆盖后重新导入',409);
      s.db.exec('RELEASE template_import');return existing;
    }
    check(!current?.is_default||value.is_default,'请先更换默认模板后再覆盖',409);
    if(value.is_default)s.run('UPDATE print_templates SET is_default=0,revision=revision+1 WHERE doc_type=? AND is_default=1 AND id<>?',value.doc_type,current?.id||0);
    let id=current?.id;
    if(current)s.run('UPDATE print_templates SET is_default=?,paper=?,layout_json=?,revision=revision+1,updated_at=? WHERE id=?',
      value.is_default?1:0,JSON.stringify(value.paper),JSON.stringify(value.layout),new Date().toISOString(),id);
    else id=Number(s.run('INSERT INTO print_templates(doc_type,name,is_default,paper,layout_json,created_by,updated_at) VALUES(?,?,?,?,?,?,?)',
      value.doc_type,value.name,value.is_default?1:0,JSON.stringify(value.paper),JSON.stringify(value.layout),user.id,new Date().toISOString()).lastInsertRowid);
    s.db.exec('RELEASE template_import');log(s,user,'导入打印模板',value.name);
    return getPrintTemplate(s,user,id);
  } catch(error){s.db.exec('ROLLBACK TO template_import');s.db.exec('RELEASE template_import');throw error;}
}
export function printDocumentData(s,user,id) {
  const doc=getDocument(s,user,id,true);
  check(permits(user,'d:'+doc.type,'print'),'没有单据打印权限',403);
  const company=getSystemSettings(s),partner=doc.partner?s.one('SELECT data FROM master WHERE id=?',doc.partner):null;
  const party=partner?parse(partner.data):{},lines=doc.lines.map((line,index)=>{
    const product=line.product?s.one('SELECT data FROM master WHERE id=?',line.product):null;
    const item=product?parse(product.data):{},v=storedTradeLine(line,doc.data);
    return {index:index+1,totalSign:tradeLineSign(doc.type,line.data),code:line.productCode||'',name:line.productName||'',spec:item.spec||'',model:item.model||'',
      barcode:line.data.barcode||item.barcode||'',unit:line.data.unit||item.unit||'',quantity:v.quantity,unitPrice:v.unit,
      baseAmount:v.baseAmount/100,discount:v.discount,discountedUnit:v.discountedUnit,net:line.net/100,
      rate:v.rate,tax:line.tax/100,grossUnit:v.grossUnit,gross:(line.net+line.tax)/100,batch:line.data.batch||'',
      production:line.data.production||'',note:line.data.note||'',debit:(line.data.debit||0)/100,credit:(line.data.credit||0)/100,
      ledgerAccount:line.data.ledgerAccount?s.one('SELECT name FROM master WHERE id=?',line.data.ledgerAccount)?.name||'':''};
  });
  if(!lines.length)lines.push({index:1,name:families[doc.type][0],gross:doc.total/100,note:doc.data.summary||''});
  const count=s.one('SELECT COUNT(*) count FROM print_jobs WHERE doc=?',doc.id).count;
  const balance=doc.partner?s.one("SELECT COALESCE(SUM(amount),0) amount FROM ledger WHERE entity=? AND category=?",doc.partner,
    families[doc.type][3]==='supplier'?'ap':'ar').amount:0;
  const paid=(doc.data.paid||0)+(doc.data.receipts||[]).reduce((sum,row)=>sum+row.amount,0);
  const fields={companyName:company.companyName||'公司名称',companyAddress:company.companyAddress||'',companyPhone:company.companyPhone||'',
    documentName:families[doc.type][0],number:doc.number,date:doc.date,partner:doc.partnerName||'',contact:party.contact||'',phone:party.phone||'',
    address:party.companyAddress||party.address||'',warehouse:doc.warehouseName||'',handler:doc.data.handler||'',department:doc.department,
    summary:doc.data.summary||'',note:doc.data.note||'',creator:doc.creatorName||'',reviewer:doc.history?.find(row=>row.action==='approve')?.operator||'',
    printCount:count,reprint:count?'重打':'',reduction:(doc.data.reduction||0)/100,freight:(doc.data.freight||0)/100,total:doc.total/100,
    paid:(doc.recordedSettlement??paid)/100,outstanding:doc.tradeAmounts?.outstanding!=null?doc.tradeAmounts.outstanding/100:doc.unpaid!=null?doc.unpaid/100:'',
    balance:balance/100,account:doc.data.account?s.one('SELECT name FROM master WHERE id=?',doc.data.account)?.name||'':'',
    printTime:new Date().toLocaleString('sv-SE',{timeZone:process.env.ERP_TIMEZONE||'America/New_York'})};
  for(const key of ['quantity','baseAmount','net','tax','gross']){
    const scale=key==='quantity'?10000:100;
    fields[key]=lines.reduce((sum,row)=>sum+Math.round(Number(row[key]||0)*scale)*(row.totalSign??1),0)/scale;
  }
  fields.uppercase='';
  return {id:doc.id,type:doc.type,status:doc.status,fields,lines};
}
export function preparePrint(s,user,{ids,templateId,templates={}},{enforce=true}={}) {
  check(Array.isArray(ids)&&ids.length>0&&ids.length<=100&&ids.every(Number.isSafeInteger)&&new Set(ids).size===ids.length,'请选择 1–100 张不同单据');
  return ids.map(id=>{
    const data=printDocumentData(s,user,id),template=getPrintTemplate(s,user,templates[data.type]||templateId,data.type);
    check(!enforce||!template.layout.requireApproved||['approved','posted','settled'].includes(data.status),'未审核单据不允许打印：'+data.fields.number,409);
    check(!enforce||!data.fields.printCount||permits(user,'d:'+data.type,'reprint'),'没有重复打印权限：'+data.fields.number,403);
    return {data,template,pages:paginatePrint(template,data)};
  });
}
export function recordPrint(s,user,input) {
  check(typeof input.requestId==='string'&&/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId),'打印请求编号无效');
  return s.tx(()=>{
    const done=s.all('SELECT doc,template FROM print_jobs WHERE user_id=? AND request_id=?',user.id,input.requestId);
    if(done.length) {
      check(done.length===input.ids?.length&&done.every(row=>{
        const type=s.one('SELECT type FROM documents WHERE id=?',row.doc)?.type;
        const expected=input.templates?.[type]||input.templateId||s.one('SELECT id FROM print_templates WHERE doc_type=? AND is_default=1',type)?.id;
        return input.ids.includes(row.doc)&&row.template===Number(expected);
      }),'打印请求编号已被其他任务使用',409);
      return {recorded:true};
    }
    const values=preparePrint(s,user,input);
    for(const {data,template} of values){
      s.run('INSERT INTO print_jobs(doc,template,user_id,created_at,request_id) VALUES(?,?,?,?,?)',
        data.id,template.id,user.id,new Date().toISOString(),input.requestId);
      log(s,user,'提交单据打印',data.fields.number+' · '+template.name+(data.fields.printCount?' · 重打':''));
    }
    return {recorded:true};
  });
}
