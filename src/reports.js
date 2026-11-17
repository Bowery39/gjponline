import { documentTypesFor } from '../public/permissions.js';
import { unitPrice } from '../public/system-settings.js';
import { families, reports, statusNames, orderFulfillment } from '../public/catalog.js';
import { check, parse, today } from './engine.js';

const cash = n => (n / 100).toFixed(2);
const quantity = n => +(n / 1000).toFixed(4);
export function scope(user, alias = 'd') {
  if (user.role==='admin') return {sql:'1=1',args:[]};
  const warehouses = JSON.parse(user.warehouses);
  const where = [];
  const args = [];
  if (user.department) {
    where.push(`(${alias}.department='' OR ${alias}.department=?)`);
    args.push(user.department);
  }
  if (warehouses.length) {
    for (const field of ['warehouse','target']) {
      where.push(`(${alias}.${field} IS NULL OR ${alias}.${field} IN (${warehouses.map(()=>'?').join(',')}))`);
      args.push(...warehouses);
    }
  }
  return {sql:where.join(' AND ') || '1=1',args};
}
export function listDocuments(s,user,query) {
  const {sql,args} = scope(user);
  const page = Math.min(100000,Math.max(1,Math.floor(Number(query.page)||1)));
  const conditions = [sql];
  const params = [...args];
  const allowed=documentTypesFor(user,query.export?'export':'view');
  if (!allowed.length) return query.countOnly?{count:0}:{rows:[],count:0};
  conditions.push('d.type IN ('+allowed.map(()=>'?').join(',')+')');
  params.push(...allowed);
  if (query.type) { conditions.push('d.type=?'); params.push(query.type); }
  const fulfillmentType=orderFulfillment[query.type];
  if (fulfillmentType&&(query.fulfillmentType||['waiting','partial','complete','closed'].includes(query.execution))) {
    const remaining=`EXISTS (
      SELECT 1 FROM lines original WHERE original.doc=d.id GROUP BY original.product
      HAVING ROUND(SUM(original.quantity),1)>ROUND(COALESCE((
        SELECT SUM(actual.quantity) FROM lines actual JOIN documents downstream ON downstream.id=actual.doc
        WHERE actual.product=original.product AND downstream.type=?
          AND downstream.status IN ('posted','settled') AND json_extract(downstream.data,'$.reference')=d.id
      ),0),1))`;
    const processed=`EXISTS (SELECT 1 FROM documents downstream WHERE downstream.type=?
      AND downstream.status IN ('posted','settled') AND json_extract(downstream.data,'$.reference')=d.id)`;
    const status=query.fulfillmentType?'open':query.execution;
    conditions.push(status==='closed'?"d.status='settled'":status==='complete'?"d.status IN ('posted','settled')":"d.status IN ('pending','approved','posted')");
    conditions.push(status==='complete'?'NOT '+remaining:remaining);
    params.push(fulfillmentType);
    if (status==='partial'||status==='waiting') {
      conditions.push(status==='waiting'?'NOT '+processed:processed);
      params.push(fulfillmentType);
    }
  }
  if (query.group) {
    const types = Object.keys(families).filter(t=>families[t][2]===query.group);
    if (!types.length) return {rows:[],page,count:0};
    conditions.push('d.type IN ('+types.map(()=>'?').join(',')+')'); params.push(...types);
  }
  if (query.status) { conditions.push('d.status IN ('+query.status.split(',').map(()=>'?').join(',')+')'); params.push(...query.status.split(',')); }
  else conditions.push("d.status!='deleted'");
  const terms = String(query.keyword||'').trim().split(/[\s,，]+/).filter(Boolean).slice(0,12);
  if (terms.length) {
    conditions.push('('+terms.map(()=>"(d.number LIKE ? OR p.name LIKE ? OR w.name LIKE ? OR json_extract(d.data,'$.summary') LIKE ?)").join(' OR ')+')');
    for (const term of terms) params.push(...Array(4).fill('%'+term+'%'));
  }
  if (query.from) { conditions.push('d.date>=?'); params.push(query.from); }
  if (query.to) { conditions.push('d.date<=?'); params.push(query.to); }
  if (query.warehouse) {conditions.push('(d.warehouse=? OR d.target=?)');params.push(Number(query.warehouse),Number(query.warehouse));}
  if (query.partner) {conditions.push('d.partner=?');params.push(Number(query.partner));}
  const from = `FROM documents d LEFT JOIN master p ON d.partner=p.id LEFT JOIN master w ON d.warehouse=w.id
    WHERE ${conditions.join(' AND ')}`;
  if (query.countOnly) return {count:s.one('SELECT count(*) count '+from,...params).count};
  const rows = s.all(`SELECT d.id,d.type,d.status,d.number,d.date,d.total,p.name partnerName,w.name warehouseName,
    json_extract(d.data,'$.summary') summary ${from} ORDER BY d.id DESC LIMIT ? OFFSET ?`,...params,query.export ? 100000 : 25,query.export ? 0 : (page-1)*25);
  return {rows,page};
}
const table = (columns,rows,extra={}) => ({columns,rows,...extra});
export function report(s,user,name,q) {
  check(Object.values(reports).flat().includes(name),'报表不存在',404);
  const {sql,args} = scope(user);
  const from = q.from || '0001-01-01';
  const to = q.to || '9999-12-31';
  const warehouseIds = user.role==='admin' ? [] : JSON.parse(user.warehouses);
  const warehouse = Number(q.warehouse || 0);
  check(!warehouse || !warehouseIds.length || warehouseIds.includes(warehouse),'超出仓库权限',403);
  const stockScope = (alias) => warehouse ? [`AND ${alias}.warehouse=?`,[warehouse]]
    : warehouseIds.length ? [`AND ${alias}.warehouse IN (${warehouseIds.map(()=>'?').join(',')})`,warehouseIds] : ['',[]];
  const matches = (row) => !q.keyword || row.map(String).join(' ').toLowerCase().includes(q.keyword.trim().toLowerCase());
  const result = (columns, rows, extra) => table(columns,rows.filter(matches),extra);
  const documentRows = (columns, records, format) => {
    const found=records.map(record=>({cells:format(record),id:record.documentId})).filter(row=>matches(row.cells));
    return table(columns,found.map(row=>row.cells),{documentIds:found.map(row=>row.id)});
  };
  if (name==='系统日志' || name==='导出记录') {
    check(user.role==='admin' || name==='导出记录','没有访问权限',403);
    const rows=s.all(`SELECT a.created,u.name,a.action,a.detail FROM audit a LEFT JOIN users u ON a.user_id=u.id
      WHERE (?='系统日志' OR a.action='导出') AND (?='admin' OR a.user_id=?) ORDER BY a.id DESC LIMIT 1000`,name,user.role,user.id);
    return result(['时间','职员','操作','详情'],rows.map(r=>[r.created,r.name,r.action,r.detail]));
  }
  if (name==='月结存') return table(['月份','结存人','结存时间'],s.all('SELECT c.*,u.name FROM closes c JOIN users u ON c.user_id=u.id ORDER BY month DESC').map(r=>[r.month,r.name,r.created]));
  if (['库存状况查询','分仓库存查询','可销售库存查询','可发货库存查询','库存积压统计','库龄统计'].includes(name) && !q.view) {
    const [filter,params] = stockScope('st');
    const detail = name !== '库存状况查询';
    const rows=s.all(`SELECT p.id,p.code,p.name,p.data,${detail?'w.name':'NULL'} warehouse,${detail?'st.warehouse':'NULL'} warehouseId,
      SUM(st.quantity) quantity,SUM(st.value) value,COUNT(DISTINCT st.warehouse) warehouses,
      (SELECT MIN(m.date) FROM movements m WHERE m.product=p.id AND m.warehouse=st.warehouse AND m.quantity>0) firstIn
      FROM stock st JOIN master p ON st.product=p.id JOIN master w ON w.id=st.warehouse
      WHERE (?=1 OR p.active=1) AND (?='' OR COALESCE(json_extract(p.data,'$.method'),'moving')=?) ${filter} GROUP BY p.id${detail?',st.warehouse':''} ORDER BY p.code`,q.inactive==='1'?1:0,q.method||'',q.method||'',...params);
    const reservations = s.all(`SELECT r.product,r.warehouse,SUM(MAX(0,r.quantity-COALESCE(done.quantity,0))) quantity
      FROM (SELECT d.id,l.product,d.warehouse,SUM(l.quantity) quantity FROM lines l JOIN documents d ON d.id=l.doc
        WHERE d.type IN ('salesOrder','transferOrder') AND d.status IN ('approved','posted') AND ${sql}
        GROUP BY d.id,l.product,d.warehouse) r
      LEFT JOIN (SELECT json_extract(f.data,'$.reference') ref,l.product,SUM(l.quantity) quantity FROM documents f
        JOIN lines l ON l.doc=f.id WHERE f.status IN ('posted','settled') AND f.type IN ('sale','transfer')
        GROUP BY ref,l.product) done ON done.ref=r.id AND done.product=r.product
      GROUP BY r.product,r.warehouse`,...args);
    const display=rows.filter(r=>q.stockQuantity==='positive'?r.quantity>0:q.stockQuantity==='zero'?r.quantity===0:true).map(r=>{
      const p = parse(r.data);
      const price = Number(p.preset1 || p.retail || 0);
      const average = r.quantity ? r.value*10/r.quantity : 0;
      const reserved = reservations.filter(x=>x.product===r.id && (warehouse ? x.warehouse===warehouse : !detail || x.warehouse===r.warehouseId)).reduce((sum,x)=>sum+x.quantity,0);
      if (['可销售库存查询','可发货库存查询'].includes(name)) return [r.code,r.name,r.warehouse,quantity(r.quantity),quantity(reserved),quantity(Math.max(0,r.quantity-reserved)),p.unit||''];
      if (name==='库存状况查询') return [r.code,r.name,quantity(r.quantity),0,0,quantity(r.quantity),p.unit||'',average.toFixed(4),cash(r.value),price.toFixed(2),(price*quantity(r.quantity)).toFixed(2),price?((1-average/price)*100).toFixed(2)+'%':'—'];
      const age = r.firstIn ? Math.round((Date.parse(today())-Date.parse(r.firstIn))/86400000) : '';
      return [r.code,r.name,r.warehouse,quantity(r.quantity),p.unit||'',average.toFixed(4),cash(r.value),r.firstIn||'',age];
    });
    const columns = name==='库存状况查询' ? ['商品编号','商品名称','仓库库存','已出入库未核算','仓外库存','全部库存','基本单位','成本均价','库存金额','预设售价 1','参考销售总价','参考毛利率']
      : ['可销售库存查询','可发货库存查询'].includes(name) ? ['商品编号','商品名称','仓库','仓库库存','锁库占用',name.slice(0,-2),'基本单位']
      : ['商品编号','商品名称','仓库','库存','单位','成本均价','库存金额','首次入库','距首次入库（天）'];
    return result(columns,display);
  }
  if (name==='序列号跟踪') {
    const [filter,params] = stockScope('m');
    const rows=s.all(`SELECT d.id documentId,m.date,d.number,p.code,p.name,w.name warehouse,m.batch,m.serials,m.quantity
      FROM movements m JOIN documents d ON d.id=m.doc JOIN master p ON p.id=m.product
      JOIN master w ON w.id=m.warehouse WHERE ${sql} ${filter}
      AND m.date BETWEEN ? AND ? AND m.serials!='[]' ORDER BY m.id DESC`,...args,...params,from,to);
    return documentRows(['日期','单据编号','商品编号','商品名称','仓库','批次号','序列号','方向'],
      rows.flatMap(r=>JSON.parse(r.serials).map(serial=>({...r,serial}))),
      r=>[r.date,r.number,r.code,r.name,r.warehouse,r.batch,r.serial,r.quantity>0?'入库':'出库']);
  }
  if (q.view==='serial') {
    const [filter,params] = stockScope('a');
    const rows=s.all(`SELECT p.code,p.name,w.name warehouse,a.batch,a.serial FROM serials a JOIN master p ON p.id=a.product
      JOIN master w ON w.id=a.warehouse WHERE 1=1 ${filter} ORDER BY p.code,a.serial`,...params);
    return result(['商品编号','商品名称','仓库','批次号','序列号'],rows.map(r=>Object.values(r)));
  }
  if (q.view==='bundle') {
    const [filter,params] = stockScope('a');
    const bundles=s.all("SELECT * FROM master WHERE kind='bundles' AND active=1");
    return result(['套餐编号','套餐名称','套餐条码','预估仓内库存'],bundles.map(r=>{
      const data=parse(r.data);
      const components=Array.isArray(data.components) ? data.components : [];
      const builds=components.map(component=>{
        const stock=s.one(`SELECT COALESCE(SUM(quantity),0) quantity FROM stock a WHERE product=? ${filter}`,Number(component.product),...params);
        return Math.floor(quantity(stock.quantity)/Number(component.quantity));
      });
      return [r.code,r.name,data.barcode||'',builds.length?Math.min(...builds):0];
    }));
  }
  if (name==='批次号跟踪' && q.mode==='history') {
    const [filter,params] = stockScope('m');
    const rows=s.all(`SELECT d.id documentId,m.date,d.number,p.code,p.name,w.name warehouse,m.batch,m.expiry,m.quantity
      FROM movements m JOIN documents d ON d.id=m.doc JOIN master p ON p.id=m.product
      JOIN master w ON w.id=m.warehouse WHERE ${sql} ${filter}
      AND m.date BETWEEN ? AND ? AND m.batch!='' ORDER BY m.id DESC`,...args,...params,from,to);
    return documentRows(['日期','单据编号','商品编号','商品名称','仓库','批次号','到期日期','变动数量'],rows,r=>[r.date,r.number,r.code,r.name,r.warehouse,r.batch,r.expiry,quantity(r.quantity)]);
  }
  if (['批次号跟踪','临期商品预警'].includes(name)) {
    const [filter,params] = stockScope('a');
    const rows=s.all(`SELECT p.code,p.name,w.name warehouse,a.batch,a.expiry,a.quantity FROM lots a JOIN master p ON a.product=p.id
      JOIN master w ON w.id=a.warehouse WHERE a.quantity>0 ${filter}
      AND (?=0 OR (a.expiry!='' AND a.expiry<=date(?,'+30 days'))) ORDER BY a.expiry,p.code`,...params,name==='临期商品预警'?1:0,today());
    return result(['商品编号','商品名称','仓库','批次号','到期日期','库存数量'],rows.map(r=>[r.code,r.name,r.warehouse,r.batch,r.expiry,quantity(r.quantity)]));
  }
  if (['调拨在途统计','库存调货统计'].includes(name)) {
    const transferType=name==='调拨在途统计'?'transferOrder':'transfer';
    const rows=s.all(`SELECT d.id documentId,d.number,d.date,d.status,w.name source,t.name target,SUM(l.quantity) quantity
      FROM documents d JOIN lines l ON l.doc=d.id LEFT JOIN master w ON w.id=d.warehouse LEFT JOIN master t ON t.id=d.target
      WHERE ${sql} AND d.date BETWEEN ? AND ? AND d.type=? AND d.status IN ('approved','posted','settled')
      AND (?='transfer' OR NOT EXISTS(SELECT 1 FROM documents f WHERE f.type='transfer' AND f.status IN ('posted','settled') AND json_extract(f.data,'$.reference')=d.id))
      GROUP BY d.id ORDER BY d.date,d.number`,...args,from,to,transferType,transferType);
    return documentRows(['单据编号','日期','状态','调出仓','调入仓','数量'],rows,r=>[r.number,r.date,statusNames[r.status],r.source,r.target,quantity(r.quantity)]);
  }
  if (['库存变动统计','商品进销存变动统计','全月商品出库成本表','库存周转率'].includes(name)) {
    const [filter,params] = stockScope('m');
    const rows=s.all(`SELECT d.id documentId,p.code,p.name,w.name warehouse,m.date,d.number,d.type,m.quantity,m.value FROM movements m
      JOIN documents d ON d.id=m.doc JOIN master p ON p.id=m.product JOIN master w ON w.id=m.warehouse
      WHERE ${sql} ${filter} AND m.date<=? ORDER BY m.date,m.id`,...args,...params,to);
    if (name==='库存周转率' || name==='商品进销存变动统计') {
      const groups=new Map();
      for (const r of rows) {
        const key=r.code+'|'+r.warehouse;
        if (!groups.has(key)) groups.set(key,{...r,opening:0,ending:0,out:0,in:0});
        const a=groups.get(key);
        a.ending+=r.value;
        if (r.date<from) a.opening+=r.value;
        else if (r.quantity<0) a.out-=r.value;
        else a.in+=r.value;
      }
      return result(['商品编号','商品名称','仓库','期初金额','期间入库金额','期间出库金额','期末金额','周转次数'],[...groups.values()].map(r=>[r.code,r.name,r.warehouse,cash(r.opening),cash(r.in),cash(r.out),cash(r.ending),r.opening+r.ending? (2*r.out/(r.opening+r.ending)).toFixed(2):'—']));
    }
    return documentRows(['日期','单据编号','商品编号','商品名称','仓库','数量','成本金额'],rows.filter(r=>r.date>=from && (name!=='全月商品出库成本表'||r.quantity<0)),r=>[r.date,r.number,r.code,r.name,r.warehouse,quantity(r.quantity),cash(r.value)]);
  }
  const ledgerFilter = warehouse ? 'AND (d.warehouse=? OR d.target=?)' : '';
  const entries=s.all(`SELECT l.*, d.id documentId,d.number,d.type,d.partner,d.creator,m.name entityName, r.number referenceNumber,
    p.name partnerName,u.name creatorName,json_extract(m.data,'$.type') entityType
    FROM ledger l JOIN documents d ON d.id=l.doc LEFT JOIN documents r ON r.id=l.reference LEFT JOIN master m ON m.id=l.entity
    LEFT JOIN users u ON d.creator=u.id LEFT JOIN master p ON d.partner=p.id WHERE ${sql} ${ledgerFilter} AND l.date<=?
    ORDER BY l.date,l.id`,...args,...(warehouse?[warehouse,warehouse]:[]),to);
  const period=entries.filter(r=>r.date>=from);
  const sum=(category,rows=period)=>rows.filter(r=>r.category===category).reduce((n,r)=>n+r.amount,0);
  const documents=s.all(`SELECT d.*,p.name partnerName,u.name creatorName FROM documents d LEFT JOIN master p ON p.id=d.partner
    JOIN users u ON u.id=d.creator WHERE ${sql} ${ledgerFilter} AND d.date BETWEEN ? AND ? AND d.status IN ('approved','posted','settled') ORDER BY d.date,d.id`,
    ...args,...(warehouse?[warehouse,warehouse]:[]),from,to);
  if (['往来单位应收应付','对账','按单结算统计','按单结算查询'].includes(name)) {
    const byDoc = name.startsWith('按单');
    const groups = new Map();
    const partnerId = Number(q.partner || 0);
    const phone = q.keyword?.trim();
    const phonePartners = phone ? s.all(`SELECT name FROM master WHERE kind='partners' AND json_extract(data,'$.phone')=?`,phone).map(r=>r.name) : [];
    const partnerRows = rows => rows.filter(row=>!partnerId||row.entity===partnerId);
    const accountResult = (columns,rows) => table(columns,rows.filter(row=>matches(row)||phonePartners.some(p=>row.includes(p))));
    for (const row of partnerRows(entries).filter(r=>['ar','ap','advanceIn','advanceOut'].includes(r.category))) {
      const key = byDoc ? (row.referenceNumber || '未指定单据')+'|'+row.entity : row.entity;
      if (!groups.has(key)) groups.set(key,{name:row.entityName,no:row.referenceNumber||'未指定单据',ar:0,ap:0,advanceIn:0,advanceOut:0,paid:0,opening:0});
      const group=groups.get(key);
      group[row.category]+=row.amount;
      if (row.date>=from && ['receipt','payment'].includes(row.type)) group.paid-=row.amount;
      if (row.date<from && ['ar','ap'].includes(row.category)) group.opening+=row.amount;
    }
    if (name==='对账' || name==='按单结算查询') return documentRows(['日期','单据编号','关联单据','往来单位','科目','发生额'],
      partnerRows(period).filter(r=>['ar','ap','advanceIn','advanceOut'].includes(r.category)),
      r=>[r.date,r.number,r.referenceNumber||'',r.entityName,({ar:'应收',ap:'应付',advanceIn:'预收',advanceOut:'预付'})[r.category],cash(r.amount)]);
    return accountResult(byDoc?['单据编号','往来单位','应收余额','应付余额','期间结算']:['往来单位','应收余额','应付余额','预收余额','预付余额'],[...groups.values()].map(r=>byDoc?[r.no,r.name,cash(r.ar),cash(r.ap),cash(r.paid)]:[r.name,cash(r.ar),cash(r.ap),cash(r.advanceIn),cash(r.advanceOut)]));
  }
  if (name==='现金银行变动表' || name==='费用及其他收入统计') {
    const categories=name==='现金银行变动表'?['cash']:['expense','income','deferred','salesFee'];
    return documentRows(['日期','单据编号','单据类型','账户或科目','金额'],period.filter(r=>categories.includes(r.category)),r=>[r.date,r.number,families[r.type][0],r.entityName||'',cash(r.amount)]);
  }
  const revenue=sum('sales'), cost=sum('cogs'), fee=sum('salesFee'), other=sum('income'), expenses=sum('expense');
  if (name==='利润表') return table(['项目','金额'],[['营业收入',revenue],['营业成本',cost],['销售费用',fee],['其他收入',other],['其他费用',expenses],['经营利润',revenue-cost-fee+other-expenses]].map(([k,v])=>[k,cash(v)]));
  if (['资产负债表','会计分录查询'].includes(name)) {
    if (name==='会计分录查询') {
      const rows=s.all(`SELECT j.*, d.id documentId,d.number, m.name entityName FROM journal_entries j
        JOIN documents d ON d.id=j.doc LEFT JOIN master m ON j.entity=m.id
        WHERE ${sql} ${ledgerFilter} AND j.date BETWEEN ? AND ? ORDER BY j.date,d.id,j.id`,...args,...(warehouse?[warehouse,warehouse]:[]),from,to);
      return documentRows(['日期','单据编号','科目编号','科目','明细','借方金额','贷方金额'],
        rows,r=>[r.date,r.number,r.code,r.name,r.entityName||'',r.amount>0?cash(r.amount):'',r.amount<0?cash(-r.amount):'']);
    }
    const rows=s.all(`SELECT j.code,j.name,j.category,SUM(j.amount) amount FROM journal_entries j JOIN documents d ON d.id=j.doc
      WHERE ${sql} ${ledgerFilter} AND j.date<=? GROUP BY j.code,j.name,j.category ORDER BY j.code`,
      ...args,...(warehouse?[warehouse,warehouse]:[]),to);
    const categoryName={asset:'资产',liability:'负债',equity:'权益',other:'未分类'};
    const balanceItems=rows.filter(r=>!['income','expense'].includes(r.category));
    const earnings=rows.filter(r=>['income','expense'].includes(r.category)).reduce((n,r)=>n-r.amount,0);
    const values=balanceItems.map(r=>[categoryName[r.category]||'未分类',r.code,r.name,cash(['liability','equity'].includes(r.category)?-r.amount:r.amount)]);
    values.push(['权益','','累计损益',cash(earnings)]);
    return table(['分类','科目编号','项目','期末余额'],values);
  }
  if (['经营报告','综合统计月报','销售波动分析'].includes(name)) {
    const purchase=documents.filter(r=>r.type==='purchase' && r.status!=='approved');
    const sales=documents.filter(r=>r.type==='sale' && r.status!=='approved');
    const trend=new Map();
    for (const row of period.filter(r=>r.category==='sales')) {
      const key=q.mode==='month'||name==='综合统计月报'?row.date.slice(0,7):row.date;
      trend.set(key,(trend.get(key)||0)+row.amount);
    }
    const sections=[
      {name:'资金状况',values:[['现金发生额',cash(period.filter(r=>r.category==='cash' && r.entityType==='cash').reduce((n,r)=>n+r.amount,0))],['银行发生额',cash(period.filter(r=>r.category==='cash' && r.entityType==='bank').reduce((n,r)=>n+r.amount,0))],['费用支出',cash(expenses)],['其他收入',cash(other)],['收款金额',cash(sum('cash',period.filter(r=>r.type==='receipt')))],['付款金额',cash(-sum('cash',period.filter(r=>r.type==='payment')))]]},
      {name:'出入库分析',values:[['采购笔数',purchase.length],['采购金额',cash(purchase.reduce((n,r)=>n+r.total,0))],['销售笔数',sales.length],['销售金额',cash(sales.reduce((n,r)=>n+r.total,0))],['应付款发生额',cash(sum('ap'))],['应收款发生额',cash(sum('ar'))]]},
      {name:'经营分析',values:[['销售及其他业务收入',cash(revenue+other)],['销售成本',cash(cost)],['销售费用分摊',cash(fee)],['毛利',cash(revenue-cost-fee)],['毛利率',revenue?((revenue-cost-fee)/revenue*100).toFixed(2)+'%':'—']]}
    ];
    return table(['期间','销售收入'],[...trend].map(([k,v])=>[k,cash(v)]),{sections});
  }
  if (['经手人业务统计','往来单位业务统计','往来单位收付款分析','客户流失预警分析'].includes(name)) {
    const groups=new Map();
    const groupKey=name==='经手人业务统计'?'creatorName':'partnerName';
    const rows=name==='往来单位收付款分析'?documents.filter(r=>['receipt','payment'].includes(r.type)):
      name==='客户流失预警分析'?documents.filter(r=>r.type==='sale'):documents.filter(r=>['purchase','sale','salesReturn','purchaseReturn'].includes(r.type));
    if (name==='客户流失预警分析') for (const customer of s.all(`SELECT name FROM master WHERE kind='partners'
      AND active=1 AND json_extract(data,'$.type') IN ('customer','both')`)) groups.set(customer.name,{count:0,total:0,last:''});
    for (const r of rows.filter(r=>r.status!=='approved' && r[groupKey])) {
      const key=r[groupKey];
      const current=groups.get(key)||{count:0,total:0,last:''};
      current.count++;
      current.total+=r.total*(r.type.endsWith('Return')||r.type==='payment'?-1:1);
      if (r.date>current.last) current.last=r.date;
      groups.set(key,current);
    }
    return result([groupKey==='creatorName'?'经手人':'往来单位','单据数','净发生额','最近业务日期','距今（天）'],[...groups].map(([key,r])=>[key,r.count,cash(r.total),r.last,r.last?Math.round((Date.parse(today())-Date.parse(r.last))/86400000):'无销售记录']));
  }
  const purchasing=reports['采购'].includes(name);
  const order=name.includes('订单');
  const types=purchasing ? (order?['purchaseOrder']:['purchase','purchaseReturn','purchaseExchange']) : (order?['salesOrder']:['sale','salesReturn','exchange']);
  const rows=s.all(`SELECT d.id,d.id documentId,d.number,d.date,d.type,d.total,d.data docData,p.name partnerName,l.*,m.code productCode,m.name productName
    FROM documents d JOIN lines l ON l.doc=d.id JOIN master m ON m.id=l.product LEFT JOIN master p ON p.id=d.partner
    WHERE ${sql} ${ledgerFilter} AND d.date BETWEEN ? AND ? AND d.type IN (${types.map(()=>'?').join(',')})
    AND d.status IN (${order?"'approved',":''}'posted','settled') ORDER BY d.date,d.id,l.position`,...args,...(warehouse?[warehouse,warehouse]:[]),from,to,...types);
  const signed = r => r.type.endsWith('Return') || (['exchange','purchaseExchange'].includes(r.type) && parse(r.data).direction==='return') ? -1 : 1;
  if (name==='采购波动分析') {
    const trend=new Map();
    for (const row of rows) {
      const period=q.mode==='month'?row.date.slice(0,7):row.date;
      const current=trend.get(period)||{docs:new Set(),quantity:0,net:0};
      current.docs.add(row.id);
      current.quantity+=signed(row)*row.quantity;
      current.net+=signed(row)*(row.net+row.tax);
      trend.set(period,current);
    }
    return result(['期间','采购单据数','净采购数量','净含税金额'],
      [...trend].map(([period,row])=>[period,row.docs.size,quantity(row.quantity),cash(row.net)]));
  }
  const untaxedPrice = row => {
    const data=parse(row.data);
    const price=unitPrice({...row,data});
    return parse(row.docData).taxInclusive ? price/(1+(data.tax||0)/100) : price;
  };
  if (name==='销售优惠统计') return documentRows(['日期','单据编号','商品名称','原价金额','折后不含税金额','明细及整单折扣'],rows,r=>{
    const original=Math.round(untaxedPrice(r)*(parse(r.data).enteredQuantity??r.quantity)/10);
    return [r.date,r.number,r.productName,cash(original),cash(r.net),cash(original-r.net)];
  });
  if (name.includes('明细')) return documentRows(['日期','单据编号','往来单位','商品编号','商品名称','数量','不含税单价','含税金额'],rows,r=>
    [r.date,r.number,r.partnerName,r.productCode,r.productName,quantity(signed(r)*r.quantity),
      untaxedPrice(r).toFixed(parse(r.docData).precision?.priceDigits??2),cash(signed(r)*(r.net+r.tax))]);
  if (order) return documentRows(['日期','单据编号','往来单位','状态','订单金额'],documents.filter(r=>types.includes(r.type)).map(r=>({...r,documentId:r.id})),r=>[r.date,r.number,r.partnerName,statusNames[r.status],cash(r.total)]);
  const groups=new Map();
  const costs=new Map();
  if (!purchasing) for (const r of s.all(`SELECT m.doc,m.position,SUM(m.value) value FROM movements m JOIN documents d ON d.id=m.doc
    WHERE ${sql} AND d.date BETWEEN ? AND ? GROUP BY m.doc,m.position`,...args,from,to)) costs.set(r.doc+'-'+r.position,-r.value);
  if (name==='畅销/滞销商品表') for (const product of s.all("SELECT code,name FROM master WHERE kind='products' AND active=1")) groups.set(product.code,{name:product.name,qty:0,net:0,cost:0});
  for (const r of rows) {
    const current=groups.get(r.productCode)||{name:r.productName,qty:0,net:0,cost:0};
    current.qty+=r.quantity*signed(r);
    current.net+=r.net*signed(r);
    current.cost+=costs.get(r.doc+'-'+r.position)||0;
    groups.set(r.productCode,current);
  }
  return result(purchasing?['商品编号','商品名称','净采购量','不含税金额']:['商品编号','商品名称','净销量','不含税收入','销售成本','商品毛利'],[...groups].sort((a,b)=>b[1].qty-a[1].qty).map(([k,r])=>[k,r.name,quantity(r.qty),cash(r.net),...(purchasing?[]:[cash(r.cost),cash(r.net-r.cost)])]));
}
