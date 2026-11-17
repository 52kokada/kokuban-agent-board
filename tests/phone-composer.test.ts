import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import { client, shell } from '../src/phone/shell.js';
function source(...names:string[]){return names.map(name=>{const line=client.split('\n').find(s=>s.startsWith('function '+name+'(')||s.startsWith('async function '+name+'('));assert.ok(line,name);return line;}).join('\n');}

test('board delivery scaffolding is hidden without hiding ordinary messages',()=>{
 const c:any=createContext({});new Script(source('isBoardNotice')).runInContext(c);
 for(const text of ['<kokuban-message from="Willow">Task</kokuban-message>','[kokuban] Message from Chief','Pause for your human only for deleting, deploying, paying, publishing or sending outside this PC.']){c.e={kind:'message',text};assert.equal(new Script('isBoardNotice(e)').runInContext(c),true);}
 c.e={kind:'message',text:'Please review the deployment plan.'};assert.equal(new Script('isBoardNotice(e)').runInContext(c),false);
 assert.equal(client.includes('Activity ?'),false);
});

test('empty composer shows mic, staged files or text show send, recording replaces pill',()=>{
 const nodes:any=Object.fromEntries(['compose','message','attach','record','send','composePill','recordPill'].map(id=>[id,{value:'',classList:{toggle(){}},setAttribute(){}}]));let d:any={files:[],pendingUploads:[],voiceJobs:[]};
 const c:any=createContext({$: (id:string)=>nodes[id],wantsChat:()=>true,draft:()=>d,pending:()=>false,refreshBusy:false,uploadBusy:false,micPending:false,recording:null,selected:{phase:'idle'}});new Script(source('updateComposer')).runInContext(c);
 const run=()=>new Script('updateComposer()').runInContext(c);run();assert.equal(nodes.send.hidden,true);assert.equal(nodes.record.hidden,false);
 nodes.message.value='Hello';run();assert.equal(nodes.send.hidden,false);assert.equal(nodes.record.hidden,true);
 nodes.message.value='';d.files.push({id:'photo'});run();assert.equal(nodes.send.hidden,false);c.recording={};run();assert.equal(nodes.composePill.hidden,true);assert.equal(nodes.recordPill.hidden,false);assert.equal(nodes.send.disabled,true);
 assert.ok(shell.includes('.composing .tabs{display:none}'));assert.ok(shell.includes('font-size:16px'));
});

test('staging uploads never sends and retains failed paste data for retry',async()=>{
 const d:any={files:[],pendingUploads:[]},file={name:'paste.png'},calls:any[]=[];const c:any=createContext({selected:{id:'s'},refreshBusy:false,uploadBusy:false,saveDraft(){},updateComposer(){},draft:()=>d,attachRecording:async(f:any,id:any,job:any)=>{calls.push({f,id,job});throw Error('Offline');},problem(){}});new Script(source('stageFiles')).runInContext(c);c.files=[file];await new Script('stageFiles(files)').runInContext(c);
 assert.equal(calls.length,1);assert.equal(calls[0].job.voiceNote,false);assert.equal(d.pendingUploads[0].file,file);assert.equal(c.uploadBusy,false);
 assert.ok(client.includes("addEventListener('paste'"));assert.ok(client.includes("e.clipboardData?.files"));
});

test('composer focus disables every other field and blur restores their exact state',()=>{
 const field=(disabled=false):any=>({disabled,tab: null,matches:()=>true,getAttribute(){return this.tab;},setAttribute(_k:string,v:any){this.tab=v;},removeAttribute(){this.tab=null;}});
 const message=field(),file=field(),setting=field(true),reply=field();reply.tab='2';const fields=[message,file,setting,reply],listeners:any={},classes=new Set();const document:any={activeElement:message,body:{classList:{add:(x:string)=>classes.add(x),remove:(x:string)=>classes.delete(x)}},querySelectorAll:()=>fields,addEventListener:(k:string,f:any)=>listeners[k]=f};
 const c:any=createContext({document,$:()=>message,queueMicrotask:(f:any)=>f()});const a=client.indexOf('let focusedFields=[];'),b=client.indexOf('// File selection',a);new Script(client.slice(a,b)).runInContext(c);
 listeners.focusin({target:message});assert.ok(classes.has('composing'));assert.equal(message.disabled,false);assert.ok([file,setting,reply].every(n=>n.disabled));
 document.activeElement={matches:()=>false};listeners.focusout();assert.equal(classes.has('composing'),false);assert.equal(file.disabled,false);assert.equal(setting.disabled,true);assert.equal(reply.disabled,false);assert.equal(reply.tab,'2');
});

test('real touch listeners distinguish vertical scroll, snap, full swipe and long press',()=>{
 class Node{children:any[]=[];listeners:any={};style:any={setProperty(){}};attrs:any={};tabIndex=0;offset=0;suppress=false;constructor(public tag:string,public className:string=''){}append(...items:any[]){this.children.push(...items);}setAttribute(k:string,v:any){this.attrs[k]=v;}addEventListener(k:string,f:any){this.listeners[k]=f;}getBoundingClientRect(){return{width:350};}querySelectorAll(){return this.children;} }
 let timer:any,menu=0,clicks=0;const snaps:any[]=[];const c:any=createContext({el:(tag:string,cl:string)=>new Node(tag,cl),clearTimeout(){timer=null;},setTimeout(f:any,ms:number){if(ms===450)timer=f;},cancelAnimationFrame(){},navigator:{vibrate(){}},setSwipe:(w:any,t:number)=>{snaps.push(t);w.target=t;w.offset=t;}});new Script(source('makeSwipe')).runInContext(c);c.content=new Node('div');c.buttons=[{tabIndex:0,click(){clicks++;}}];c.menu=()=>menu++;new Script('w=makeSwipe(content,buttons,menu)').runInContext(c);const w=c.w,front=w.front,target={closest(){return false;}};
 const touch=(kind:string,x:number,y:number,t:number)=>{let prevented=false;front.listeners[kind]({target,touches:kind==='touchend'?[]:[{clientX:x,clientY:y}],timeStamp:t,preventDefault(){prevented=true;}});return prevented;};
 touch('touchstart',300,20,0);assert.equal(touch('touchmove',297,70,40),false);touch('touchend',297,70,60);assert.equal(clicks,0);assert.equal(menu,0);
 touch('touchstart',300,20,100);assert.equal(touch('touchmove',230,22,400),true);touch('touchend',230,22,500);assert.equal(snaps.at(-1),-96);assert.equal(clicks,0);
 touch('touchstart',300,20,600);touch('touchmove',20,22,900);touch('touchend',20,22,1000);assert.equal(clicks,1);assert.equal(snaps.at(-1),0);
 touch('touchstart',200,20,1100);assert.ok(timer);timer();touch('touchend',200,20,1600);assert.equal(menu,1);assert.equal(clicks,1);assert.equal(w.suppress,true);
 let stopped=false;front.listeners.click({preventDefault(){stopped=true;},stopPropagation(){}});assert.equal(stopped,true);
 touch('touchstart',200,20,1700);touch('touchmove',197,70,1800);assert.equal(timer,null);
});

test('card details are closed while title, link and answer controls remain outside',()=>{
 const n=(tag:string,cls='',text=''):any=>({tag,cls,textContent:text,children:[],append(...v:any[]){this.children.push(...v);}});const c:any=createContext({el:n,safeCardLink:(url:string)=>n('a','',url)});new Script(source('imageName','cardContent')).runInContext(c);c.item={body:'Details body',links:['https://example.com'],steps:[{text:'Follow-up'}],files:['Paper.docx'],thread:'card:1'};c.article=n('article');new Script('cardContent(item,article)').runInContext(c);const [links,details]=c.article.children;assert.equal(links.cls,'card-links');assert.equal(details.tag,'details');assert.equal(details.open,undefined);assert.equal(details.children[0].textContent,'Details');assert.equal(details.children[1].textContent,'Details body');assert.ok(details.children.some((v:any)=>v.tag==='a'&&v.download==='Paper.docx'));
});
