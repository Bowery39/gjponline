export function csvRows(text) {
  const rows=[[]];
  let field='';
  let quoted=false;
  const clean=text.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
  for (let i=0;i<clean.length;i++) {
    const char=clean[i];
    if (char==='"') {
      if (quoted && clean[i+1]==='"') {field+='"';i++;}
      else quoted=!quoted;
    } else if (!quoted && (char===',' || char==='\n')) {
      rows.at(-1).push(field);
      field='';
      if (char==='\n') rows.push([]);
    } else field+=char;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  rows.at(-1).push(field);
  return rows.filter(row=>row.some(Boolean));
}
