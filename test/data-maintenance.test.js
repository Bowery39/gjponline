import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { saveDocument, transition } from '../src/engine.js';

test('备份可下载且完整；重建要求管理员确认，保留重建前库存快照',async t=>{
  const root=mkdtempSync(join(tmpdir(),'gjp-maintenance-test-'));
  const path=join(root,'current.sqlite');
  const password='Test-Inventory-2026';
  const {server,store}=createApp({path,password,demo:true});
  store.run('DELETE FROM opening_state');
  t.after(()=>{
    store.db.close();
    rmSync(root,{recursive:true,force:true});
  });
  const call=(url,{cookie,data}={})=>new Promise((resolve,reject)=>{
    const req=Readable.from(data===undefined?[]:[Buffer.from(JSON.stringify(data))]);
    Object.assign(req,{url,method:data===undefined?'GET':'POST',
      headers:{cookie,'content-type':'application/json'},socket:{remoteAddress:'test'}});
    const chunks=[], headers=new Map();
    const res=new Writable({write(chunk,encoding,callback){chunks.push(chunk);callback();}});
    Object.assign(res,{headersSent:false,status:200,
      setHeader(key,value){headers.set(key.toLowerCase(),value);},
      writeHead(status,items){
        this.status=status;
        this.headersSent=true;
        for(const [key,value] of Object.entries(items)) this.setHeader(key,value);
      }
    });
    res.on('error',reject);
    res.on('finish',()=>resolve({status:res.status,headers,
      json:async()=>JSON.parse(Buffer.concat(chunks)),
      arrayBuffer:async()=>Buffer.concat(chunks)}));
    server.emit('request',req,res);
  });
  const signIn=async username=>{
    const response=await call('/api/login',{data:{username,password}});
    assert.equal(response.status,200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const cookie=await signIn('admin');
  const endpoint='/api/data-maintenance/';
  const request=(route,data)=>call(endpoint+route,{cookie,data});
  assert.equal((await call(endpoint+'backups')).status,401);
  assert.equal((await call('/api/master/users',{cookie,data:{name:'制单员',username:'buyer',password,role:'clerk'}})).status,200);
  const clerk=await signIn('buyer');
  for (const [route,data] of [['backups',undefined],['backups',{}],['preview',{groups:[]}],['rebuild',{}]])
    assert.equal((await call(endpoint+route,{cookie:clerk,data})).status,403);

  const admin=store.one("SELECT * FROM users WHERE username='admin'");
  const id=kind=>store.one('SELECT id FROM master WHERE kind=? LIMIT 1',kind).id;
  const create=()=>saveDocument(store,admin,{type:'purchase',warehouse:id('warehouses'),
    partner:store.one("SELECT id FROM master WHERE kind='partners' AND code='S-001'").id,lines:[{product:id('products'),quantity:3,price:4}]});
  let doc=create();
  for (const action of ['submit','approve','post']) doc=transition(store,admin,doc.id,action);
  const expectedQuantity=store.one('SELECT sum(quantity) quantity FROM stock').quantity;
  const manual=await request('backups',{});
  assert.equal(manual.status,201);
  const {filename}=await manual.json();
  const download=await request('backups/'+filename);
  assert.equal(download.status,200);
  assert.match(download.headers.get('content-disposition'),/attachment/);
  const copyFile=join(root,'download.sqlite');
  writeFileSync(copyFile,Buffer.from(await download.arrayBuffer()));
  const inspect=(file,docs)=>{
    const copy=new DatabaseSync(file,{readOnly:true});
    try {
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.equal(copy.prepare('SELECT count(*) count FROM documents').get().count,docs);
      assert.equal(copy.prepare('SELECT count(*) count FROM sessions').get().count,0);
      assert.equal(copy.prepare('SELECT sum(quantity) quantity FROM stock').get().quantity,expectedQuantity);
    } finally {copy.close();}
  };
  inspect(copyFile,1);
  const groups=['products'];
  const preview=()=>request('preview',{groups}).then(response=>response.json());
  const initial=await preview();
  assert.deepEqual(initial.selected,['products','bundles','prices']);
  const confirmation='重建数据';
  assert.equal((await request('rebuild',{groups,token:initial.token,confirmation:'取消'})).status,400);
  create();
  assert.equal((await request('rebuild',{groups,token:initial.token,confirmation})).status,409);
  assert.equal(store.one('SELECT count(*) count FROM documents').count,2);
  const reset=await request('rebuild',{groups,token:(await preview()).token,confirmation});
  assert.equal(reset.status,200);
  assert.match(reset.headers.get('set-cookie'),/Max-Age=0/);
  const {backup}=await reset.json();
  inspect(join(path+'.backups',backup.filename),2);
  for (const table of ['documents','lines','stock','movements','ledger'])
    assert.equal(store.one('SELECT count(*) count FROM '+table).count,0);
  assert.equal(store.one("SELECT count(*) count FROM master WHERE kind='products'").count,0);
  assert.ok(id('warehouses'));
  assert.ok(id('partners'));
  assert.equal((await request('backups')).status,401);
  assert.equal((await call(endpoint+'backups',{cookie:clerk})).status,401);
  const newCookie=await signIn('admin');
  assert.equal((await (await call(endpoint+'backups',{cookie:newCookie})).json()).backups.length,2);
});
