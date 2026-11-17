import { families, masters, reports } from './catalog.js';

export const permissionLabels = {
  view:'查看',create:'新增',edit:'编辑',master:'维护',import:'导入',export:'导出',print:'打印',
  submit:'提交审核',approve:'审核通过',unapprove:'反审核',reject:'驳回',post:'记账',settle:'结算／终止',
  stop:'截停',delete:'删除',restore:'恢复',share:'生成对账链接'
};
const documentActions=['view','create','edit','submit','approve','unapprove','reject','post','settle','stop','delete','restore','export','print'];
const administratorModules=new Set(['m:users','m:settings','r:系统日志']);
export const permissionModules=[
  ...Object.entries(masters).filter(([key])=>!administratorModules.has('m:'+key)).map(([key,[label,group]])=>({
    id:'m:'+key,label,group,actions:['view','master',...(['products','partners'].includes(key)?['import']:[]),'export','print']
  })),
  ...Object.entries(families).map(([key,[label,,group]])=>({id:'d:'+key,label,group,actions:documentActions})),
  ...Object.entries(reports).flatMap(([group,names])=>names.filter(name=>!administratorModules.has('r:'+name)).map(label=>({
    id:'r:'+label,label,group,actions:['view','export','print',...(label==='对账'?['share']:[])]
  })))
];
const restrictedByDefault=new Set(['m:owners','m:templates','m:printers']);
const byId=new Map(permissionModules.map(module=>[module.id,module]));
const legacyClerk=new Set(['create','edit','master','import','submit','stop','delete','restore','share']);
const legacyReviewer=new Set(['approve','unapprove','reject','stop','post','settle']);

export function permits(user,module,action='view') {
  if (!user) return false;
  if (user.role==='admin') return true;
  if (administratorModules.has(module)||!byId.get(module)?.actions.includes(action)) return false;
  const override=user.permissions?.[module];
  if (override) return override.includes('view')&&override.includes(action);
  if (restrictedByDefault.has(module)) return false;
  if (['view','export','print'].includes(action)) return true;
  if (module==='m:warehouses'&&action==='master') return false;
  return user.role==='clerk'?legacyClerk.has(action):user.role==='reviewer'&&legacyReviewer.has(action);
}

export const documentTypesFor = (user,action='view') => Object.keys(families).filter(key=>permits(user,'d:'+key,action));

export function validatePermissionOverrides(value) {
  if (!value||typeof value!=='object'||Array.isArray(value)) return false;
  return Object.entries(value).every(([id,list])=>{
    const module=byId.get(id);
    return module&&Array.isArray(list)&&list.every(action=>module.actions.includes(action))&&
      (!list.length||list.includes('view'));
  });
}
