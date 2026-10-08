const assert = require('node:assert/strict');
const fs = require('node:fs');
const {webcrypto, createHmac, createHash} = require('node:crypto');
global.crypto = webcrypto;
(async () => {
  const source=fs.readFileSync(require('node:path').join(__dirname,'../examples/render-design-chat-client.js'),'utf8');
  const {createSteveChatClient}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const secret='test-only-pairing-secret';let reads=0;let calls=0;
  global.fetch=async(url,options)=>{
    calls++;
    const path=new URL(url).pathname,h=options.headers;
    const signed=['POST',path,h['X-Steve-Timestamp'],h['X-Steve-Nonce'],h['X-Request-Id'],createHash('sha256').update(options.body).digest('hex')].join('\n');
    assert.equal(h['X-Steve-Signature'],createHmac('sha256',secret).update(signed).digest('hex'));
    if(path==='/v1/submissions')return {ok:true,json:async()=>({accepted:true})};
    const body=JSON.parse(options.body);assert.equal(body.requestId,'cad-1');
    reads++;
    if(reads===1){assert.equal(body.after,0);return {ok:true,json:async()=>({cursor:2,reset:true,snapshot:{requestId:'cad-1',phase:'running',messages:[{id:'answer',role:'assistant',text:'Hel'}]},events:[]})};}
    assert.equal(body.after,2);
    return {ok:true,json:async()=>({cursor:4,reset:false,snapshot:null,events:[
      {cursor:3,requestId:'cad-1',type:'status',phase:'completed'},
      {cursor:4,requestId:'cad-1',type:'message',message:{id:'answer',role:'assistant',text:'Hello'}}]})};
  };
  const client=createSteveChatClient({secret});
  await client.submit('cad-1',{prompt:'A bracket'});
  const updates=[];await client.watch('cad-1',{onUpdate:s=>updates.push(s)});
  assert.equal(updates.length,2);assert.equal(updates[0].messages[0].text,'Hel');
  assert.equal(updates[1].messages.length,1);assert.equal(updates[1].messages[0].text,'Hello');
  assert.equal(updates[1].phase,'completed');assert.equal(calls,3);
  global.fetch=async()=>({ok:false,status:401,json:async()=>({error:{code:'not_paired',message:'Pair again'}})});
  await assert.rejects(client.watch('cad-1',{onUpdate:()=>{}}),e=>e.code==='not_paired');
  console.log('Render client passed: HMAC, cursor replay, message replacement, final text, and pairing failure.');
})().catch(error=>{console.error(error);process.exitCode=1;});
