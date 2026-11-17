export function productUnits(data) {
  const primary=String(data.unit||'').trim();
  const units=new Map([[primary,1]]);
  if (Array.isArray(data.unitRows)) {
    for (const row of data.unitRows) units.set(row.name,row.factor);
    return units;
  }
  for (const entry of String(data.units||'').split(/[，,；;\n]+/)) {
    const match=entry.trim().match(/^([^=]+)\s*=\s*(\d+(?:\.\d+)?)\s*(.*)$/);
    if (!match) continue;
    const [,label,factor,suffix]=match;
    const key=label.trim();
    const scale=Number(factor);
    if (key&&!units.has(key)&&scale>=0.001&&scale<=1e6&&(!suffix||suffix===primary)) units.set(key,scale);
  }
  return units;
}

export function unitDetails(data, name) {
  return data.unitRows?.find(row=>row.name===name);
}
export function defaultProductUnit(data,side) {
  const selected=side==='supplier'?data.purchaseUnit:side==='customer'?data.salesUnit:'';
  return productUnits(data).has(selected)?selected:data.unit||'';
}
