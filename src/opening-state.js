export const openingTypes=['openingStock','openingAR','openingAP','openingCash','openingBalance'];
export const isOpening=type=>openingTypes.includes(type);
export function openingState(s) {
  const row=s.one('SELECT * FROM opening_state WHERE id=1');
  return row?{opened:!!row.opened,date:row.date,revision:row.revision}:null;
}
export function assertOpeningEditable(s) {
  if (openingState(s)?.opened) throw Object.assign(new Error('系统已开账，期初数据只读'),{status:409});
}
export function assertBusinessOpen(s) {
  const state=openingState(s);
  if (state&&!state.opened) throw Object.assign(new Error('系统尚未开账'),{status:409});
}
export function initializeOpening(s,date) {
  if (openingState(s)) return;
  const existing=s.one("SELECT MIN(date) date FROM documents WHERE type NOT LIKE 'opening%' AND status!='deleted'");
  s.run('INSERT INTO opening_state VALUES(1,?,?,1)',existing?.date?1:0,existing?.date||date);
}
