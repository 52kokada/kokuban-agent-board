import http from 'node:http';
import fs from 'node:fs/promises';
const root=new URL('../../',import.meta.url);
http.createServer(async(req,res)=>{
const {shell,client}=await import(new URL('src/phone/shell.ts?v='+Date.now(),root));
const path=new URL(req.url,'http://localhost').pathname;
res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':'text/html');
res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'");
res.end(path==='/fixture.js'?await fs.readFile(new URL('fixture.js',import.meta.url),'utf8'):path==='/phone/app.js'?client:shell.replace('<script src="/phone/app.js"','<script src="/fixture.js"></script><script src="/phone/app.js"'));
}).listen(47894,'127.0.0.1',()=>console.log('Synthetic UI fixture 47894'));
