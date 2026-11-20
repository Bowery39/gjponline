import { defaultSystemSettings, costMethods } from '../public/system-settings.js';

export function getSystemSettings(store) {
  const row=store.one('SELECT data FROM system_settings WHERE id=1');
  return {...defaultSystemSettings,...JSON.parse(row?.data||'{}')};
}

export function validSystemSettings(values) {
  if (!values || typeof values!=='object' || Array.isArray(values)) return false;
  const choices={
    movingSource:['stock','document'], taxMode:['general','simple'],
    purchaseTax:['inclusive','exclusive'], saleTax:['inclusive','exclusive']
  };
  if (!['companyName','companyAddress','companyPhone'].every(key=>values[key]==null||typeof values[key]==='string'&&values[key].length<=300)) return false;
  return (values.defaultSettlementAccount==null||Number.isSafeInteger(values.defaultSettlementAccount)&&values.defaultSettlementAccount>0) &&
    Array.isArray(values.costMethods) && values.costMethods.length>0 &&
    values.costMethods.every(method=>costMethods.some(([key])=>key===method)) &&
    ['quantityDigits','discountDigits','priceDigits'].every(key=>Number.isInteger(values[key])&&values[key]>=0&&values[key]<=4) &&
    Object.entries(choices).every(([key,options])=>options.includes(values[key])) &&
    ['taxEnabled','manualClose'].every(key=>typeof values[key]==='boolean');
}

export function saveSystemSettings(store, values) {
  const previous=getSystemSettings(store);
  const settings=Object.fromEntries(Object.keys(defaultSystemSettings).map(key=>[key,Object.hasOwn(values,key)?values[key]:previous[key]]));
  settings.costMethods=[...new Set(settings.costMethods)];
  store.run(`INSERT INTO system_settings(id,data) VALUES(1,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data`,JSON.stringify(settings));
  return settings;
}
