import{test}from'node:test';import*as assert from'node:assert/strict';
import{phoneFileResponse}from'../src/phone/file-response.js';
test('inline image types come from bytes, not names; SVG has a script-blocking sandbox',()=>{
 for(const [bytes,type]of [[Buffer.from([137,80,78,71,13,10,26,10]),'image/png'],[Buffer.from([255,216,255,224]),'image/jpeg'],[Buffer.from('GIF89a'),'image/gif'],[Buffer.from('RIFF1234WEBP'),'image/webp'],[Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),'image/svg+xml']]as const){
  const h=phoneFileResponse(bytes,'misleading.bin');assert.equal(h.type,type);assert.match(h.disposition,/^inline;/);if(type==='image/svg+xml')assert.equal(h.csp,"sandbox; default-src 'none'; style-src 'unsafe-inline'");
 }
 for(const text of ['<html><script>alert(1)</script></html>','plain text','%PDF-1.7','']){const h=phoneFileResponse(Buffer.from(text),'fake.png');assert.equal(h.type,'application/octet-stream');assert.match(h.disposition,/^attachment;/);}
});
