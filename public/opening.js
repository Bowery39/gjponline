const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>(Number(value||0)/100).toFixed(2);
const titles={stock:'期初库存商品',partners:'期初应收应付',accounts:'期初收支账户',balance:'期初资产负债表',control:'开账'};
const keys={stock:['quantity','price'],partners:['ar','ap','advanceIn','advanceOut'],accounts:['cash'],balance:['amount']};
const headers={stock:['商品编号','商品名称','单位','期初数量','成本单价','期初金额','批号','生产日期'],
  partners:['单位编号','单位名称','类型','期初应收','期初应付','期初预收','期初预付'],
  accounts:['账户编号','账户名称','期初余额'],balance:['科目编码','科目名称','类别','期初余额']};

export async function renderOpening(host,kind,{api,showError,showSystemPrompt,openRoute,onSaved}) {
  let warehouse='',partnerType='',data,busy=false;
  const alive=()=>host.isConnected;
  const invoke=action=>async event=>{
    event?.preventDefault();
    if (busy) return;
    busy=true;
    try {await action(event);}
    catch(error) {await showError(error);}
    finally {busy=false;}
  };
  const shownRows=()=>kind==='partners'&&partnerType?data.rows.filter(row=>row.data.type===partnerType||row.data.type==='both'):data.rows||[];
  const read=()=>{
    for (const control of host.querySelectorAll('[data-opening-key]')) {
      const row=data.rows.find(row=>row.id===Number(control.dataset.id));
      row[control.dataset.openingKey]=control.value;
    }
  };
  const payload=()=>({
    warehouse,revision:data.state.revision,rows:shownRows().filter(row=>!row.automatic).map(row=>{
      const values={id:row.id};
      for (const key of keys[kind]||[]) values[key]=row[key]??'';
      if (kind==='stock') {values.batch=row.batch||'';values.production=row.production||'';}
      return values;
    })
  });
  const compute=()=>{
    read();
    const totals={};
    for (const row of shownRows()) {
      for (const key of keys[kind]||[]) totals[key]=(totals[key]||0)+Number(row[key]||0);
      if (kind==='stock') {
        const amount=Math.round(Number(row.quantity||0)*Number(row.price||0)*100);
        const cell=host.querySelector('[data-row-amount="'+row.id+'"]');
        if (cell) cell.textContent=money(amount);
        totals.amount=(totals.amount||0)+amount;
      }
    }
    for (const node of host.querySelectorAll('[data-opening-total]')) {
      const key=node.dataset.openingTotal;
      node.textContent=kind==='stock'?(key==='quantity'?Number((totals[key]||0).toFixed(4)):money(totals[key])):(totals[key]||0).toFixed(2);
    }
  };
  const control=(row,key,opts='')=>'<input data-id="'+row.id+'" data-opening-key="'+key+'" aria-label="'+escape(row.name+' '+key)+
    '" value="'+escape(row[key]??'')+'" '+opts+(data.state.opened||row.automatic?' disabled':'')+'>';
  const draw=()=>{
    if (!alive()) return;
    const locked=data.state.opened;
    const selectWarehouse='<label>仓库 <select id="opening-warehouse"><option value="">请先选择仓库</option>'+
      data.warehouses.map(row=>'<option value="'+row.id+'"'+(String(row.id)===warehouse?' selected':'')+'>'+escape(row.code+' '+row.name)+'</option>').join('')+'</select></label>';
    host.innerHTML='<h1>'+titles[kind]+'</h1><section class="card opening-panel"><div class="toolbar"><strong>'+
      (locked?'已开账':'未开账')+'</strong><span>建账日期 '+escape(data.state.date)+'</span>'+
      (kind==='stock'?selectWarehouse:'')+
      (kind==='partners'?'<label>单位类型 <select id="opening-partner-type"><option value="">全部</option><option value="customer"'+(partnerType==='customer'?' selected':'')+'>客户</option><option value="supplier"'+(partnerType==='supplier'?' selected':'')+'>供应商</option></select></label>':'')+
      (kind==='control'?'':'<button class="btn" id="opening-refresh">刷新</button>')+
      (!locked&&kind!=='control'?'<button class="btn primary" id="opening-save"'+(kind==='stock'&&!warehouse?' disabled':'')+'>保存期初</button>':'')+
      (!locked&&kind==='stock'?'<button class="btn" id="opening-append">期初录入单（追加）</button>':'')+
      (['stock','partners'].includes(kind)?'<a class="btn" href="/api/opening/template?kind='+kind+'" data-act="download-file">下载 Excel 模板</a>'+
        (!locked?'<label class="btn">导入 Excel<input type="file" id="opening-file" accept=".xlsx" hidden></label>':''):'')+
      '</div><div id="opening-content"></div></section>';
    const content=host.querySelector('#opening-content');
    if (kind==='control'||kind==='balance') {
      const totals=data.totals;
      content.innerHTML='<div class="toolbar"><strong>资产合计 ¥'+money(totals.asset)+'</strong><strong>负债合计 ¥'+money(totals.liability)+
        '</strong><strong>所有者权益合计 ¥'+money(totals.equity)+'</strong><span>'+ (data.balanced?'已平衡':'未平衡，差额 ¥'+money(totals.difference))+'</span></div>';
      if (kind==='control') {
        content.innerHTML+='<form novalidate id="opening-control-form" class="toolbar">'+
          '<label>建账日期 <input type="date" name="date" value="'+escape(data.state.date)+'"'+(locked?' disabled':'')+'></label>'+
          (!locked?'<label><input type="checkbox" name="autoCapital"> 将差额自动计入实收资本</label>':'')+
          '<button class="btn '+(locked?'':'primary')+'" type="submit">'+(locked?'反开账':'开账')+'</button></form>';
      }
    }
    if (kind!=='control'&&(kind!=='stock'||warehouse)) {
      const rows=shownRows();
      const body=rows.map(row=>{
        const values=[escape(row.code),escape(row.name)];
        if (kind==='stock') values.push(escape(row.data.unit),
          control(row,'quantity','type="number" min="0" step="0.0001"'),control(row,'price','type="number" min="0" step="any"'),
          '<output data-row-amount="'+row.id+'">'+money(row.amount)+'</output>',
          row.data.batch||row.data.method==='individual'?control(row,'batch','type="text"'):'',
          row.data.batch?control(row,'production','type="date"'):'');
        if (kind==='partners') values.push(row.data.type==='both'?'客户/供应商':row.data.type==='supplier'?'供应商':'客户',
          ...keys.partners.map(key=>control(row,key,'type="number" min="0" step="0.01"')));
        if (kind==='accounts') values.push(control(row,'cash','type="number" step="0.01"'));
        if (kind==='balance') values.push(({asset:'资产',liability:'负债',equity:'所有者权益'})[row.category],
          control(row,'amount','type="number" step="0.01"'));
        return '<tr>'+values.map(value=>'<td>'+value+'</td>').join('')+'</tr>';
      }).join('');
      const total=kind==='stock'?['合计','','','<output data-opening-total="quantity"></output>','','<output data-opening-total="amount"></output>','','']:
        kind==='partners'?['合计','','',...keys.partners.map(key=>'<output data-opening-total="'+key+'"></output>')]:
        kind==='accounts'?['合计','','<output data-opening-total="cash"></output>']:['合计','','',''];
      content.innerHTML+='<div class="scroll-table"><table class="master-grid opening-grid"><thead><tr>'+headers[kind].map(label=>'<th>'+label+'</th>').join('')+
        '</tr></thead><tbody>'+body+'</tbody><tfoot><tr>'+total.map(value=>'<td>'+value+'</td>').join('')+'</tr></tfoot></table></div>';
    }
    if (kind==='stock'&&!warehouse) content.innerHTML='<p class="note">先选择仓库，再录入该仓库商品的期初数量和成本。</p>';
    host.querySelector('#opening-warehouse')?.addEventListener('change',invoke(async event=>{
      warehouse=event.target.value;await load();
    }));
    host.querySelector('#opening-partner-type')?.addEventListener('change',event=>{read();partnerType=event.target.value;draw();});
    host.querySelector('#opening-refresh')?.addEventListener('click',invoke(load));
    host.querySelector('#opening-save')?.addEventListener('click',invoke(async()=>{
      read();
      await api('/api/opening/'+kind,payload());
      onSaved();
      await load();
      await showSystemPrompt('期初数据已保存');
    }));
    host.querySelector('#opening-append')?.addEventListener('click',()=>openRoute('n:openingStock'));
    host.querySelector('#opening-control-form')?.addEventListener('submit',invoke(async event=>{
      const form=event.target;
      if (!await showSystemPrompt(locked?'确认反开账？期初将恢复可编辑。':'确认开账？开账后期初数据将只读。',{cancelLabel:'取消'})) return;
      await api('/api/opening/control',{revision:data.state.revision,action:locked?'close':'open',
        date:form.elements.date.value,autoCapital:form.elements.autoCapital?.checked});
      onSaved();
      await load();
      await showSystemPrompt(locked?'已反开账':'已开账');
    }));
    host.querySelector('#opening-file')?.addEventListener('change',invoke(async event=>{
      const file=event.target.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.xlsx')||file.size>5_000_000) throw Error('请选择不超过 5 MB 的 Excel 文件');
      const bytes=new Uint8Array(await file.arrayBuffer());
      let binary='';
      for (const byte of bytes) binary+=String.fromCharCode(byte);
      const result=await api('/api/opening/import',{kind,revision:data.state.revision,workbook:btoa(binary)});
      onSaved();
      await load();
      await showSystemPrompt('已导入 '+result.count+' 行期初数据');
    }));
    content.addEventListener('input',()=>{
      compute();
      if (kind==='balance') {
        const totals={asset:0,liability:0,equity:0};
        for (const row of data.rows) totals[row.category]+=Math.round(Number(row.amount||0)*100);
        const difference=totals.asset-totals.liability-totals.equity;
        const summary=content.querySelector('.toolbar');
        if (summary) summary.innerHTML='<strong>资产合计 ¥'+money(totals.asset)+'</strong><strong>负债合计 ¥'+money(totals.liability)+
          '</strong><strong>所有者权益合计 ¥'+money(totals.equity)+'</strong><span>'+(difference?'未平衡，差额 ¥'+money(difference):'已平衡')+'</span>';
      }
    });
    compute();
  };
  async function load() {
    data=await api('/api/opening/'+(kind==='control'?'balance':kind)+(warehouse?'?warehouse='+warehouse:''));
    if (['partners','accounts','balance'].includes(kind)) for (const row of data.rows) {
      for (const key of keys[kind]||[]) row[key]=money(row[key]);
    }
    draw();
  }
  host.innerHTML='<p>正在加载期初数据…</p>';
  await load();
}
