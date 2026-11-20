import { families, stockEffects, settlementFooters, logisticsFooters, settlementTypes } from './catalog.js';

export const fieldSections = [['head','表头字段'], ['headCustom','表头自定义'], ['body','表体字段'], ['bodyCustom','表体自定义'], ['foot','表尾字段']];
const field = (key,label,kind='文本',locked=false,readOnly=false) => ({key,label,kind,locked,readOnly});
const hiddenField = (key,label,kind) => ({...field(key,label,kind),hidden:true});
const custom = prefix => [1,2,3].map(i=>({...field(prefix+i,'自定义字段 '+i),hidden:true}));

export function documentFields(type) {
  const [,,,party,effect]=families[type];
  const opening=type==='openingStock';
  const buy=party==='supplier', cash=effect==='cash', fee=effect==='fee', journal=effect==='journal';
  const settlement=settlementFooters.includes(type), shipping=logisticsFooters.includes(type);
  const salesHeader=['sale','salesOrder'].includes(type), inbound=type==='purchase', target=effect==='transfer'||type==='transferOrder';
  const stock=stockEffects.includes(effect)||['purchaseOrder','salesOrder','transferOrder','purchaseFee'].includes(type);
  return {
    head:[
      ...(party?[field('partner',inbound?'供货单位':type==='sale'?'购买单位':buy?'供应商':'客户','选择',true)]:[]),
      ...(stock||['inquiry','quote'].includes(type)?[field('warehouse',inbound?'收货仓库':type==='sale'?'发货仓库':target?'调出仓库':'仓库','选择',stock)]:[]),
      ...(target?[field('target','调入仓库','选择',true)]:[]),
      field('handlerId','经手人','选择'), ...(inbound||salesHeader?[field('due',inbound?'付款到期日期':'收款到期日期','日期')]:[]),
      field('date','单据日期','日期',true), field('department','部门','选择',false,true),
      ...(salesHeader?[field('settlementPartner','结算单位','选择'),field('request','客户要求')]:[]),
      field('summary','摘要'), ...(party?[field('businessType','业务类型'),field('delivery','交货方式')]:[]),
      field('marker','标记'), field('note','附加说明')
    ],
    headCustom:custom('customHeader'),
    body:cash?[]:journal?[
      field('ledgerAccount','会计科目','选择',true),field('debit','借方金额','数值'),field('credit','贷方金额','数值'),field('note','明细备注')
    ]:[
      hiddenField('batch','批次号'),hiddenField('production','生产日期','日期'),field('product','商品编号 / 名称','选择',true),
      field('barcode','条码','文本',false,true),hiddenField('serials','序列号'),
      ...(effect==='exchange'?[field('direction','换货方向','选择',true)]:[]),
      field('quantity',opening?'期初数量':'数量','数值',true),field('unit','单位','选择',false,true),field('price',opening?'成本单价':'不含税单价','数值'),
      field('discount','明细折扣','数值'),field('tax','税率 %','数值'),hiddenField('expiry','到期日期','日期'),
      field('source','价格来源','文本',false,true),field('note','明细备注')
    ],
    bodyCustom:cash?[]:custom('customLine'),
    foot:[
      ...(cash||fee?[field('amount','金额','数值',true)]:journal?[]:[
        field('discount','整单折扣','数值'),field('reduction','整单优惠','数值'),field('freight',type==='sale'?'买家运费':'运费','数值')]),
      ...(settlement?[field('advance',buy?'用预付款':'用预收款','数值'),field('paid',buy?'本单付款金额':'本单收款金额','数值')]:[]),
      ...(cash&&!['openingAR','openingAP'].includes(type)||fee||settlement?[field('account',settlementTypes.includes(type)?'结算账户':'资金账户','选择',cash&&!['openingAR','openingAP'].includes(type)||fee)]:[]),
      ...(type==='cashTransfer'?[field('targetAccount','转入账户','选择',true)]:[]),
      ...(['expense','income','deferred'].includes(type)?[field('subject','费用/收入科目','选择')]:[]),
      ...(shipping?[field('address','收货信息'),field('deliveryName','收货人'),field('deliveryPhone','收货电话'),
        field('deliveryAddress','收货地址'),field('sender','寄件信息'),field('carrier','物流公司','选择'),field('tracking','物流单号'),
        field('carrierFee','物流运费','数值'),field('invoice','需要开票','勾选',false,true)]:[])
    ]
  };
}

export function documentDefaults(type) {
  const fields=documentFields(type);
  const buy=families[type][3]==='supplier';
  const kinds={partner:buy?'suppliers':'customers',warehouse:'warehouses',target:'warehouses',account:'accounts',targetAccount:'accounts',subject:'expenses'};
  return [...fields.head,...fields.foot].filter(({key})=>Object.hasOwn(kinds,key)||['businessType','delivery','marker'].includes(key))
    .map(({key,label})=>({key,label:key==='account'?(buy||['payment','advanceOut','expense','deferred'].includes(type)?'付款账户':'收款账户'):label,kind:kinds[key]}))
    .concat(fields.body.some(f=>f.key==='product')?[{key:'fuzzy',label:'扫码枪模糊匹配',kind:'boolean'},{key:'autoPrice',label:'按价格策略带出单价',kind:'boolean'}]:[]);
}

export function normalizeDefaults(type,values) {
  const defaults={};
  for (const {key,kind} of documentDefaults(type)) {
    const val=values?.[key];
    if (kind==='boolean') {if (typeof val==='boolean') defaults[key]=val;}
    else if (kind) {if (/^[1-9]\d{0,14}$/.test(String(val))) defaults[key]=Number(val);}
    else if (typeof val==='string'&&val.trim()) defaults[key]=val.trim().slice(0,100);
  }
  return defaults;
}

export function normalizeFieldRules(type,values) {
  const rules={};
  for (const [section,fields] of Object.entries(documentFields(type))) {
    rules[section]={};
    for (const f of fields) {
      const val=values?.[section]?.[f.key];
      if (!val||typeof val!=='object') continue;
      const alias=typeof val.alias==='string'?val.alias.trim().slice(0,40):'';
      const required=!f.locked&&!f.readOnly&&val.required===true;
      const visible=f.locked||required||(typeof val.visible==='boolean'?val.visible:!f.hidden);
      if (alias||required||visible===!!f.hidden) rules[section][f.key]={alias,required,visible};
    }
  }
  return rules;
}

export function copyFieldRules(fromType,toType,from,to) {
  const source=documentFields(fromType);
  const merged=normalizeFieldRules(toType,to);
  for (const [section,fields] of Object.entries(documentFields(toType))) {
    for (const {key,kind} of fields) {
      if (key==='partner'&&families[fromType][3]!==families[toType][3]) continue;
      if (!source[section].some(f=>f.key===key&&f.kind===kind)) continue;
      if (from?.[section]?.[key]) merged[section][key]=from[section][key];
      else delete merged[section][key];
    }
  }
  return normalizeFieldRules(toType,merged);
}

// Line positions are unique within a source document.
export function uniqueSourceLines(source) {
  return [...new Map(source.lines.map(line=>[line.position,line])).values()];
}

export async function loadDocumentSource(editor,{load,isCurrent,apply,setLoading}) {
  if (editor.sourceLoading) return;
  editor.sourceLoading=true;
  editor.sourceVersion=(editor.sourceVersion||0)+1;
  try {
    setLoading(true);
    const source=await load();
    if (isCurrent()) apply(source);
  } finally {
    editor.sourceLoading=false;
    setLoading(false);
  }
}

export function isLinkedReturn(editor) {
  return ['purchaseReturn','salesReturn'].includes(editor.type)&&!!editor.reference?.lines;
}

export function existingReturnLine(editor,product,unit,target) {
  if (!isLinkedReturn(editor)||!editor.reference.lines.some(line=>Number(line.product)===Number(product))) return;
  const matches=editor.lines.filter(line=>Number(line.product)===Number(product));
  if (matches.includes(target)) return target;
  return matches.find(line=>unit==null||line.unit===unit)||matches[0];
}

export function mergeReturnLine(editor,product,quantity,{target,unit,factors}={}) {
  if (editor.sourceLoading) return true;
  const existing=existingReturnLine(editor,product,unit,target);
  if (!existing) return false;
  if (existing!==target) {
    const factor=unit==null?1:(factors?.get(unit)||1)/(factors?.get(existing.unit)||1);
    existing.quantity=Number((Number(existing.quantity||0)+Number(quantity)*factor).toFixed(editor.precision.quantityDigits));
  }
  return true;
}
