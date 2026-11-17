import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const shellQuote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
/** Only this contained child inherits the hook override; no Git config/auth file changes. */
export function chiefGitEnvironment(home:string,endpoint:string):NodeJS.ProcessEnv {
  fs.mkdirSync(home,{recursive:true});
  const client=fileURLToPath(new URL('../../../assets/chief-pre-push.mjs',import.meta.url));
  for(const hook of ['applypatch-msg','pre-applypatch','post-applypatch','pre-commit','pre-merge-commit','prepare-commit-msg','commit-msg','post-commit','pre-rebase','post-checkout','post-merge','pre-push','pre-receive','update','proc-receive','post-receive','post-update','reference-transaction','push-to-checkout','pre-auto-gc','post-rewrite','sendemail-validate','fsmonitor-watchman','p4-changelist','p4-prepare-changelist','p4-post-changelist','p4-pre-submit','post-index-change'])
    fs.writeFileSync(path.join(home,hook),`#!/bin/sh\nexec ${shellQuote(process.execPath.replace(/\\/g,'/'))} ${shellQuote(client.replace(/\\/g,'/'))} ${hook} "$@"\n`,{mode:0o700});
  const env={...process.env};const n=Number(env.GIT_CONFIG_COUNT??'0');if(!Number.isSafeInteger(n)||n<0||n>100)throw Error('Unsupported inherited Git configuration');
  env.GIT_CONFIG_COUNT=String(n+1);env[`GIT_CONFIG_KEY_${n}`]='core.hooksPath';env[`GIT_CONFIG_VALUE_${n}`]=home;env.KOKUBAN_CHIEF_PUSH_GATE=endpoint;
  env.KOKUBAN_CHIEF_ORIGINAL_CONFIG_COUNT=String(n);
  if(process.platform==='win32'){
    const realGit=execFileSync('where.exe',['git.exe'],{windowsHide:true,encoding:'utf8'}).split(/\r?\n/).find(p=>p.trim()&&!p.startsWith(home));
    if(!realGit)throw Error('Git executable unavailable');
    const adapter=fileURLToPath(new URL('../../../assets/chief-git/ChiefGit.exe',import.meta.url));
    const bin=path.join(home,'bin');fs.mkdirSync(bin,{recursive:true});fs.copyFileSync(adapter,path.join(bin,'git.exe'));
    env.KOKUBAN_CHIEF_REAL_GIT=realGit.trim();env.PATH=bin+path.delimiter+(env.PATH??env.Path??'');delete env.Path;
    env.KOKUBAN_CHIEF_GIT_CONFIG=env.GIT_CONFIG_COUNT+'\n';for(let i=0;i<=n;i++)env.KOKUBAN_CHIEF_GIT_CONFIG+=env[`GIT_CONFIG_KEY_${i}`]+'\n'+env[`GIT_CONFIG_VALUE_${i}`]+'\n';
  }
  return env;
}
