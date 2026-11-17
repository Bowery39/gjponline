import { check, log } from './engine.js';

const categoryTable=kind=>kind==='partners'?'partner_categories':'product_categories';

export function categoryPaths(store,kind='products') {
  const paths=new Set(store.all('SELECT path FROM '+categoryTable(kind)).map(row=>row.path));
  for (const {category} of store.all("SELECT DISTINCT json_extract(data,'$.category') category FROM master WHERE kind=?",kind)) {
    if (typeof category!=='string'||!category) continue;
    const parts=category.split('/');
    for (let depth=1;depth<=parts.length;depth++) paths.add(parts.slice(0,depth).join('/'));
  }
  return [...paths].sort((a,b)=>a.localeCompare(b,'zh-CN'));
}

export function changeCategory(store,user,{action,path='',parent='',name=''},kind='products') {
  return store.tx(()=>{
    const table=categoryTable(kind);
    const paths=categoryPaths(store,kind);
    const within=(candidate,base)=>candidate===base||candidate.startsWith(base+'/');
    if (action==='delete') {
      check(paths.includes(path),'分类不存在',404);
      check(!paths.some(candidate=>candidate!==path&&within(candidate,path)),'请先移除子分类');
      check(!store.one("SELECT id FROM master WHERE kind=? AND json_extract(data,'$.category')=? LIMIT 1",kind,path),kind==='partners'?'请先将往来单位移出该分类':'请先将商品移出该分类');
      store.run('DELETE FROM '+table+' WHERE path=?',path);
      log(store,user,'删除分类',kind+' '+path);
      return {path:''};
    }

    check(['create','update'].includes(action),'无效分类操作');
    check(typeof name==='string'&&typeof parent==='string'&&typeof path==='string','无效分类数据');
    name=name.trim();
    check(name&&name.length<=40&&!/[\/\\\u0000-\u001f]/.test(name),'分类名称须为 1–40 个字符且不能包含斜杠');
    check(!parent||paths.includes(parent),'上级分类不存在');
    const target=parent?parent+'/'+name:name;
    if (action==='update') {
      check(paths.includes(path),'分类不存在',404);
      check(!parent||!within(parent,path),'不能移入自身或下级分类');
      if (path===target) return {path};
    }
    check(!paths.includes(target),'同级分类已存在');
    const subtree=action==='update'?paths.filter(candidate=>within(candidate,path)):[];
    check([target,...subtree.map(candidate=>target+candidate.slice(path.length))].every(candidate=>candidate.split('/').length<=4),'分类最多四级');
    if (action==='update') {
      for (const oldPath of subtree) {
        store.run('DELETE FROM '+table+' WHERE path=?',oldPath);
        store.run('INSERT INTO '+table+'(path) VALUES (?)',target+oldPath.slice(path.length));
      }
      store.run(`UPDATE master SET data=json_set(data,'$.category',?||substr(json_extract(data,'$.category'),length(?)+1))
        WHERE kind=? AND (json_extract(data,'$.category')=? OR substr(json_extract(data,'$.category'),1,length(?)+1)=?||'/')`,
      target,path,kind,path,path,path);
    } else store.run('INSERT INTO '+table+'(path) VALUES (?)',target);
    log(store,user,action==='create'?'新增分类':'调整分类',kind+' '+target);
    return {path:target};
  });
}
