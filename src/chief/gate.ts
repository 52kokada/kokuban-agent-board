import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { shellParts } from './shell.js';
export interface GateDecision { decision: 'allow' | 'ask' | 'deny'; action: string; target: string; exact: string; unusual?: boolean }
function canonical(p:string):string {
  const suffix:string[]=[];let parent=path.resolve(p);
  while(!fs.existsSync(parent)){const next=path.dirname(parent);if(next===parent)throw Error();suffix.unshift(path.basename(parent));parent=next;}
  return path.join(fs.realpathSync(parent),...suffix);
}
function inside(file:string,root:string):boolean {try{const r=path.relative(canonical(root),canonical(file));return !path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);}catch{return false;}}
function contained(file:string,cwd:string):boolean {return inside(path.resolve(cwd,file),cwd)||inside(path.resolve(cwd,file),os.tmpdir());}
function unquote(s:string):string{return s.replace(/^["']|["']$/g,'');}
function unwrap(command:string):string {
  const m=/^(?:"[^"\r\n]*(?:powershell|pwsh)\.exe"|(?:powershell|pwsh)(?:\.exe)?)\s+(?:(?:-NoProfile|-NonInteractive)\s+)*-Command\s+("[\s\S]*")$/i.exec(command);
  if(!m)return command;try{return JSON.parse(m[1]);}catch{return m[1].slice(1,-1);}
}
/** Visible-text deny list, as the owner approved. Unknown actions run and are audited.
 * This is not a sandbox or a proof of script behavior: obfuscation can evade it. */
export function classifyTool(name:string,input:Record<string,unknown>,cwd:string):GateDecision {
  const command=unwrap(String(input.command??input.cmd??'')),serialized=JSON.stringify(input);
  const target=String(input.file_path??input.path??input.url??input.to??cwd);
  const exact=String(input.command??input.cmd??serialized);
  const result=(decision:GateDecision['decision'],action:string,unusual=false):GateDecision=>({decision,action,target,exact,unusual});
  const short=name.split('__').at(-1)!;
  // Runtime capabilities cannot be obtained through an ordinary tool call.
  if(/(?:kokuban[\\/]settings\.json|[\\/]\.codex[\\/]auth\.json|CredentialBlob|CredRead|phone-admin|x-kokuban-admin)/i.test(serialized))return result('deny','Agents cannot acquire owner credentials or pair devices');
  if(/^mcp__kokuban__/.test(name)&&['peers','glance','inbox','claim','release','send','task','ask','know','conversation','usage','notify'].includes(short))return result('allow','Bound internal coordination');
  const readOnly=['Read','Grep','Glob','LS','WebSearch','ToolSearch'].includes(name);
  if(readOnly)return result('allow','Read-only lookup');
  let scan=name+'\n'+serialized+'\n'+command;
  // Inspect directly named local scripts too; never import or execute them.
  const script=/(?:^|[;&|\n]\s*)(?:node|python(?:3(?:\.\d+)?)?|py)\s+(?:-[\w-]+\s+)*("[^"]+\.(?:mjs|cjs|js|py)"|'[^']+\.(?:mjs|cjs|js|py)'|[^\s;|]+\.(?:mjs|cjs|js|py))(?=\s|$)/gi;
  for(const match of command.matchAll(script)){const file=path.resolve(cwd,unquote(match[1]));try{if(inside(file,cwd)&&fs.statSync(file).size<=262144)scan+='\n'+fs.readFileSync(file,'utf8');}catch{}}
  if(/phone-admin|x-kokuban-admin|CredentialBlob|CredRead/i.test(scan))return result('deny','Agents cannot acquire owner credentials or pair devices');
  // Quoting and argv arrays do not hide recognizable consequential text.
  const flat=scan.replace(/\b(git|gh|npm|pnpm|yarn|wrangler|vercel|shopify)\.(?:exe|cmd)\b/gi,'$1').replace(/["'\[\],()]+/g,' ').replace(/\\[rn]/g,' ').replace(/\s+/g,' ');
  if(/\bgit\s+(?:(?:-[cC]\s+\S+|--(?:git-dir|work-tree)(?:=|\s+)\S+)\s+)*(?:push\b|reset\s+--hard|clean\s+-[\w]*[fd]|checkout\s+(?:--force|-f)\b|branch\s+-D\b)|\bgit\s+\w+\s+[^;\n]*--force\b|\bgh\s+(?:pr\s+merge|release\s+(?:create|upload|delete|edit))\b/i.test(flat))return result('ask','Push, force operation or public release');
  if(/\b(?:npm|pnpm|yarn)\s+publish\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?release[:\w-]*|\bwrangler\s+(?:pages\s+)?deploy\b|\bvercel\s+(?:deploy|--prod|publish)\b|\bvpk\s+pack\b|\bshopify\s+(?:theme\s+(?:push|publish|delete)|app\s+deploy|hydrogen\s+deploy)\b/i.test(flat)||/(?:^|_)(?:deploy|publish)(?:_|$)/i.test(name))return result('ask','Deploy, publish or release');
  const shopify=/shopify/i.test(name)||/myshopify\.com|shopify.*\/admin\/api/i.test(scan);
  if(shopify&&(/mutation\s*[({]|(?:__|_)(?:create|update|delete|publish|set|write)(?:_|$)|(?:-X|--request|-[Mm]ethod)\s*(?:POST|PUT|PATCH|DELETE)|method.{0,10}(?:POST|PUT|PATCH|DELETE)/i.test(scan)||/\b(?:POST|PUT|PATCH|DELETE)\b/i.test(String(input.method??''))))return result('ask','Shopify remains audit-only without exact mutation approval');
  if(/(?:^|_)(?:send[_-]?(?:mail|email|message)|submit|post[_-]?(?:message|tweet|status)|invite|share)(?:_|$)/i.test(name)||(/computeruse/.test(name)&&(/^(?:send|submit)$/i.test(String(input.op))||/"side_effect"\s*:\s*"(?:send|submit)"|"(?:name|name_contains|label)"\s*:\s*"(?:Send|Submit|Publish)\b/i.test(serialized))))return result('ask','Send or submit to an outside person');
  if(/\b(?:sendmail|Send-MailMessage)\b|(?:gmail|slack|outlook).{0,60}(?:messages?\.send|chat\.postMessage|sendMail)|\bfetch\s*.{0,160}(?:mail|slack|messages).{0,120}\bPOST\b/i.test(flat))return result('ask','Outbound mail or message');
  if(/(?:^|__)(?:get|list|read|search|fetch)(?:_|$)/i.test(name)&&!input.method)return result('allow','Read-only connector lookup');
  if(/(?:^|_)(?:pay|purchase|charge|transfer|refund|checkout|(?:create|confirm|capture)_(?:payment|checkout|charge|transfer|refund))(?:_|$)/i.test(name)||/\b(?:stripe|paypal)\s+(?:payments?|charges?|transfers?|checkout).{0,40}\b(?:create|confirm|pay)\b|\b(?:stripe|paypal)\.(?:paymentIntents|charges|transfers|checkout|payments).{0,30}\b(?:create|confirm|capture)\b|\b(?:createPayment|confirmPayment|sendPayment)\s/i.test(flat))return result('ask','Payment or financial transaction');
  if(['Write','Edit','MultiEdit'].includes(name)&&!contained(target,cwd))return result('ask','Write outside the workspace or temp');
  if(name==='File change'){
    if(input.grantRoot)return result('deny','Session-wide write grants are forbidden; request an exact patch');
    const changes=input.changes as Array<{path?:string}>;
    if(Array.isArray(changes)&&changes.some(c=>typeof c.path==='string'&&!contained(c.path,cwd)))return result('ask','File change outside the workspace or temp');
  }
  const parsed=shellParts(command);
  for(const output of parsed.outputs)if(!['&1','&2','$null','NUL','/dev/null'].includes(output)&&!contained(output,cwd))return result('ask','Redirection writes outside the workspace or temp');
  // Literal filesystem writes/deletes in shell commands and embedded scripts.
  const mutations=/(?:\b(?:writeFileSync|writeFile|appendFileSync|appendFile|rmSync|rm|unlinkSync|unlink|rmtree|WriteAllText|Delete)\s*\(\s*["']([^"']+)["']|\b(?:Remove-Item|rm|del|rmdir|Set-Content|Add-Content|Out-File)\s+(?:-[\w-]+\s+)*(["'][^"']+["']|[^\s;|]+))/gi;
  for(const m of scan.matchAll(mutations)){const file=unquote(m[1]??m[2]);if(!file.startsWith('-')&&!file.startsWith('$')&&!contained(file,cwd))return result('ask','Delete or write outside the workspace or temp');}
  if(/(?:writeFile|appendFile|WriteAllText|Set-Content|Add-Content|Out-File|Remove-Item).{0,100}(?:USERPROFILE|LOCALAPPDATA|APPDATA|homedir\s*\(|[\\/]Users[\\/])/i.test(flat))return result('ask','Write into an outside user folder');
  const known=['Write','Edit','MultiEdit','File change','WebFetch'].includes(name)||/^(?:git\b|rg\b|grep\b|Get-\w+|Select-\w+|npm\b|node\b|python\b|py\b|echo\b|cat\b|head\b|tail\b|cd\b)/i.test(command);
  return result('allow',known?'No consequential pattern found':'Unclassified action allowed under bypass policy',!known);
}
export function gateDescription(d:GateDecision):string{return `${d.action}\nTarget: ${d.target}\nExact command/input:\n${d.exact}`;}
