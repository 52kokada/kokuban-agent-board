'use strict';
const { test }=require('node:test'),assert=require('node:assert/strict');
const {validate,terminalOptions}=require('./launch.cjs');
test('grant plan opens an editor terminal, retaining Unicode cwd and removing inherited session ids',()=>{
 const plan=validate({host:'claude',target:'vscode',cwd:__dirname,encodedCommand:Buffer.from("Write-Output '日本語'",'utf16le').toString('base64')});
 const options=terminalOptions(plan);assert.equal(options.location,2);assert.equal(options.cwd,__dirname);
 assert.equal(options.env.CLAUDECODE,null);assert.deepEqual(options.shellArgs,['-NoExit','-EncodedCommand',plan.encodedCommand]);
});
test('URI content cannot select shell, executable, host or arbitrary launch target',()=>{
 for(const change of [{host:'evil'},{target:'terminal'},{cwd:'relative'},{encodedCommand:'; whoami'}])assert.throws(()=>validate({host:'codex',target:'vscode',cwd:__dirname,encodedCommand:'AAAA',...change}));
});
