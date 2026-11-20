import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { check, log } from './engine.js';

const businessTables={
  print_jobs:'打印记录',
  opening_manual:'期初科目余额',opening_state:'建账状态',
  attachments:'单据附件',journal_entries:'会计分录',ledger:'往来与资金流水',movements:'库存流水',
  stock:'库存余额',lots:'商品批次',serials:'序列号',statement_links:'对账链接',lines:'单据明细',
  documents:'单据（含订单和期初）',closes:'月结记录'
};
const documentAudit="action IN ('保存单据','submit','approve','unapprove','reject','post','settle','stop','delete','restore','reverse')";
const masterGroups={
  products:['products'],bundles:['bundles'],partners:['partners'],carriers:['carriers'],
  prices:['supplierPrices','customerPrices','tiers']
};
const groupTitles={products:'商品信息及分类',bundles:'套餐',partners:'客户／供应商及分类',carriers:'物流公司',prices:'价格本及阶梯价'};
const filenamePattern=/^hengxu-(?:manual|rebuild)-\d{8}T\d{9}Z-[0-9a-f]{12}\.sqlite$/;

export function dataMaintenance(store,dbPath,configuredDirectory) {
  let directory=configuredDirectory?resolve(configuredDirectory):dbPath===':memory:'?null:resolve(dbPath+'.backups');
  const count=(table,filter='',...params)=>store.one('SELECT count(*) count FROM '+table+filter,...params).count;

  function snapshot(reason,source=store.db) {
    directory??=mkdtempSync(join(tmpdir(),'hengxu-backups-'));
    mkdirSync(directory,{recursive:true,mode:0o700});
    const stamp=new Date().toISOString().replace(/[-:.]/g,'');
    const filename='hengxu-'+reason+'-'+stamp+'-'+randomBytes(6).toString('hex')+'.sqlite';
    const file=join(directory,filename);
    closeSync(openSync(file,'wx',0o600));
    try {
      source.prepare('VACUUM INTO ?').run(file);
      const copy=new DatabaseSync(file);
      try {copy.exec('DELETE FROM sessions');}
      finally {copy.close();}
      const descriptor=openSync(file,'r+');
      try {fsyncSync(descriptor);}
      finally {closeSync(descriptor);}
      return describe(filename);
    } catch (error) {
      rmSync(file,{force:true});
      throw error;
    }
  }

  function describe(filename) {
    const file=join(directory,filename);
    const stat=statSync(file);
    return {filename,size:stat.size,created:stat.mtime.toISOString(),reason:filename.includes('-rebuild-')?'重建前':'手动'};
  }

  function list() {
    if (!directory||!existsSync(directory)) return [];
    return readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isFile()&&filenamePattern.test(entry.name))
      .map(entry=>describe(entry.name)).sort((a,b)=>b.created.localeCompare(a.created));
  }

  function preview(requested) {
    check(Array.isArray(requested)&&requested.every(group=>Object.hasOwn(masterGroups,group)),'请选择有效的重建范围');
    const groups=new Set(requested);
    if (groups.has('products')) groups.add('bundles');
    if (groups.has('products')||groups.has('partners')) groups.add('prices');
    const selected=Object.keys(masterGroups).filter(group=>groups.has(group));
    const rows=Object.entries(businessTables).map(([table,label])=>({label,count:count(table)}));
    rows.push({label:'单据操作日志',count:count('audit',' WHERE '+documentAudit)});
    for (const group of selected) {
      const kinds=masterGroups[group];
      let total=count('master',' WHERE kind IN ('+kinds.map(()=>'?').join(',')+')',...kinds);
      if (group==='products') total+=count('product_categories');
      if (group==='partners') total+=count('partner_categories');
      rows.push({label:groupTitles[group],count:total});
    }
    const token=createHash('sha256').update(JSON.stringify([selected,rows])).digest('hex');
    return {selected,rows,token};
  }

  function rebuild(user,{groups,token,confirmation}) {
    check(confirmation==='重建数据','请输入「重建数据」确认');
    check(dbPath!==':memory:','数据重建需要使用磁盘账套');
    // A second reader can snapshot the committed state while the writer lock is held.
    return store.tx(()=>{
      const plan=preview(groups);
      check(plan.token===token,'清理范围或记录数已变化，请重新预览',409);
      let backup;
      const source=new DatabaseSync(resolve(dbPath),{readOnly:true});
      try {backup=snapshot('rebuild',source);}
      finally {source.close();}
      for (const table of Object.keys(businessTables)) store.run('DELETE FROM '+table);
      store.run('DELETE FROM audit WHERE '+documentAudit);
      for (const group of plan.selected) {
        for (const kind of masterGroups[group]) store.run('DELETE FROM master WHERE kind=?',kind);
      }
      if (plan.selected.includes('products')) store.run('DELETE FROM product_categories');
      if (plan.selected.includes('partners')) {
        store.run('DELETE FROM partner_categories');
        store.run("UPDATE master SET data=json_remove(data,'$.suppliers') WHERE kind='products' AND json_type(data,'$.suppliers') IS NOT NULL");
        store.run("UPDATE document_settings SET defaults_json=json_remove(defaults_json,'$.partner')");
      }
      store.run('DELETE FROM sessions');
      log(store,user,'重建数据',backup.filename+' · '+['单据及业务流水',...plan.selected.map(group=>groupTitles[group])].join('、'));
      return {backup,rows:plan.rows};
    });
  }

  return {
    list,preview,rebuild,
    backup(user) {
      const result=snapshot('manual');
      log(store,user,'备份数据',result.filename);
      return result;
    },
    file(filename) {
      check(directory&&filenamePattern.test(filename),'备份文件不存在',404);
      const file=join(directory,filename);
      check(lstatSync(file,{throwIfNoEntry:false})?.isFile(),'备份文件不存在',404);
      return {path:file,...describe(filename)};
    }
  };
}
