const dialog=document.querySelector('#system-prompt');
const cancel=dialog.querySelector('.system-prompt-cancel');
const confirm=dialog.querySelector('.system-prompt-confirm');
const body=dialog.querySelector('#system-prompt-message');
const queue=[];
let active=false;

export function chineseMessage(problem) {
  const message=String(problem?.message??problem??'').trim();
  return /[\u3400-\u9FFF]/u.test(message)?message:'操作未完成，请重试。';
}

function openNext() {
  if (active||!queue.length) return;
  active=true;
  const {message,cancelLabel,confirmLabel,resolve}=queue.shift();
  cancel.hidden=!cancelLabel;
  cancel.textContent=cancelLabel;
  confirm.textContent=confirmLabel;
  body.textContent=chineseMessage(message);
  dialog.returnValue='';
  dialog.addEventListener('close',()=>{
    active=false;
    resolve(dialog.returnValue==='confirm');
    queueMicrotask(openNext);
  },{once:true});
  dialog.showModal();
  (cancelLabel?cancel:confirm).focus();
}

export function showSystemPrompt(message,{cancelLabel='',confirmLabel='确定'}={}) {
  return new Promise(resolve=>{
    queue.push({message,cancelLabel,confirmLabel,resolve});
    openNext();
  });
}

export function clearSystemPrompts() {
  for (const prompt of queue.splice(0)) prompt.resolve(false);
  if (dialog.open) dialog.close('cancel');
}

function validationMessage(control) {
  const label=[...control.labels||[]].map(node=>node.querySelector('span')?.textContent||node.textContent).join(' ')
    .replace(/\s*\*\s*$/,'').trim();
  const title=control.getAttribute('aria-label')||label||'此字段';
  const {validity}=control;
  if (isMissing(control)) {
    const verb=control.matches('select,input[type=file],input[type=checkbox],input[type=radio]')?'请选择':'请填写';
    return verb+title+'。';
  }
  if (validity.tooShort) return title+'至少需要 '+control.minLength+' 个字符，当前已输入 '+control.value.length+' 个。';
  if (validity.tooLong) return title+'最多允许 '+control.maxLength+' 个字符。';
  if (validity.badInput) return '请为'+title+'输入有效的数值或日期。';
  if (validity.rangeUnderflow) return title+'不能小于 '+control.min+'。';
  if (validity.rangeOverflow) return title+'不能大于 '+control.max+'。';
  if (validity.stepMismatch) return '请检查'+title+'的精度，允许的间隔为 '+(control.getAttribute('step')||'1')+'。';
  if (validity.customError) return chineseMessage(control.validationMessage);
  return '请检查'+title+'的格式。';
}

function isMissing(control) {
  return control.validity.valueMissing ||
    (control.required && control.matches('textarea,input[type=text],input:not([type]),input[type=search]') && !control.value.trim());
}

export function validateForm(form) {
  if (!form) return false;
  const control=[...form.elements].find(field=>field.willValidate && (!field.validity.valid || isMissing(field)));
  if (!control) return true;
  void showSystemPrompt(validationMessage(control)).then(()=>{
    if (!control.isConnected||dialog.open) return;
    for (let parent=control.parentElement;parent;parent=parent.parentElement) {
      if (parent.tagName==='DETAILS') parent.open=true;
    }
    control.focus();
  });
  return false;
}

document.addEventListener('submit',event=>{
  const form=event.target;
  if (!(form instanceof HTMLFormElement)||form.method==='dialog'||validateForm(form)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
},true);
