// The pre-push hook runs before refs are published, including inside embedded scripts.
import {execFile,execFileSync,spawn}from'node:child_process';
import fs from'node:fs';
import path from'node:path';
const hook=process.argv[2],args=process.argv.slice(3);
let refs='';for await(const part of process.stdin){refs+=part;if(hook==='pre-push'&&Buffer.byteLength(refs)>16000){process.stderr.write('Split this push into a smaller reviewable set of refs.\n');process.exit(1);}}
// Preserve pre-existing repository hooks under the original Git configuration.
const env={...process.env},n=Number(env.KOKUBAN_CHIEF_ORIGINAL_CONFIG_COUNT);
if(!Number.isSafeInteger(n)||n<0)process.exit(1);
env.GIT_CONFIG_COUNT=String(n);delete env[`GIT_CONFIG_KEY_${n}`];delete env[`GIT_CONFIG_VALUE_${n}`];
const git=env.KOKUBAN_CHIEF_REAL_GIT??'git';
try{
 const original=execFileSync(git,['rev-parse','--git-path',`hooks/${hook}`],{env,windowsHide:true,encoding:'utf8'}).trim();
 if(fs.existsSync(original)){
   // Git for Windows: git.exe is in cmd/ or mingw64/bin/ (whichever comes first on PATH); sh.exe is in bin/ at its root.
   const sh=process.platform==='win32'?['../bin/sh.exe','../../bin/sh.exe','../../usr/bin/sh.exe'].map(p=>path.resolve(path.dirname(git),p)).find(p=>fs.existsSync(p))??'sh':'sh';
   const code=await new Promise((resolve,reject)=>{const child=spawn(sh,[original,...args],{env,windowsHide:true,stdio:['pipe','inherit','inherit']});child.on('error',reject);child.on('exit',resolve);child.stdin.on('error',()=>{});child.stdin.end(refs);});
   if(code!==0)process.exit(code??1);
 }
}catch{process.stderr.write('Existing Git hook could not be checked.\n');process.exit(1);}
if(hook!=='pre-push')process.exit(0);
let command='git push';
if(process.platform==='win32')command=await new Promise(resolve=>{
 const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.ppid}';for($i=0;$i -lt 5 -and $p;$i++){if($p.Name -ieq 'git.exe'){[Console]::Write($p.CommandLine);break};$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId)}`;
 execFile('powershell',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:20000},(e,out)=>resolve(!e&&out.trim()?out.trim():'git push'));
});
const endpoint=process.env.KOKUBAN_CHIEF_PUSH_GATE;
if(!endpoint){process.stderr.write('Chief push gate is unavailable.\n');process.exit(1);}
try{const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,remote:args[1]??args[0]??'',refs}),signal:AbortSignal.timeout(3600000)});const result=await r.json();if(!r.ok||result.allow!==true){process.stderr.write('Git push denied or stopped by Kokuban.\n');process.exit(1);}}
catch{process.stderr.write('Git push refused because Kokuban did not confirm approval.\n');process.exit(1);}
