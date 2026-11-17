/** Split only literal shell chains/pipelines. Expansion and malformed quoting remain uncertain. */
export function shellParts(command:string):{parts:string[];outputs:string[];uncertain:boolean}{
  const parts:string[]=[],outputs:string[]=[];let part='',quote='',depth=0;
  const push=()=>{if(part.trim())parts.push(part.trim());part='';};
  for(let i=0;i<command.length;i++){
    const c=command[i];
    if(quote){if(quote==='"'&&(c==='`'||(c==='$'&&command[i+1]==='(')))return {parts:[],outputs:[],uncertain:true};part+=c;if(c===quote){if(command[i+1]===quote){part+=command[++i];}else quote='';}continue;}
    if(c==='"'||c==="'"){quote=c;part+=c;continue;}
    if(c==='`'||(c==='$'&&command[i+1]==='('))return {parts:[],outputs:[],uncertain:true};
    if(c==='('||c==='{')return {parts:[],outputs:[],uncertain:true};if(c===')'||c==='}')return {parts:[],outputs:[],uncertain:true};
    if(depth){part+=c;continue;}
    if(c==='>'){
      if(/\d$/.test(part))part=part.slice(0,-1);
      if(command[i+1]==='>')i++;
      while(/\s/.test(command[i+1]??'')&&i+1<command.length)i++;
      let output='';const q=command[i+1];
      if(q==='"'||q==="'"){i+=2;while(i<command.length&&command[i]!==q)output+=command[i++];if(i>=command.length)return {parts:[],outputs:[],uncertain:true};}
      else{while(i+1<command.length&&!/[\s;|>]/.test(command[i+1]))output+=command[++i];}
      if(!output)return {parts:[],outputs:[],uncertain:true};outputs.push(output);continue;
    }
    if(c===';'||c==='\n'||c==='\r'||c==='|'){push();if(c==='|'&&command[i+1]==='|')i++;continue;}
    if(c==='&'){if(command[i+1]==='&'){push();i++;continue;}if(!part.trim()){continue;}return {parts:[],outputs:[],uncertain:true};}
    if(c==='<')return {parts:[],outputs:[],uncertain:true};
    part+=c;
  }
  push();return {parts,outputs,uncertain:Boolean(quote)||depth!==0};
}
