import { showSystemPrompt } from './system-prompt.js';

const dialog=document.querySelector('#document-picker');
const make=(tag,text,className)=>{
  const node=document.createElement(tag);
  if (text!=null) node.textContent=text;
  if (className) node.className=className;
  return node;
};
const button=(text,action,className='')=>{
  const node=make('button',text,'btn '+className);
  node.type='button';
  node.addEventListener('click',action);
  return node;
};
function layout(title,main,footer) {
  const heading=make('h2',title);
  heading.id='picker-heading';
  const head=make('header',null,'modal-head');
  const close=button('×',closePicker,'picker-close');
  close.setAttribute('aria-label','关闭选择框');
  head.append(heading,close);
  const wrap=make('div',null,'modal-layout');
  wrap.append(head,main,footer);
  dialog.replaceChildren(wrap);
  if (!dialog.open) dialog.showModal();
}
export function closePicker() {if (dialog.open) dialog.close();}
export function showDocumentPicker({title,columns,load,selected,onPick,optional=false,create,multiple=false,categories=[],selectedItem,onTable}) {
  let page=1;
  let chosen=selected==null||selected===''?null:String(selected);
  let selectedRow=null;
  let category='';
  const selectedRows=new Map();
  if (multiple&&selectedItem) selectedRows.set(String(selectedItem.id),selectedItem);
  let version=0;
  let timer;
  const search=make('input');
  search.type='search';
  search.placeholder='搜索编号、名称或拼音码';
  search.setAttribute('aria-label',search.placeholder);
  const main=make('div',null,'modal-main picker-main');
  const content=make('div',null,'picker-results');
  const pagination=make('div',null,'paging');
  const footer=make('footer',null,'modal-foot');
  let saving=false;
  const isActive=()=>dialog.open&&dialog.contains(main);
  async function choose(row) {
    if (saving) return;
    saving=true;
    ok.disabled=true;
    loading.hidden=false;
    main.inert=true;
    try {
      await onPick(row,isActive);
      if (isActive()) closePicker();
    } catch (problem) {
      if (dialog.contains(main)) showSystemPrompt(problem);
    } finally {
      saving=false;
      loading.hidden=true;
      main.inert=false;
      updateConfirmation();
    }
  }
  const ok=button('确认',()=>choose(multiple?[...selectedRows.values()]:selectedRow),'primary');
  const loading=make('span','正在加载所选资料…','picker-count');
  loading.setAttribute('role','status');
  loading.hidden=true;
  footer.prepend(loading);
  const count=make('span',null,'picker-count');
  count.setAttribute('aria-live','polite');
  function updateConfirmation() {
    ok.disabled=saving||!(multiple?selectedRows.size:selectedRow);
    if (multiple) count.textContent='已勾选 '+selectedRows.size+' 条';
  }
  updateConfirmation();
  if (optional&&chosen!==null) footer.append(button('清除选择',()=>choose(multiple?[]:null)));
  footer.append(ok,button('取消',closePicker));
  const results=make('div',null,'picker-workspace');
  const toolbar=make('div',null,'picker-toolbar');
  toolbar.append(search,button('查询',()=>{page=1;clearTimeout(timer);render();}));
  const status=make('div',null,'picker-status');
  status.append(count,pagination);
  results.append(toolbar,content,status);
  main.append(results);
  dialog.classList.toggle('product-picker',multiple);
  if (multiple) {
    const side=make('aside',null,'picker-categories');
    const filter=make('input');
    filter.type='search';
    filter.placeholder='搜索商品分类';
    filter.setAttribute('aria-label',filter.placeholder);
    const tree=make('div',null,'picker-tree');
    const children=new Map();
    for (const path of categories) {
      const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
      if (!children.has(parent)) children.set(parent,[]);
      children.get(parent).push(path);
    }
    const expanded=new Set();
    function refreshTree() {
      const term=filter.value.trim().toLowerCase();
      function item(path,label) {
        const chooseCategory=button(label,()=>{
          category=path;
          page=1;
          refreshTree();
          render();
        },'picker-category');
        chooseCategory.setAttribute('aria-pressed',String(category===path));
        return chooseCategory;
      }
      function branch(parent) {
        const list=make('ul');
        for (const path of children.get(parent)||[]) {
          if (term&&!path.toLowerCase().includes(term)&&!categories.some(child=>child.startsWith(path+'/')&&child.toLowerCase().includes(term))) continue;
          const entry=make('li');
          const line=make('div',null,'picker-category-line');
          if (children.has(path)) {
            const open=Boolean(term)||expanded.has(path);
            const toggle=button(open?'▾':'▸',()=>{
              if (expanded.has(path)) expanded.delete(path);
              else expanded.add(path);
              refreshTree();
            },'picker-category-toggle');
            toggle.setAttribute('aria-label',(open?'折叠':'展开')+path);
            toggle.setAttribute('aria-expanded',String(open));
            line.append(toggle,item(path,path.split('/').at(-1)));
            entry.append(line);
            if (open) entry.append(branch(path));
          } else {
            line.append(make('span',null,'picker-category-toggle'),item(path,path.split('/').at(-1)));
            entry.append(line);
          }
          list.append(entry);
        }
        return list;
      }
      tree.replaceChildren(item('','全部分类'),branch(''),item('/','未分类'));
    }
    filter.addEventListener('input',refreshTree);
    refreshTree();
    side.append(filter,tree);
    main.prepend(side);
  }
  layout(title,main,footer);
  search.focus();
  async function render() {
    const request=++version;
    const keyword=search.value.trim();
    content.replaceChildren(make('p','正在查询…','empty'));
    pagination.replaceChildren();
    selectedRow=null;
    updateConfirmation();
    try {
      const data=await load(keyword,page,category);
      if (request!==version||!isActive()) return;
      if (!data.rows.length) {
        const blank=make('div',null,'picker-empty');
        blank.append(make('p',keyword?'未找到符合条件的结果':create?'暂无数据,请先在资料中维护':'暂无可选数据'));
        if (create&&!keyword) blank.append(button('新增'+create.label,()=>{
          const form=make('form',null,'picker-create');
          form.noValidate=true;
          const code=make('input');
          const name=make('input');
          for (const [label,control] of [['编号',code],['名称',name]]) {
            const group=make('label',label,'field');
            control.required=true;
            control.maxLength=label==='编号'?64:160;
            group.append(control);
            form.append(group);
          }
          const submit=make('button','保存资料','btn primary');
          form.append(submit);
          form.addEventListener('submit',async event=>{
            event.preventDefault();
            submit.disabled=true;
                    try {
              await create.save({code:code.value,name:name.value});
              if (dialog.open&&dialog.contains(main)) await render();
            } catch (problem) {showSystemPrompt(problem);}
            finally {submit.disabled=false;}
          });
          blank.replaceChildren(form);
          code.focus();
        }));
        content.replaceChildren(blank);
      } else {
        const result=make('table');
        const header=result.createTHead().insertRow();
        header.append(make('th','行号','picker-index'));
        const checkboxes=[];
        let selectPage;
        if (multiple) {
          const selection=make('th',null,'picker-check');
          selectPage=make('input');
          selectPage.type='checkbox';
          selectPage.setAttribute('aria-label','全选本页商品');
          selection.append(selectPage);
          header.append(selection);
        }
        for (const col of columns) header.append(make('th',col));
        const body=result.createTBody();
        for (const [index,row] of data.rows.entries()) {
          const tr=body.insertRow();
          tr.dataset.pickerRow='';
          tr.insertCell().textContent=(page-1)*25+index+1;
          const id=String(row.id);
          if (multiple) {
            const checkbox=make('input');
            checkbox.type='checkbox';
            checkbox.checked=selectedRows.has(id);
            checkbox.setAttribute('aria-label','勾选 '+row.cells.slice(0,2).join(' '));
            const cell=tr.insertCell();
            cell.className='picker-check';
            cell.append(checkbox);
            for (const value of row.cells) tr.insertCell().textContent=value??'';
            const updateRow=()=>{
              if (checkbox.checked) selectedRows.set(id,row);
              else selectedRows.delete(id);
              tr.classList.toggle('picked',checkbox.checked);
              updateConfirmation();
            };
            tr.classList.toggle('picked',checkbox.checked);
            checkboxes.push({checkbox,updateRow});
            checkbox.addEventListener('change',()=>{
              updateRow();
              syncPageSelection();
            });
            tr.addEventListener('click',event=>{if (event.target!==checkbox) checkbox.click();});
          } else {
            const select=button(row.cells[0],()=>selectRow(),'picker-row-button');
            select.setAttribute('aria-label','选择 '+row.cells.slice(0,2).join(' '));
            tr.insertCell().append(select);
            for (const value of row.cells.slice(1)) tr.insertCell().textContent=value??'';
            const selectRow=()=>{
              chosen=id;
              selectedRow=row;
              updateConfirmation();
              for (const other of body.rows) {
                other.classList.toggle('picked',other===tr);
                other.querySelector('button').setAttribute('aria-pressed',String(other===tr));
              }
            };
            tr.addEventListener('click',event=>{if (event.target!==select) selectRow();});
            tr.addEventListener('dblclick',()=>choose(row));
            select.setAttribute('aria-pressed','false');
            if (id===chosen) selectRow();
          }
        }
        function syncPageSelection() {
          const checked=checkboxes.filter(({checkbox})=>checkbox.checked).length;
          selectPage.checked=checked===checkboxes.length;
          selectPage.indeterminate=checked>0&&checked<checkboxes.length;
        }
        if (multiple) {
          syncPageSelection();
          selectPage.addEventListener('change',()=>{
            const checked=selectPage.checked;
            for (const {checkbox,updateRow} of checkboxes) {
              checkbox.checked=checked;
              updateRow();
            }
          });
        }
        content.replaceChildren(result);
        onTable?.(result);
      }
      const pages=Math.max(1,Math.ceil(data.count/25));
      const back=button('上一页',()=>{page--;render();});
      const next=button('下一页',()=>{page++;render();});
      back.disabled=page<=1;
      next.disabled=page>=pages;
      pagination.append(make('span','共 '+data.count+' 条 · 第 '+page+' / '+pages+' 页'),back,next);
    } catch (problem) {
      if (request===version&&dialog.contains(main)) {content.replaceChildren(make('p','加载失败','empty'));showSystemPrompt(problem);}
    }
  }
  search.addEventListener('input',()=>{
    page=1;
    chosen=null;
    selectedRow=null;
    updateConfirmation();
    content.replaceChildren(make('p','正在查询…','empty'));
    ++version;
    clearTimeout(timer);
    timer=setTimeout(render,120);
  });
  search.addEventListener('keydown',event=>{
    if (event.key!=='Enter') return;
    event.preventDefault();
    clearTimeout(timer);
    render();
  });
  render();
}
