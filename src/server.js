import {initializePrintTemplates,listPrintTemplates,getPrintTemplate,savePrintTemplate,changePrintTemplate,savePrintAsset,exportPrintTemplate,importPrintTemplate,preparePrint,recordPrint} from './print-templates.js';
import {paginatePrint,printFields,evaluatePrintExpression} from '../public/print-layout.js';
import {repairOpeningEquity} from './accounting.js';
import {initializeOpening,openingState,isOpening,assertOpeningEditable} from './opening-state.js';
import {openingData,saveOpening,changeOpening,migrateOpening} from './opening.js';
import { tradeTypes, tradeColumns, tradeLineRow, tradeTotalRow, tradeSettlementRows, costDocumentTypes } from '../public/system-settings.js';
import { dataMaintenance } from './data-maintenance.js';
import { pipeline } from 'node:stream/promises';
import { readWorkbookRows } from './xlsx-import.js';
import { xlsx } from './xlsx.js';
import { permits, documentTypesFor, validatePermissionOverrides } from '../public/permissions.js';
import { getSystemSettings, validSystemSettings, saveSystemSettings } from './system-settings.js';
import { normalizeDefaults, normalizeFieldRules, copyFieldRules } from '../public/document-settings.js';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, seed, validPassword, passwordHash } from './database.js';
import { check, closeMonth, getDocument, getMaster, log, inventoryCost, lookupPrice, number, parse, saveDocument, today, transition, transitionDocuments } from './engine.js';
import { categoryPaths, changeCategory } from './categories.js';
import { csvRows } from '../public/csv.js';
import { listDocuments, report, scope } from './reports.js';
import { families, masters, statusNames, relatedDocuments, submittedSources, orderFulfillment } from '../public/catalog.js';

const digest = token => createHash('sha256').update(token).digest('hex');
const lifetime = 12*60*60*1000;
const files = {
  '/print-editor.js':['print-editor.js','text/javascript; charset=utf-8'],
  '/print-output.js':['print-output.js','text/javascript; charset=utf-8'],
  '/print-layout.js':['print-layout.js','text/javascript; charset=utf-8'],
  '/print-qr.js':['print-qr.js','text/javascript; charset=utf-8'],
  '/print-designer.js':['print-designer.js','text/javascript; charset=utf-8'],
  '/opening.js':['opening.js','text/javascript; charset=utf-8'],
  '/':['index.html','text/html; charset=utf-8'],
  '/app.js':['app.js','text/javascript; charset=utf-8'],
  '/csv.js':['csv.js','text/javascript; charset=utf-8'],
  '/permissions.js':['permissions.js','text/javascript; charset=utf-8'],
  '/system-settings.js':['system-settings.js','text/javascript; charset=utf-8'],
  '/document-settings.js':['document-settings.js','text/javascript; charset=utf-8'],
  '/favicon.ico':['favicon.svg','image/svg+xml'],
  '/favicon.svg':['favicon.svg','image/svg+xml'],
  '/system-prompt.js':['system-prompt.js','text/javascript; charset=utf-8'],
  '/document-picker.js':['document-picker.js','text/javascript; charset=utf-8'],
  '/units.js':['units.js','text/javascript; charset=utf-8'],
  '/barcode.js':['barcode.js','text/javascript; charset=utf-8'],
  '/catalog.js':['catalog.js','text/javascript; charset=utf-8'],
  '/style.css':['style.css','text/css; charset=utf-8']
};
const masterMap = row => ({...row,data:parse(row.data)});
const userView = row => ({id:row.id,username:row.username,name:row.name,role:row.role,department:row.department,warehouses:JSON.parse(row.warehouses),active:row.active,permissions:typeof row.permissions==='string'?parse(row.permissions):row.permissions||{}});
const roles = ['admin','clerk','reviewer','viewer'];
const htmlEscape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function statementHtml({partner,from,to,columns,rows,summary,created}) {
  const grid=({columns,rows})=>'<div class="scroll-table"><table><thead><tr>'+
    columns.map(c=>'<th>'+htmlEscape(c)+'</th>').join('')+'</tr></thead><tbody>'+
    rows.map(row=>'<tr>'+row.map(c=>'<td>'+htmlEscape(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>往来单位对账单</title><link rel="stylesheet" href="/style.css"><main class="content"><section class="card"><div class="section-head"><h1>往来单位对账单</h1></div><div class="toolbar">'+htmlEscape(partner)+'　'+htmlEscape(from||'期初')+' 至 '+htmlEscape(to||created)+'　　生成日期 '+htmlEscape(created)+'</div>'+(summary?grid(summary):'')+grid({columns,rows})+'</section></main></html>';
}
function getUsers(s) {
  return s.all('SELECT id,username,name,role,department,warehouses,active FROM users ORDER BY id').map(userView);
}
function upsertUser(s,actor,data) {
  const username=String(data.username||'').trim();
  const name=String(data.name||'').trim();
  const password=String(data.password||'');
  check(/^[a-zA-Z0-9_.-]{2,32}$/.test(username)&&name&&name.length<=80&&roles.includes(data.role),'请输入有效的用户名、姓名和角色');
  check((data.id&&!password)||(password.length>=12&&password.length<=128),'密码长度为 12–128 字符');
  const warehouses=[...new Set((data.warehouses||[]).map(Number))];
  for (const id of warehouses) getMaster(s,id,'warehouses');
  check(!data.id || Number(data.id)!==actor.id || (data.role==='admin' && data.active!==0),'当前登录管理员不能停用或降级自己的账户');
  if (s.one('SELECT id FROM users WHERE username=? AND id<>?',username,Number(data.id)||0))
    throw Object.assign(new Error('用户名 '+username+' 已存在'),{status:409,code:'DUPLICATE_USERNAME',field:'username'});
  const attrs=[username,name,data.role,String(data.department||'').slice(0,80),JSON.stringify(warehouses),data.active===0?0:1];
  let id=Number(data.id);
  if (data.id) {
    check(s.one('SELECT id FROM users WHERE id=?',Number(data.id)),'职员不存在',404);
    s.run('UPDATE users SET username=?,name=?,role=?,department=?,warehouses=?,active=? WHERE id=?',...attrs,Number(data.id));
    if (password) {
      s.run('UPDATE users SET hash=? WHERE id=?',passwordHash(password),Number(data.id));
      s.run('DELETE FROM sessions WHERE user_id=?',Number(data.id));
    }
  } else {
    id=Number(s.run('INSERT INTO users(username,name,role,department,warehouses,active,hash) VALUES (?,?,?,?,?,?,?)',...attrs,passwordHash(password)).lastInsertRowid);
  }
  log(s,actor,'保存职员',username);
  return id;
}
function saveMaster(s,actor,kind,input) {
  const name=String(input.name||'').trim();
  const code=String(input.code||'').trim();
  check(code && code.length<=64 && name && name.length<=160,'编号和名称为必填项');
  if (s.one('SELECT id FROM master WHERE kind=? AND code=? AND id<>?',kind,code,Number(input.id)||0)) {
    const label={products:'商品',partners:'往来单位',warehouses:'仓库'}[kind]||masters[kind][0];
    throw Object.assign(new Error(label+'编号 '+code+' 已存在'),{status:409,code:'DUPLICATE_CODE',field:'code'});
  }
  const data=input.data||{};
  check(data && typeof data==='object'&&!Array.isArray(data),'无效资料字段');
  const existing = input.id ? s.one('SELECT * FROM master WHERE id=? AND kind=?',Number(input.id),kind) : null;
  check(!input.id || existing,'资料不存在',404);
  if (kind==='products') {
    data.taxRate=number(data.taxRate??0,0,100);
    for (const field of ['retail','purchase','minimum','referenceCost',...Array.from({length:10},(_,i)=>'preset'+(i+1))]) {
      if (data[field]!=='' && data[field]!=null) data[field]=number(data[field]);
    }
    const previousMethod=existing ? parse(existing.data).method||'moving' : null;
    const settings=getSystemSettings(s);
    const method=data.method||previousMethod||(settings.costMethods.includes('moving')?'moving':settings.costMethods[0]);
    check(method===previousMethod||settings.costMethods.includes(method),'请选择已启用的成本算法');
    if (method!==previousMethod && existing && (method==='individual'||previousMethod==='individual')) {
      check(!s.one('SELECT 1 FROM stock WHERE product=? AND (quantity<>0 OR value<>0)',existing.id),'请清空在库数量和金额后再切换个别计价');
    }
    check(method!=='individual'||data.batch,'个别计价商品必须启用批次管理');
    data.method=method;
    check(String(data.note||'').length<=300,'备注最多 300 字');
    if (data.unitRows!==undefined) {
      check(Array.isArray(data.unitRows)&&data.unitRows.length<=20,'最多设置 20 个换算单位');
      data.unit=String(data.unit||'').trim();
      check(!data.unitRows.length||data.unit,'请填写基本单位');
      const names=new Set([data.unit]);
      data.unitRows=data.unitRows.map(row=>{
        check(row&&typeof row==='object'&&!Array.isArray(row),'无效换算单位');
        const name=String(row.name||'').trim();
        check(name&&name.length<=32&&!names.has(name),'单位名称不能为空或重复');
        names.add(name);
        const result={name,factor:number(row.factor,0.001,1e6),barcode:String(row.barcode||'').trim(),sku:String(row.sku||'').trim()};
        for (const key of ['purchase','retail','weight']) if (row[key]!==''&&row[key]!=null) result[key]=number(row[key]);
        return result;
      });
      check(!data.multiUnit||data.unitRows.length,'请至少填写一个换算单位');
      const barcodes=[data.barcode,...data.unitRows.map(row=>row.barcode)].filter(Boolean);
      check(new Set(barcodes).size===barcodes.length,'商品内各单位的条码不能重复');
      for (const key of ['salesUnit','purchaseUnit']) check(!data[key]||names.has(data[key]),'默认单位必须来自已配置的单位');
      delete data.units;
    }
    if (existing) {
      const old=parse(existing.data);
      if ((old.unit||'')!==(data.unit||'')&&data.unitRows!==undefined) {
        check(!s.one('SELECT product FROM stock WHERE product=? AND quantity<>0',existing.id),'有库存时不能更改基本单位');
      }
      if (['batch','serial','type'].some(k=>Boolean(data[k])!==Boolean(old[k]) || k==='type' && (data[k]||'stock')!==(old[k]||'stock'))) {
        check(!s.one('SELECT product FROM stock WHERE product=? AND quantity>0',existing.id),'有库存时不能更改商品类型或批次、序列号管理');
      }
    }
  }
  if (kind==='ledgerAccounts') check(['asset','liability','equity','income','expense'].includes(data.category),'请选择会计分类');
  if (kind==='partners') {
    check(['customer','supplier','both'].includes(data.type),'请选择往来单位类型');
    if (data.priceLevel) {
      data.priceLevel=Number(data.priceLevel);
      check(Number.isInteger(data.priceLevel)&&data.priceLevel>=1&&data.priceLevel<=10,'价格等级须为 1 至 10');
    }
  }
  if (kind==='accounts') check(['cash','bank'].includes(data.type),'请选择账户类型');
  if (['supplierPrices','customerPrices','tiers'].includes(kind)) {
    data.product=getMaster(s,data.product,'products').id;
    data.price=number(data.price);
    if (kind==='tiers') {
      data.minimum=number(data.minimum,0,1e6);
      delete data.partner;
    } else {
      const partner=getMaster(s,data.partner,'partners');
      check([kind==='supplierPrices'?'supplier':'customer','both'].includes(partner.data.type),'往来单位类型不符');
      data.partner=partner.id;
    }
    const duplicate=s.all('SELECT id,data FROM master WHERE kind=? AND active=1',kind).some(row=>{
      const candidate=parse(row.data);
      return row.id!==existing?.id && candidate.product===data.product && (kind==='tiers'?candidate.minimum===data.minimum:candidate.partner===data.partner);
    });
    check(!duplicate,'相同商品的这条价格记录已存在');
  }
  if (kind==='bundles') {
    check(Array.isArray(data.components)&&data.components.length>0,'请输入套餐组成');
    const seen=new Set();
    data.components=data.components.map(c=>{
      const product=getMaster(s,c.product,'products').id;
      check(!seen.has(product),'套餐商品重复');
      seen.add(product);
      return {product,quantity:number(c.quantity,0.001,1e6)};
    });
  }
  if (kind==='ledgerAccounts'&&existing) {
    const prior=parse(existing.data);
    if (openingState(s)?.opened&&s.one("SELECT id FROM ledger WHERE entity=? AND category='journal' LIMIT 1",existing.id))
      check(data.category===prior.category&&code===existing.code,'已开账的期初科目分类和编码不能修改',409);
  }
  const active=input.active===0?0:1;
  if (existing) s.run('UPDATE master SET code=?,name=?,active=?,data=? WHERE id=?',code,name,active,JSON.stringify(data),existing.id);
  else s.run('INSERT INTO master(kind,code,name,active,data) VALUES (?,?,?,?,?)',kind,code,name,active,JSON.stringify(data));
  if (kind==='partners'&&input.openingBalances) {
    const id=existing?.id||s.one("SELECT id FROM master WHERE kind='partners' AND code=?",code).id;
    saveOpening(s,actor,'partners',{revision:input.openingRevision,rows:[{id,...input.openingBalances}]},{withinTransaction:true});
  }
  log(s,actor,'保存资料',masters[kind][0]+' '+code);
}
const productColumns={商品编号:'code',商品名称:'name',分类:'category',单位:'unit',零售价:'retail',采购价:'purchase',条码:'barcode',商家编码:'sku',属性:'attributes',成本算法:'method',预设售价1:'preset1'};
function changeMasterRecord(s,user,kind,id,action,input) {
  check(permits(user,'m:'+kind,'master'),'没有资料维护权限',403);
  if (kind==='warehouses'&&user.role!=='admin') {
    const ids=parse(user.warehouses);
    check(!ids.length||ids.includes(id),'不能维护权限范围外的仓库',403);
  }
  const staff=kind==='users';
  const label=kind==='products'?'商品':staff?'职员':masters[kind][0];
  const deleting=action==='delete';
  const target=staff?'users':'master';
  s.tx(()=>{
    const row=staff?s.one('SELECT username code FROM users WHERE id=?',id):
      s.one('SELECT code FROM master WHERE kind=? AND id=?',kind,id);
    check(row,label+'不存在',404);
    check(!staff||id!==user.id||!deleting&&input.active===1,'不能删除或停用当前登录职员');
    if (deleting) {
      check(!masterUsedInDocument(s,kind,id),'当前资料已在单据中使用，无法删除。可以停用该资料。',409);
      check(!masterInUse(s,kind,id),'该'+label+'已有业务引用。可以停用。',409);
      if (kind==='products') s.run('DELETE FROM stock WHERE product=? AND quantity=0 AND value=0',id);
      if (staff) s.run('DELETE FROM sessions WHERE user_id=?',id);
      try {s.run('DELETE FROM '+target+' WHERE id=?',id);}
      catch (error) {
        if (/FOREIGN KEY constraint/i.test(error.message)) check(false,'该'+label+'已有业务引用。可以停用。',409);
        throw error;
      }
    } else {
      check(input.active===0||input.active===1,'请选择有效的资料状态');
      s.run('UPDATE '+target+' SET active=? WHERE id=?',input.active,id);
      if (staff&&!input.active) s.run('DELETE FROM sessions WHERE user_id=?',id);
    }
    log(s,user,(deleting?'删除':input.active?'启用':'停用')+label,row.code);
  });
}

function masterInUse(s,kind,id) {
  switch (kind) {
    case 'products':
      return s.one(`SELECT 1 FROM movements WHERE product=?
        UNION ALL SELECT 1 FROM stock WHERE product=? AND (quantity<>0 OR value<>0)
        UNION ALL SELECT 1 FROM master WHERE kind IN ('supplierPrices','customerPrices','tiers')
          AND CAST(json_extract(data,'$.product') AS INTEGER)=?
        UNION ALL SELECT 1 FROM master m, json_each(m.data,'$.components') c
          WHERE m.kind='bundles' AND CAST(json_extract(c.value,'$.product') AS INTEGER)=?
        LIMIT 1`,id,id,id,id);
    case 'partners':
      if (s.one(`SELECT 1 FROM master WHERE kind IN ('supplierPrices','customerPrices')
        AND CAST(json_extract(data,'$.partner') AS INTEGER)=?
        UNION ALL SELECT 1 FROM master m, json_each(m.data,'$.suppliers') p
          WHERE m.kind='products' AND CAST(p.value AS INTEGER)=? LIMIT 1`,id,id)) return true;
      break;
    case 'warehouses':
      if (s.one(`SELECT 1 FROM master WHERE kind='products' AND CAST(json_extract(data,'$.defaultWarehouse') AS INTEGER)=?
        UNION ALL SELECT 1 FROM users u, json_each(u.warehouses) w WHERE CAST(w.value AS INTEGER)=? LIMIT 1`,id,id)) return true;
      break;
  }
  return false;
}

function masterUsedInDocument(s,kind,id) {
  const direct={
    products:'SELECT 1 FROM lines WHERE product=?',
    partners:'SELECT 1 FROM documents WHERE partner=?',
    warehouses:'SELECT 1 FROM documents WHERE ? IN (warehouse,target)',
    users:'SELECT 1 FROM documents WHERE creator=?',
    ledgerAccounts:"SELECT 1 FROM lines WHERE CAST(json_extract(data,'$.ledgerAccount') AS INTEGER)=?"
  };
  if (Object.hasOwn(direct,kind)&&s.one(direct[kind]+' LIMIT 1',id)) return true;
  const fields={partners:['settlementPartner'],accounts:['account','targetAccount'],expenses:['subject'],carriers:['carrier'],users:['handlerId']};
  if (Object.hasOwn(fields,kind)) {
    for (const field of fields[kind]) {
      if (s.one('SELECT 1 FROM documents WHERE CAST(json_extract(data,?) AS INTEGER)=? LIMIT 1','$.'+field,id)) return true;
    }
  }
  const detail={partners:'partner',accounts:'account',expenses:'subject'}[kind];
  if (detail&&s.one(`SELECT 1 FROM documents d, json_each(d.data,'$.saleExpenses') e
    WHERE CAST(json_extract(e.value,?) AS INTEGER)=? LIMIT 1`,'$.'+detail,id)) return true;
  return kind==='accounts'&&s.one(`SELECT 1 FROM documents d, json_each(d.data,'$.receipts') r
    WHERE CAST(json_extract(r.value,'$.account') AS INTEGER)=? LIMIT 1`,id);
}
function importRows(input,maxRows,maxBytes=1_000_000) {
  if (Object.hasOwn(input,'workbook')) {
    check(typeof input.workbook==='string'&&input.workbook.length<=Math.ceil(maxBytes/3)*4,'Excel 文件超过大小限制');
    try {
      const buffer=Buffer.from(input.workbook,'base64');
      check(buffer.length<=maxBytes,'Excel 文件超过大小限制');
      return readWorkbookRows(buffer,maxRows);
    } catch (error) {
      check(false,error.code?'无法读取 Excel 工作簿':error.message);
    }
  }
  check(typeof input.text==='string'&&input.text.length<=maxBytes,'请选择 Excel 文件（.xlsx）');
  try {return csvRows(input.text);} catch (error) {check(false,error.message);}
}
function importProducts(s,user,input) {
  const parsed=importRows(input,2001);
  const [headers,...rows]=parsed;
  const keys=headers?.map(h=>productColumns[h.trim()]||h.trim());
  check(keys?.includes('code') && rows.length && rows.length<=2000,'工作表须包含商品编号，且每次限 2000 行');
  const mode=input.mode;
  const selected={barcode:['barcode'],sku:['sku'],price:['retail','purchase',...Array.from({length:10},(_,i)=>'preset'+(i+1))],attributes:['attributes']};
  check(['new','update',...Object.keys(selected)].includes(mode),'无效导入模式');
  return s.tx(()=>{
    rows.forEach((values,i)=>{
      const row=Object.fromEntries(keys.map((key,k)=>[key,values[k]??'']));
      try {
        const existing=s.one("SELECT * FROM master WHERE kind='products' AND code=?",row.code.trim());
        check(mode==='new'?!existing:existing,mode==='new'?'商品编号已存在':'商品编号不存在');
        const fields=selected[mode]||Object.values(productColumns).filter(k=>!['code','name'].includes(k));
        const changed=Object.fromEntries(fields.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
        if (changed.method==='移动加权平均') changed.method='moving';
        if (changed.method==='全月一次加权平均') changed.method='monthly';
        if (changed.method==='个别计价') changed.method='individual';
        const data={...parse(existing?.data),...changed};
        if (mode==='attributes' && changed.attributes && parse(existing?.data).attributes) data.attributes=parse(existing.data).attributes+'，'+changed.attributes;
        saveMaster(s,user,'products',{id:existing?.id,code:row.code,name:mode==='new'||mode==='update'?row.name||existing?.name:existing.name,active:existing?.active,data});
      } catch (error) {error.message='第 '+(i+2)+' 行：'+error.message;throw error;}
    });
    return {count:rows.length};
  });
}
async function readRequestBody(req, limit=2_500_000) {
  const chunks=[];
  let bytes=0;
  for await (const chunk of req) {
    bytes+=chunk.length;
    check(bytes<=limit,'提交内容过大',413);
    chunks.push(chunk);
  }
  try {
    const data=JSON.parse(Buffer.concat(chunks).toString()||'{}');
    check(data&&typeof data==='object'&&!Array.isArray(data),'提交内容无效');
    return data;
  } catch { check(false,'提交内容无效'); }
}
function queryMasters(s,user,kind,q) {
  if (kind==='users') {
    check(user.role==='admin','没有职员管理权限',403);
    return {rows:getUsers(s)};
  }
  const warehouseIds=user.role==='admin'?[]:JSON.parse(user.warehouses);
  const conditions=['kind=?'];
  const args=[kind];
  if (kind==='warehouses' && warehouseIds.length) {
    conditions.push('id IN ('+warehouseIds.map(()=>'?').join(',')+')');
    args.push(...warehouseIds);
  }
  if (q.active==='1') conditions.push('active=1');
  if (q.active==='0') conditions.push('active=0');
  if (q.category) {conditions.push("(json_extract(data,'$.category')=? OR substr(json_extract(data,'$.category'),1,length(?)+1)=?||'/')");args.push(q.category,q.category,q.category);}
  if (kind==='partners'&&q.uncategorized==='1') conditions.push("COALESCE(json_extract(data,'$.category'),'')=''");
  if (kind==='partners'&&['customer','supplier','both'].includes(q.partnerType)) {
    conditions.push("(json_extract(data,'$.type')=? OR json_extract(data,'$.type')='both')");
    args.push(q.partnerType);
  }
  if (q.productType) {conditions.push("COALESCE(json_extract(data,'$.type'),'stock')=?");args.push(q.productType);}
  const terms=String(q.keyword||'').trim().split(/[\s,，]+/).filter(Boolean).slice(0,12);
  if (terms.length) {
    const fields=kind==='partners'?['code','name',...['shortName','pinyin','phone','contact'].map(key=>"json_extract(data,'$."+key+"')")]:
      ['code','name',"json_extract(data,'$.barcode')","json_extract(data,'$.sku')"];
    conditions.push('('+terms.map(()=> '('+fields.map(field=>field+' LIKE ?').join(' OR ')+')').join(' OR ')+')');
    for (const term of terms) args.push(...Array(fields.length).fill('%'+term+'%'));
  }
  const where=' FROM master WHERE '+conditions.join(' AND ');
  if (q.countOnly) return {count:s.one('SELECT COUNT(*) count'+where,...args).count};
  const size=q.all==='1'?100000:25;
  const page=Math.max(1,Math.min(100000,Math.floor(Number(q.page)||1)));
  const rows=s.all('SELECT *'+where+' ORDER BY code,id LIMIT ? OFFSET ?',...args,size,q.all==='1'?0:(page-1)*size).map(masterMap);
  if (kind==='products' && q.all!=='1') {
    const access=scope(user);
    const latest=(id,type)=>s.one(`SELECT l.price price FROM lines l JOIN documents d ON d.id=l.doc
      WHERE l.product=? AND d.type=? AND d.status IN ('posted','settled') AND ${access.sql}
      ORDER BY d.date DESC,d.id DESC,l.position DESC LIMIT 1`,id,type,...access.args)?.price;
    for (const row of rows) {
      row.latestPurchase=latest(row.id,'purchase');
      row.latestSale=latest(row.id,'sale');
      if (q.showStock==='1') {
        const warehouseFilter=warehouseIds.length?' AND warehouse IN ('+warehouseIds.map(()=>'?').join(',')+')':'';
        const stock=s.one('SELECT COALESCE(SUM(quantity),0) quantity FROM stock WHERE product=?'+warehouseFilter,row.id,...warehouseIds);
        row.stock=stock.quantity/1000;
      }
    }
  }
  if (kind==='accounts'&&rows.length&&(q.all!=='1'||q.export)) {
    const balances=new Map(s.all("SELECT entity,SUM(amount) balance FROM ledger WHERE category='cash' AND date<=? GROUP BY entity",today())
      .map(row=>[row.entity,row.balance]));
    const initial=new Map(s.all("SELECT entity,SUM(amount) amount FROM ledger l JOIN documents d ON d.id=l.doc WHERE d.type LIKE 'opening%' AND category='cash' GROUP BY entity").map(row=>[row.entity,row.amount]));
    for (const row of rows) {row.balance=balances.get(row.id)||0;row.openingBalance=initial.get(row.id)||0;}
  }
  if (kind==='partners'&&rows.length&&(q.all!=='1'||q.export)) {
    const access=scope(user);
    const balances=s.all(`SELECT l.entity,l.category,SUM(l.amount) amount FROM ledger l
      JOIN documents d ON d.id=l.doc WHERE ${access.sql} AND l.date<=?
      AND l.category IN ('ap','ar') GROUP BY l.entity,l.category`,...access.args,today());
    const byEntity=new Map();
    for (const balance of balances) {
      if (!byEntity.has(balance.entity)) byEntity.set(balance.entity,{});
      byEntity.get(balance.entity)[balance.category]=balance.amount;
    }
    for (const row of rows) {
      row.payable=byEntity.get(row.id)?.ap||0;
      row.receivable=byEntity.get(row.id)?.ar||0;
    }
  }
  return {rows,page};
}
function demoTransactions(s) {
  const admin=s.one("SELECT * FROM users WHERE username='admin'");
  const byCode=code=>s.one('SELECT id FROM master WHERE code=?',code).id;
  const warehouse=byCode('WH-01');
  const supplier=byCode('S-001');
  const customer=byCode('C-001');
  const post=(type,fields)=>{
    const draft=saveDocument(s,admin,{type,warehouse,...fields});
    for (const action of ['submit','approve','post']) transition(s,admin,draft.id,action);
    return draft;
  };
  post('openingCash',{data:{account:byCode('A-02'),amount:2000,summary:'样例期初余额'}});
  const incoming=[{product:byCode('P-1001'),quantity:100,price:8},{product:byCode('P-1002'),quantity:60,price:6.5},
    {product:byCode('P-1003'),quantity:120,price:2.4}];
  const order=post('purchaseOrder',{partner:supplier,lines:incoming,data:{summary:'样例到货采购'}});
  const purchase=post('purchase',{partner:supplier,lines:incoming,data:{reference:order.id,summary:'样例采购入库'}});
  post('payment',{partner:supplier,data:{reference:purchase.id,account:byCode('A-02'),amount:600,summary:'样例部分付款'}});
  const outgoing=[{product:byCode('P-1001'),quantity:12,price:15.8},{product:byCode('P-1003'),quantity:24,price:5.2}];
  const sale=post('sale',{partner:customer,lines:outgoing,data:{summary:'样例门店销售'}});
  post('receipt',{partner:customer,data:{reference:sale.id,account:byCode('A-02'),amount:100,summary:'样例部分收款'}});
}
function seedDocumentChoices(s,includeDocuments) {
  s.tx(()=>{
    for (const [kind,code,name,data] of [
      ['expenses','EXP-01','运输费用',{category:'费用'}],
      ['carriers','LOG-01','青禾物流',{description:'演示承运商'}]
    ]) s.run('INSERT OR IGNORE INTO master(kind,code,name,data) VALUES (?,?,?,?)',kind,code,name,JSON.stringify(data));
    s.run(`UPDATE users SET department='运营部' WHERE username='admin' AND department=''
      AND NOT EXISTS(SELECT 1 FROM users WHERE department!='')`);
  });
  if (openingState(s)?.opened===false || !includeDocuments || s.one('SELECT month FROM closes WHERE month>=?',today().slice(0,7))) return;
  const actor=s.one("SELECT * FROM users WHERE username='admin' AND active=1 AND role='admin'");
  const item=code=>s.one('SELECT id FROM master WHERE code=? AND active=1',code)?.id;
  const product=item('P-1001');
  const customer=item('C-001');
  const supplier=item('S-001');
  const warehouse=item('WH-01');
  if (!actor || !product || !customer || !supplier || !warehouse) return;
  for (const [type,marker,partner,price] of [
    ['quote','演示选择报价单',customer,15.8],['salesOrder','演示选择销售订单',customer,15.8],
    ['purchaseOrder','演示选择采购订单',supplier,8]
  ]) {
    if (s.one("SELECT id FROM documents WHERE type=? AND json_extract(data,'$.summary')=?",type,marker)) continue;
    const doc=saveDocument(s,actor,{type,warehouse,partner,lines:[{product,quantity:2,price}],data:{summary:marker}});
    transition(s,actor,doc.id,'submit');
  }
}
export function createApp({path=':memory:', password, demo=false, demoDocuments=false, secure=false, backupDirectory, printTimingLogger=entry=>console.info(JSON.stringify(entry))}={}) {
  if (path!==':memory:') mkdirSync(dirname(resolve(path)),{recursive:true});
  const s=openDatabase(path);
  if (!s.one('SELECT id FROM users LIMIT 1')) {
    check(typeof password==='string'&&password.length>=12&&password.length<=128,'首次启动请设置 ERP_ADMIN_PASSWORD（12–128 字符）');
    seed(s,password,demo);
    if (demo && demoDocuments) demoTransactions(s);
  }
  if (demo&&!s.one("SELECT id FROM audit WHERE action='重建数据' LIMIT 1")) seedDocumentChoices(s,demoDocuments);
  migrateOpening(s);
  repairOpeningEquity(s);
  initializeOpening(s,today());
  initializePrintTemplates(s);
  const maintenance=dataMaintenance(s,path,backupDirectory);
  const attempts=new Map();
  const server=createServer(async(req,res)=>{
    let authenticatedToken;
    const started=performance.now(),timed=/^\/api\/(?:print-templates|print\/preview)(?:[/?]|$)/.test(req.url);
    const body=async(req,limit)=>{
      const input=await readRequestBody(req,limit);
      if (authenticatedToken)
        check(s.one('SELECT 1 FROM sessions WHERE token=? AND expires>?',authenticatedToken,Date.now()),'请先登录',401);
      return input;
    };
    const sendError=(status,message,code='REQUEST_FAILED',field=null,extra={})=>
      send({error:message,code,message,field,...extra},status);
    const send=(data,status=200)=>{
      const json=JSON.stringify(data);
      if(timed){const duration=Math.round((performance.now()-started)*10)/10;res.setHeader('Server-Timing','print;dur='+duration);printTimingLogger?.({event:'print_api',method:req.method,path:req.url.split('?')[0],status,duration_ms:duration});}
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
      res.end(json);
    };
    const sendExcel=(columns,rows)=>{
      const workbook=xlsx(columns,rows);
      res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="export.xlsx"','Content-Length':workbook.length});
      res.end(workbook);
    };
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    res.setHeader('Cache-Control','no-store');
    try {
      const url=new URL(req.url,'http://localhost');
      const q=Object.fromEntries(url.searchParams);
      const route=url.pathname;
      const method=req.method;
      if (method==='GET' && Object.hasOwn(files,route)) {
        const [file,contentType]=files[route];
        res.writeHead(200,{'Content-Type':contentType});
        return res.end(readFileSync(new URL('../public/'+file,import.meta.url)));
      }
      if (method==='POST'||method==='PUT') {
        const origin=req.headers.origin;
        check(!origin || new URL(origin).host===req.headers.host,'请求来源无效',403);
        check(req.headers['content-type']?.startsWith('application/json'),'请提交 JSON 请求',415);
      }
      const share=route.match(/^\/statement\/([a-f0-9]{64})$/);
      if (share && method==='GET') {
        const record=s.one('SELECT statement FROM statement_links WHERE token=? AND expires>?',digest(share[1]),Date.now());
        check(record,'对账链接已失效',404);
        res.setHeader('Referrer-Policy','no-referrer');
        res.setHeader('X-Robots-Tag','noindex, nofollow');
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        return res.end(statementHtml(parse(record.statement)));
      }
      const token=req.headers.cookie?.match(/(?:^|;\s*)erp_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      const cookieOptions='; Path=/; HttpOnly; SameSite=Strict'+(secure?'; Secure':'');
      if (route==='/api/login' && method==='POST') {
        const key=req.socket.remoteAddress;
        const now=Date.now();
        for (const [ip,state] of attempts) if (state.until<=now) attempts.delete(ip);
        const state=attempts.get(key)||{count:0,until:now+10*60*1000};
        check(state.count<12,'登录尝试过多，请稍后再试',429);
        const input=await body(req);
        const user=s.one('SELECT u.*, p.data permissions FROM users u LEFT JOIN user_permissions p ON p.user_id=u.id WHERE u.username=? AND u.active=1',String(input.username||''));
        if (!user || !validPassword(input.password,user.hash)) {
          attempts.set(key,{count:state.count+1,until:state.until});
          check(false,'用户名或密码错误',401);
        }
        attempts.delete(key);
        const newToken=randomBytes(32).toString('hex');
        s.run('DELETE FROM sessions WHERE expires<=?',now);
        s.run('INSERT INTO sessions VALUES (?,?,?)',digest(newToken),user.id,now+lifetime);
        res.setHeader('Set-Cookie','erp_session='+newToken+cookieOptions+'; Max-Age='+lifetime/1000);
        return send(userView(user));
      }
      const user=token?s.one('SELECT u.*, p.data permissions FROM users u JOIN sessions s ON s.user_id=u.id LEFT JOIN user_permissions p ON p.user_id=u.id WHERE s.token=? AND expires>? AND active=1',digest(token),Date.now()):null;
      if (!user&&route==='/api/me'&&method==='GET') return send({user:null});
      check(user,'请先登录',401);
      authenticatedToken=digest(token);
      user.permissions=parse(user.permissions);
      const staffPermissionRoute=route.match(/^\/api\/staff-permissions(?:\/(\d+))?$/);
      if (staffPermissionRoute && ['GET','POST'].includes(method)) {
        check(user.role==='admin','只有管理员可以管理职员权限',403);
        if (method==='GET' && !staffPermissionRoute[1]) return send({staff:getUsers(s).filter(row=>row.role!=='admin')});
        const target=s.one('SELECT u.id,u.username,u.role,p.data FROM users u LEFT JOIN user_permissions p ON p.user_id=u.id WHERE u.id=?',Number(staffPermissionRoute[1]));
        check(target,'职员不存在',404);
        check(target.role!=='admin','管理员权限由角色管理',403);
        if (method==='GET') return send({permissions:parse(target.data)});
        const {permissions}=await body(req);
        check(validatePermissionOverrides(permissions),'权限配置无效',400);
        s.tx(()=>{
          // The role is checked again after reading the request body.
          check(s.one('SELECT role FROM users WHERE id=?',target.id)?.role===target.role,'职员角色已变更，请重新打开',409);
          s.run(`INSERT INTO user_permissions(user_id,data) VALUES (?,?)
            ON CONFLICT(user_id) DO UPDATE SET data=excluded.data`,target.id,JSON.stringify(permissions));
          log(s,user,'保存职员权限',target.username);
        });
        return send({permissions});
      }
      const mayEditDocument=type=>permits(user,'d:'+type,'create')||permits(user,'d:'+type,'edit');
      if (route.startsWith('/api/data-maintenance/')) {
        check(user.role==='admin','只有管理员可以备份或重建数据',403);
        if (route==='/api/data-maintenance/backups') {
          if (method==='GET') return send({backups:maintenance.list()});
          if (method==='POST') return send(maintenance.backup(user),201);
        }
        const download=route.match(/^\/api\/data-maintenance\/backups\/([^/]+)$/);
        if (download&&method==='GET') {
          const file=maintenance.file(download[1]);
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.size,
            'Content-Disposition':'attachment; filename="'+file.filename+'"'});
          await pipeline(createReadStream(file.path),res);
          return;
        }
        if (route==='/api/data-maintenance/preview'&&method==='POST')
          return send(maintenance.preview((await body(req)).groups));
        if (route==='/api/data-maintenance/rebuild'&&method==='POST') {
          const result=maintenance.rebuild(user,await body(req));
          initializeOpening(s,today());
          res.setHeader('Set-Cookie','erp_session='+cookieOptions+'; Max-Age=0');
          return send(result);
        }
      }
      if (route==='/api/print-templates'&&method==='GET') return send({rows:listPrintTemplates(s,user,q.type)});
      if (route==='/api/print-templates'&&method==='POST') return send(savePrintTemplate(s,user,await body(req,3_000_000)));
      if (route==='/api/print-templates/import'&&method==='POST') return send(importPrintTemplate(s,user,await body(req,12_000_000)));
      if (route==='/api/print-assets'&&method==='POST') return send(savePrintAsset(s,user,await body(req,1_500_000)));
      const printAsset=route.match(/^\/api\/print-assets\/([a-f0-9]{64})$/);
      if (printAsset&&method==='GET') {
        check(permits(user,'m:templates','design')||documentTypesFor(user,'print').length,'没有打印图片权限',403);
        const asset=s.one('SELECT * FROM print_assets WHERE id=?',printAsset[1]);
        check(asset,'打印图片不存在',404);
        res.writeHead(200,{'Content-Type':asset.mime,'Content-Length':asset.content.length});
        return res.end(Buffer.from(asset.content));
      }
      const templateExport=route.match(/^\/api\/print-templates\/(\d+)\/export$/);
      if(templateExport&&method==='GET') {
        const output=JSON.stringify(exportPrintTemplate(s,user,templateExport[1]),null,2);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="print-template.json"'});
        return res.end(output);
      }
      const templateRoute=route.match(/^\/api\/print-templates\/(\d+)$/);
      if(templateRoute&&method==='PUT') return send(savePrintTemplate(s,user,{...await body(req,3_000_000),id:Number(templateRoute[1])}));
      if(templateRoute&&method==='GET') return send(getPrintTemplate(s,user,templateRoute[1]));
      if(templateRoute&&method==='POST') return send(changePrintTemplate(s,user,templateRoute[1],await body(req)));
      if(route==='/api/print/preview'&&method==='POST') {
        const documents=preparePrint(s,user,await body(req),{enforce:false});
        return send({documents,templates:Object.fromEntries([...new Set(documents.map(row=>row.data.type))].map(type=>[type,listPrintTemplates(s,user,type)]))});
      }
      if(route==='/api/print/commit'&&method==='POST') return send(recordPrint(s,user,await body(req)));
      if(route==='/api/print/excel'&&method==='POST') {
        const values=preparePrint(s,user,await body(req));
        const output=[];
        let columns=[];
        for(const {data,template} of values) {
          check(permits(user,'d:'+data.type,'export'),'没有单据导出权限',403);
          const shown=template.layout.table.columns.filter(column=>column.visible!==false);
          if(!columns.length)columns=shown.map(column=>column.title);
          output.push([data.fields.documentName,data.fields.number]);
          if(output.length>1)output.push(shown.map(column=>column.title));
          for(const page of paginatePrint(template,data)) {
            output.push(...page.rows.map(row=>shown.map(column=>row[column.key]??'')));
            if(template.layout.table.subtotal)output.push(shown.map((column,index)=>index? page.subtotal[column.key]??'':'本页小计'));
            if(page.last&&template.layout.table.total)output.push(shown.map((column,index)=>index?page.totals[column.key]??'':'合计'));
          }
          const fields=paginatePrint(template,data)[0].fields;
          output.push(...Object.entries(printFields).filter(([key])=>key!=='page').map(([key,title])=>[title,fields[key]??'']));
          for(const element of template.layout.elements.filter(element=>element.kind==='expression'))
            output.push([element.expression,evaluatePrintExpression(element.expression,fields)]);
          output.push([]);
        }
        return sendExcel(columns,output);
      }
      if (route.startsWith('/api/opening')) {
        if (route==='/api/opening/state'&&method==='GET') return send(openingState(s));
        check(user.role==='admin','只有管理员可以维护期初建账',403);
        if (route==='/api/opening/control'&&method==='POST') return send(changeOpening(s,user,await body(req)));
        const openingRoute=route.match(/^\/api\/opening\/(stock|partners|accounts|balance)$/);
        if (openingRoute&&method==='GET') return send(openingData(s,user,openingRoute[1],q.warehouse));
        if (openingRoute&&method==='POST') return send(saveOpening(s,user,openingRoute[1],await body(req,5_000_000)));
        if (route==='/api/opening/template'&&method==='GET') return sendExcel(q.kind==='partners'?
          ['单位编号','期初应收','期初应付','期初预收','期初预付']:['商品编号','仓库','数量','成本单价','批号','生产日期'],[]);
        if (route==='/api/opening/import'&&method==='POST') {
          assertOpeningEditable(s);
          const input=await body(req,8_000_000);
          check(['stock','partners'].includes(input.kind),'请选择有效的期初导入类型');
          const rows=readWorkbookRows(Buffer.from(input.workbook||'','base64'),10001);
          check(rows.length>1,'Excel 中没有可导入数据');
          const expected=input.kind==='stock'?['商品编号','仓库','数量','成本单价']:['单位编号','期初应收','期初应付','期初预收','期初预付'];
          check(expected.every((label,index)=>String(rows[0][index]||'').trim()===label),'Excel 表头不正确，请下载期初模板填写');
          const errors=[],groups=new Map(),seen=new Set();
          for (const [index,cells] of rows.slice(1).entries()) {
            if (cells.every(value=>String(value).trim()==='')) continue;
            try {
              const record=s.one('SELECT id FROM master WHERE kind=? AND code=?',input.kind==='stock'?'products':'partners',String(cells[0]).trim());
              check(record,'编号不存在');
              let warehouse;
              if (input.kind==='stock') {
                const matches=s.all("SELECT id FROM master WHERE kind='warehouses' AND (code=? OR name=?)",String(cells[1]).trim(),String(cells[1]).trim());
                check(matches.length===1,'仓库不存在或名称重复');
                warehouse=matches[0].id;
              }
              if (input.kind==='stock') {
                const product=parse(s.one('SELECT data FROM master WHERE id=?',record.id).data);
                check(!(product.batch||product.method==='individual')||!Number(cells[2])||String(cells[4]||'').trim(),'批次商品请填写批号');
                check(!product.serial||!Number(cells[2]),'序列号商品请使用期初录入单');
                check(!cells[5]||/^\d{4}-\d{2}-\d{2}$/.test(String(cells[5]))&&!isNaN(Date.parse(cells[5])),'生产日期无效');
              }
              const key=(warehouse||'partners')+'|'+record.id;
              check(!seen.has(key),'重复编号或仓库商品组合');
              seen.add(key);
              const values=input.kind==='stock'?{id:record.id,quantity:cells[2],price:cells[3],batch:cells[4],production:cells[5]}:
                {id:record.id,ar:cells[1],ap:cells[2],advanceIn:cells[3],advanceOut:cells[4]};
              for (const key of input.kind==='stock'?['quantity','price']:['ar','ap','advanceIn','advanceOut']) {
                if (input.kind==='partners'&&(values[key]===''||values[key]==null)) values[key]=0;
                check(values[key]!==''&&values[key]!=null&&Number.isFinite(Number(values[key]))&&Number(values[key])>=0,'数量或金额必须为非负数');
              }
              check(input.kind!=='partners'||!(Number(values.ar)&&Number(values.ap))&&!(Number(values.advanceIn)&&Number(values.advanceOut)),'应收应付或预收预付不能同时填写');
              const group=warehouse||'partners';
              if (!groups.has(group)) groups.set(group,[]);
              groups.get(group).push({...values,excelRow:index+2});
            } catch (error) {errors.push('第 '+(index+2)+' 行：'+error.message);}
          }
          check(!errors.length,errors.join('；'));
          // An enclosing transaction makes imports spanning warehouses all-or-nothing.
          s.db.exec('BEGIN IMMEDIATE');
          try {
            check(input.revision===openingState(s).revision,'期初数据已变更，请刷新后重试',409);
            for (const [warehouse,values] of groups) {
              saveOpening(s,user,input.kind,{revision:openingState(s).revision,warehouse,rows:values},{withinTransaction:true});
            }
            s.db.exec('COMMIT');
          } catch (error) {s.db.exec('ROLLBACK');throw error;}
          return send({count:seen.size,state:openingState(s)});
        }
        check(false,'期初接口不存在',404);
      }
      if (route==='/api/system-settings' && method==='GET') return send(getSystemSettings(s));
      if (route==='/api/system-settings' && method==='POST') {
        check(user.role==='admin','只有管理员可以修改系统配置',403);
        const values=await body(req);
        check(validSystemSettings(values),'系统配置无效，请至少启用一种成本算法并检查小数位数');
        return send(s.tx(()=>{
          if (values.defaultSettlementAccount!=null) check(s.one("SELECT 1 FROM master WHERE kind='accounts' AND active=1 AND id=?",values.defaultSettlementAccount),'请选择启用的默认结算账户');
          const settings=saveSystemSettings(s,values);
          log(s,user,'保存系统配置','成本算法、小数位数和财务设置');
          return settings;
        }));
      }
      if (route==='/api/document-settings' && ['GET','POST'].includes(method)) {
        const input=method==='POST'?await body(req):q;
        const {type}=input;
        check(Object.hasOwn(families,type),'未知单据类型');
        check(mayEditDocument(type),'没有设置该单据的权限',403);
        const load=kind=>s.one('SELECT defaults_json,fields_json FROM document_settings WHERE user_id=? AND type=?',user.id,kind);
        const withDefaults=kind=>parse(load(kind)?.defaults_json||'{}');
        const withFields=kind=>parse(load(kind)?.fields_json||'{}');
        if (method==='GET') return send({defaults:withDefaults(type),fields:withFields(type)});
        const writeFields=(kind,rules)=>s.run(`INSERT INTO document_settings(user_id,type,fields_json) VALUES (?,?,?)
          ON CONFLICT(user_id,type) DO UPDATE SET fields_json=excluded.fields_json`,user.id,kind,JSON.stringify(rules));
        if (input.mode==='defaults') {
          const defaults=normalizeDefaults(type,input.values);
          s.run(`INSERT INTO document_settings(user_id,type,defaults_json) VALUES (?,?,?)
            ON CONFLICT(user_id,type) DO UPDATE SET defaults_json=excluded.defaults_json`,user.id,type,JSON.stringify(defaults));
          return send({defaults});
        }
        check(input.mode==='fields','未知设置类型');
        const targets=input.targets??[];
        check(Array.isArray(targets)&&targets.length<=Object.keys(families).length&&targets.every(kind=>Object.hasOwn(families,kind)&&kind!==type),'请选择有效的目标单据');
        check(targets.every(mayEditDocument),'没有设置目标单据的权限',403);
        const fields=normalizeFieldRules(type,input.values);
        const updated=s.tx(()=>{
          writeFields(type,fields);
          return Object.fromEntries([[type,fields],...[...new Set(targets)].map(kind=>{
            const rules=copyFieldRules(type,kind,fields,withFields(kind));
            writeFields(kind,rules);
            return [kind,rules];
          })]);
        });
        return send({fields,updated});
      }
      if (route==='/api/document-directory' && method==='GET') {
        check(documentTypesFor(user).some(mayEditDocument),'没有开单权限',403);
        const staff=s.all('SELECT id,username code,name,department FROM users WHERE active=1 ORDER BY username');
        const departments=[...new Set(staff.map(row=>row.department).filter(Boolean))];
        return send({staff,departments});
      }
      if (route==='/api/document-sources' && method==='GET') {
        check(mayEditDocument(q.target)&&permits(user,'d:'+q.type),'没有查询关联单据的权限',403);
        check(Object.hasOwn(relatedDocuments,q.target) && relatedDocuments[q.target].includes(q.type),'关联单据类型不匹配');
        const search={type:q.type,page:q.page,keyword:q.keyword,fulfillmentType:orderFulfillment[q.type]===q.target?q.target:null,
          status:['receipt','payment'].includes(q.target)?'posted,settled':submittedSources.includes(q.type)?'pending,approved,posted,settled':'posted,settled',
          onlyUnpaid:['receipt','payment'].includes(q.target)?true:undefined};
        return send({...listDocuments(s,user,search),...listDocuments(s,user,{...search,countOnly:true})});
      }
      if (route==='/api/me' && method==='GET') return send(userView(user));
      if (route==='/api/logout' && method==='POST') {
        s.run('DELETE FROM sessions WHERE token=?',digest(token));
        res.setHeader('Set-Cookie','erp_session='+cookieOptions+'; Max-Age=0');
        return send({ok:true});
      }
      if (['/api/product-categories','/api/partner-categories'].includes(route)) {
        const kind=route==='/api/partner-categories'?'partners':'products';
        check(permits(user,'m:'+kind)||(method==='GET'&&kind==='products'&&permits(user,'r:库存状况查询')),'没有查看分类权限',403);
        if (method==='GET') return send({paths:categoryPaths(s,kind)});
        if (method==='POST') {
          check(permits(user,'m:'+kind,'master'),'没有分类维护权限',403);
          return send(changeCategory(s,user,await body(req),kind));
        }
      }
      if (route==='/api/partners/import'&&method==='POST') {
        check(permits(user,'m:partners','import'),'没有往来单位导入权限',403);
        const parsed=importRows(await body(req),1001);
        const [headers,...rows]=parsed;
        const columns={'单位编号':'code','单位名称':'name','类型':'type','简名':'shortName','拼音码':'pinyin','联系电话':'phone','电话':'phone',
          '联系人':'contact','公司地址':'companyAddress','收货地址':'address','经手人':'handler','价格等级':'priceLevel','分类':'category','状态':'active'};
        const keys=(headers||[]).map(value=>columns[value.trim()]);
        check(['code','name','type'].every(key=>keys.includes(key)),'工作表需要单位编号、单位名称和类型');
        check(rows.length>0&&rows.length<=1000,'请导入 1 至 1000 条往来单位');
        const types={'客户':'customer','供应商':'supplier','客户、供应商':'both','客户和供应商':'both',customer:'customer',supplier:'supplier',both:'both'};
        s.tx(()=>{
          for (const [index,row] of rows.entries()) {
            const {code,name,type,active,...data}=Object.fromEntries(row.map((value,i)=>[keys[i],value.trim()]).filter(([key])=>key));
            try {
              check(Object.hasOwn(types,type),'类型须为客户、供应商或客户和供应商');
              data.type=types[type];
              saveMaster(s,user,'partners',{code,name,active:active==='停用'?0:1,data});
            } catch (error) {
              if (String(error.message).includes('UNIQUE constraint')) check(false,'第 '+(index+2)+' 行：单位编号已存在',409);
              check(false,'第 '+(index+2)+' 行：'+error.message,error.status||400);
            }
          }
        });
        return send({count:rows.length});
      }
      if (route==='/api/partners/status'&&method==='POST') {
        check(permits(user,'m:partners','master'),'没有往来单位维护权限',403);
        const {ids,active}=await body(req);
        check(Array.isArray(ids)&&ids.length>0&&ids.length<=100&&(active===0||active===1),'请选择往来单位和状态');
        check(ids.every(id=>Number.isSafeInteger(id)&&id>0),'无效往来单位');
        s.tx(()=>{
          for (const id of new Set(ids)) {
            check(s.one("SELECT id FROM master WHERE kind='partners' AND id=?",id),'往来单位不存在',404);
            s.run("UPDATE master SET active=? WHERE kind='partners' AND id=?",active,id);
          }
          log(s,user,active?'启用往来单位':'停用往来单位',ids.join(','));
        });
        return send({ok:true});
      }
      if (route==='/api/price' && method==='GET') {
        check(permits(user,'m:products'),'没有查看商品价格的权限',403);
        if (costDocumentTypes.includes(q.type)) {
          check(permits(user,'d:'+q.type),'没有此单据模块权限',403);
          if (q.warehouse) {
            const warehouse=getMaster(s,q.warehouse,'warehouses');
            const allowed=JSON.parse(user.warehouses);
            check(user.role==='admin'||!allowed.length||allowed.includes(warehouse.id),'超出仓库权限',403);
          }
          return send(inventoryCost(s,Number(q.product),Number(q.warehouse)||null,q.unit,q.batch));
        }
        return send(lookupPrice(s,Number(q.product),Number(q.partner),number(q.quantity,0,1e6),q.side,number(q.preset||1,1,10)));
      }
      if (route==='/api/documents/validate'&&method==='POST')
        return send(saveDocument(s,user,await body(req),{preview:true}));
      if (['/api/documents/bulk-delete','/api/documents/bulk-action'].includes(route)&&method==='POST') {
        const {ids,action}=await body(req);
        check(Array.isArray(ids)&&ids.length>0&&ids.length<=100&&ids.every(id=>Number.isSafeInteger(id)&&id>0),'请选择要操作的单据');
        const operation=route.endsWith('/bulk-delete')?'delete':action;
        return send({count:transitionDocuments(s,user,[...new Set(ids)],operation).length});
      }
      if (route==='/api/documents' && method==='POST') return send(saveDocument(s,user,await body(req,43_000_000)));
      if (route==='/api/documents' && method==='GET') {
        if (q.type) check(permits(user,'d:'+q.type,q.export?'export':'view'),'没有访问该单据模块的权限',403);
        if (q.export) check(documentTypesFor(user,'export').length,'没有导出单据的权限',403);
        const result=listDocuments(s,user,q);
        if (!q.export) return send(result);
        log(s,user,'导出','单据');
        const cash=value=>((value||0)/100).toFixed(2);
        const rows=result.rows.map(r=>[r.number,families[r.type][0],r.date,r.partnerName,r.warehouseName,
          r.reversalOf?'红冲单':r.reversed?'已红冲':statusNames[r.status],r.quantity,cash(r.gross),cash(r.reduction),
          cash(r.total),cash(r.settled),r.outstanding==null?'—':cash(r.outstanding),r.summary]);
        if (result.totals) {
          const totals=result.totals;
          rows.push(['合计','','','','','',totals.quantity,...['gross','reduction','total','settled','outstanding'].map(key=>totals[key]==null?'—':cash(totals[key]))]);
        }
        const tradeRows=result.rows.filter(row=>tradeTypes.includes(row.type));
        if (tradeRows.length) {
          rows.push([],['单据编号',...tradeColumns]);
          for (const row of tradeRows) {
            const doc=getDocument(s,user,row.id);
            rows.push(...doc.lines.map(line=>[row.number,...tradeLineRow(line,doc.data)]));
            rows.push([row.number,...tradeTotalRow(doc.tradeAmounts)]);
            const accountName=id=>id?s.one('SELECT name FROM master WHERE id=?',id)?.name:'';
            rows.push(...tradeSettlementRows(doc,accountName).map(values=>[row.number,...values]));
          }
        }
        return sendExcel(['单据编号','单据类型','单据日期','往来单位','仓库','状态','合计数量','含税金额','优惠金额','应结金额','已结金额','未结金额','摘要'],rows);
      }
      const attachment=route.match(/^\/api\/attachments\/(\d+)$/);
      if (attachment && method==='GET') {
        const file=s.one('SELECT * FROM attachments WHERE id=?',Number(attachment[1]));
        check(file,'附件不存在',404);
        getDocument(s,user,file.doc);
        res.writeHead(200,{'Content-Type':'application/octet-stream',
          'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16)),
          'Content-Length':file.content.length});
        return res.end(Buffer.from(file.content));
      }
      if (route==='/api/statements' && method==='POST') {
        check(permits(user,'r:对账','share'),'没有生成对账单权限',403);
        const input=await body(req);
        const party=getMaster(s,input.partner,'partners');
        const from=String(input.from||'');
        const to=String(input.to||today());
        check((!from || /^\d{4}-\d{2}-\d{2}$/.test(from)) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from<=to && to<=today(),'对账日期无效');
        const result=report(s,user,'对账',{partner:party.id,from,to});
        check((result.rows.length||result.summary?.rows.length) && result.rows.length<=1000,'没有可分享的对账流水或范围超过 1000 条');
        const key=randomBytes(32).toString('hex');
        s.tx(()=>{
          s.run('DELETE FROM statement_links WHERE expires<=?',Date.now());
          s.run('INSERT INTO statement_links VALUES (?,?,?,?)',digest(key),user.id,Date.now()+7*86400000,
            JSON.stringify({partner:party.name,from,to,created:today(),...result}));
          log(s,user,'生成对账链接',party.code+' '+from+' '+to);
        });
        return send({path:'/statement/'+key});
      }
      const printTemplates=route.match(/^\/api\/documents\/(\d+)\/print-template$/);
      if (printTemplates && method==='GET') {
        const document=getDocument(s,user,printTemplates[1]);
        check(permits(user,'d:'+document.type,'print'),'没有打印此单据的权限',403);
        const title=families[document.type][0];
        const template=s.one("SELECT data FROM master WHERE kind='templates' AND active=1 AND json_extract(data,'$.title')=? ORDER BY code LIMIT 1",title);
        return send({template:template?parse(template.data):null});
      }
      const doc=route.match(/^\/api\/documents\/(\d+)$/);
      if (doc && method==='GET') return send(getDocument(s,user,doc[1],q.detail==='1'));
      if (doc && method==='POST') return send(transition(s,user,doc[1],(await body(req)).action));
      const shipping=route.match(/^\/api\/partners\/(\d+)\/shipping$/);
      if (shipping && method==='POST') {
        check(permits(user,'m:partners','master'),'没有资料维护权限',403);
        const input=await body(req);
        const contact=String(input.contact||'').trim().slice(0,80);
        const phone=String(input.phone||'').trim().slice(0,32);
        const address=String(input.address||'').trim().slice(0,300);
        check(address,'请输入收货地址');
        s.tx(()=>{
          const partner=getMaster(s,shipping[1],'partners');
          const data={...partner.data,contact,phone,address};
          s.run('UPDATE master SET data=? WHERE id=?',JSON.stringify(data),partner.id);
          log(s,user,'保存收货资料',partner.code);
        });
        return send({ok:true});
      }
      if (route==='/api/document-lines/import'&&method==='POST') {
        const input=await body(req,300_000);
        check(Object.hasOwn(families,input.type)&&!['cash','journal'].includes(families[input.type][4]),'该单据不支持导入商品明细');
        check(mayEditDocument(input.type)&&permits(user,'m:products'),'没有导入单据明细的权限',403);
        check(Object.hasOwn(input,'workbook'),'请选择 Excel 文件（.xlsx）');
        return send({rows:importRows(input,501,200_000)});
      }
      const masterAction=route.match(/^\/api\/(?:master\/(\w+)|(products))\/(\d+)\/(status|delete)$/);
      if (masterAction&&method==='POST') {
        const [,masterKind,legacyKind,id,action]=masterAction;
        const kind=masterKind||legacyKind;
        check(Object.hasOwn(masters,kind)&&kind!=='settings','资料模块不存在',404);
        changeMasterRecord(s,user,kind,Number(id),action,await body(req));
        return send({ok:true});
      }
      if (route==='/api/products/import' && method==='POST') {
        check(permits(user,'m:products','import'),'没有商品导入权限',403);
        return send(importProducts(s,user,await body(req)));
      }
      const match=route.match(/^\/api\/master\/(\w+)$/);
      if (match && Object.hasOwn(masters,match[1])) {
        const kind=match[1];
        if (method==='POST') {
          check(permits(user,'m:'+kind,'master'),'没有资料维护权限',403);
          const input=await body(req);
          if (kind==='warehouses' && input.id && user.role!=='admin') {
            const ids=parse(user.warehouses);
            check(!ids.length||ids.includes(Number(input.id)),'不能维护权限范围外的仓库',403);
          }
          const result=s.tx(()=>kind==='users'?upsertUser(s,user,input):saveMaster(s,user,kind,input));
          return send(kind==='users'?{ok:true,id:result}:{ok:true});
        }
        if (method==='GET') {
          check(permits(user,'m:'+kind,q.export?'export':'view'),'没有访问该资料模块的权限',403);
          const result=queryMasters(s,user,kind,q.export?{...q,all:'1'}:q);
          if (!q.export) return send(result);
          log(s,user,'导出',masters[kind][0]);
          if (kind==='accounts') return sendExcel(['编号','名称','状态','期初余额','当前余额'],result.rows.map(row=>[row.code,row.name,row.active?'启用':'停用',(row.openingBalance/100).toFixed(2),(row.balance/100).toFixed(2)]));
          if (kind==='partners') return sendExcel(['单位编号','单位名称','类型','当前应付账款','当前应收账款','经手人','价格等级','公司地址','电话','状态'],
            result.rows.map(row=>[row.code,row.name,({customer:'客户',supplier:'供应商',both:'客户、供应商'})[row.data.type],
              ((row.payable||0)/100).toFixed(2),((row.receivable||0)/100).toFixed(2),row.data.handler,row.data.priceLevel,
              row.data.companyAddress||row.data.address,row.data.phone,row.active?'启用':'停用']));
          if (kind==='products') {
            const columns=Object.entries(productColumns);
            return sendExcel(columns.map(([k])=>k),result.rows.map(r=>columns.map(([,k])=>r[k]??r.data[k]??'')));
          }
          return sendExcel(['编号','名称','状态','资料'],result.rows.map(r=>[r.code||r.username,r.name,r.active?'启用':'停用',JSON.stringify(r.data??{role:r.role,department:r.department,warehouses:r.warehouses})]));
        }
      }
      if (route==='/api/report' && method==='GET') {
        check(permits(user,'r:'+q.name,q.export?'export':'view'),'没有访问该报表的权限',403);
        const result=report(s,user,q.name,q);
        if (q.export) {
          log(s,user,'导出',q.name);
          if (result.summary) return sendExcel(result.summary.columns,[...result.summary.rows,[],result.columns,...result.rows,...(result.totalRow?[result.totalRow]:[])]);
          return sendExcel(result.columns,result.totalRow?[...result.rows,result.totalRow]:result.rows);
        }
        const page=Math.max(1,Math.min(100000,Math.floor(Number(q.page)||1)));
        const start=(page-1)*25;
        return send({...result,count:result.rows.length,rows:result.rows.slice(start,start+25),
          documentIds:result.documentIds?.slice(start,start+25)});
      }
      if (route==='/api/close' && method==='POST') return send(closeMonth(s,user,(await body(req)).month));
      sendError(404,'页面不存在','NOT_FOUND');
    } catch (error) {
      if (error.code?.startsWith('SQLITE')||error.code==='ERR_SQLITE_ERROR') {
        if (String(error.message).includes('UNIQUE constraint')) return sendError(409,'记录与已有数据冲突','DATA_CONFLICT');
      }
      if (!error.status) console.error(error);
      if (!res.headersSent) sendError(error.status||500,error.status?error.message:'系统处理失败，请重试',error.status?error.code:'INTERNAL_ERROR',error.field,error.documentId?{documentId:error.documentId}:{});
      else res.end();
    }
  });
  server.on('close',()=>s.db.close());
  return {server,store:s};
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const demo=process.env.ERP_DEMO==='1';
  const {server}=createApp({path:process.env.ERP_DB || 'data/erp.sqlite',password:process.env.ERP_ADMIN_PASSWORD || (demo?'Demo-Inventory-2026':undefined),demo,demoDocuments:demo,secure:process.env.ERP_SECURE_COOKIE==='1'});
  const host=process.env.ERP_HOST||'127.0.0.1';
  const port=Number(process.env.PORT||3000);
  server.listen(port,host,()=>console.log('零售批发进销存系统 http://'+host+':'+server.address().port));
}
