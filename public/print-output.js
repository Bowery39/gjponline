import {escapePrint,renderPrintPages,validatePrintTemplate} from './print-layout.js';

// The print document deliberately does not load app.css: legacy application print
// selectors must never hide template pages or change their measured geometry.
export const templatePrintCss=`
html,body{margin:0;padding:0;background:white;color:black}
*{box-sizing:border-box}
.pt-page{position:relative;overflow:hidden;background:white;break-inside:avoid;page-break-inside:avoid;break-after:page;page-break-after:always;print-color-adjust:exact;-webkit-print-color-adjust:exact}
.pt-page:last-child{break-after:auto;page-break-after:auto}
.pt-element{position:absolute;overflow:hidden;line-height:1.2}
.pt-element img{width:100%;height:100%;object-fit:contain}
.pt-element svg{width:100%;height:100%;display:block}
.pt-body{position:absolute;table-layout:fixed;border-collapse:collapse;font:9pt "Microsoft YaHei",sans-serif}
.pt-body th,.pt-body td{border:0.2mm solid #333;padding:0.5mm;white-space:normal;word-break:break-word;overflow:hidden;line-height:1.1}
.pt-body th{text-align:left;position:static;background:white;color:black;height:var(--pt-head)}
.pt-body td,.pt-body tr{height:var(--pt-row)}
.pt-body .pt-total td{background:#fffce7;font-weight:700}
.pt-cell-content{height:calc(var(--pt-row) - 1mm);max-height:calc(var(--pt-row) - 1mm);overflow:hidden}
`;
export function buildPrintDocument(documents) {
  if(!Array.isArray(documents)||!documents.length)throw Error('没有可打印的单据');
  let rules='',pages='';
  documents.forEach(({template,data},index)=>{
    validatePrintTemplate(template);
    const {width,height,margin:m}=template.paper;
    const rule='size:'+width+'mm '+height+'mm;margin:'+m.top+'mm '+m.right+'mm '+m.bottom+'mm '+m.left+'mm;';
    if(index===0)rules+='@page{'+rule+'}';
    rules+='@page ptJob'+index+'{'+rule+'}.pt-sheet-'+index+'{page:ptJob'+index+'}';
    pages+=renderPrintPages(template,data,{preview:false,pageMargins:true})
      .replaceAll('class="pt-page"','class="pt-page pt-sheet-'+index+'"');
  });
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>'+escapePrint(documents.map(row=>row.data.fields.number).join('、'))+
    '</title><style>'+templatePrintCss+rules+'</style></head><body>'+pages+'</body></html>';
}
export async function printTemplateDocuments(documents,{ownerDocument=globalThis.document,onReady=async()=>{}}={}) {
  const html=buildPrintDocument(documents);
  const frame=ownerDocument.createElement('iframe');
  frame.className='pt-print-frame';frame.title='模板打印文档';frame.setAttribute('aria-hidden','true');
  // Keep the browsing context renderable, but outside the application viewport.
  frame.style.cssText='position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;';
  try {
    await new Promise((resolve,reject)=>{
      frame.onload=resolve;frame.onerror=()=>reject(Error('打印文档加载失败'));
      frame.srcdoc=html;ownerDocument.body.append(frame);
    });
    const target=frame.contentWindow,document=frame.contentDocument;
    if(!target||!document)throw Error('无法打开打印文档');
    await document.fonts?.ready;
    await Promise.all([...document.images].map(async image=>{
      if(image.decode)await image.decode();
      else if(!image.complete||!image.naturalWidth)throw Error('打印图片尚未加载完成');
    }));
    await onReady();
    target.addEventListener('afterprint',()=>frame.remove(),{once:true});
    target.focus();target.print();
    // Some browsers do not deliver afterprint for a cancelled print dialog.
    const timer=setTimeout(()=>frame.remove(),60_000);timer.unref?.();
  } catch(error){frame.remove();throw error;}
}
