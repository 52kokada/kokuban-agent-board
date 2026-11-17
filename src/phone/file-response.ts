/** Detect supported images from bytes; filenames never authorize inline HTML. */
export function phoneFileResponse(bytes:Buffer,name:string):{type:string;disposition:string;csp?:string}{
  let type='application/octet-stream';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))type='image/png';
  else if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)type='image/jpeg';
  else if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')))type='image/gif';
  else if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')type='image/webp';
  else {
    const prefix=bytes.subarray(0,4096).toString('utf8').replace(/^\uFEFF/,'').replace(/^\s*(?:<\?xml[\s\S]*?\?>)?\s*(?:<!--[\s\S]*?-->\s*)*/,'');
    if(/^<svg(?:\s|>)/i.test(prefix))type='image/svg+xml';
  }
  return {type,disposition:`${type.startsWith('image/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,...(type==='image/svg+xml'?{csp:"sandbox; default-src 'none'; style-src 'unsafe-inline'"}:{})};
}
