// Trusted task summaries; no model instructions, remote assets, or action dispatch.
export function taskBuckets(tasks:any[]){
 const safe=tasks.slice(0,50);const statuses=[...new Set(safe.map(t=>String(t.fields.status??'unknown')))];
 const priorities=[...new Set(safe.map(t=>String(t.fields.priority??'unset')))];
 const rank=['unset','low','normal','medium','high','urgent','do-now'];priorities.sort((a,b)=>rank.indexOf(a)-rank.indexOf(b));
 return {total:safe.length,statuses,priorities,cells:priorities.flatMap((priority,z)=>statuses.map((status,x)=>({status,priority,x,z,tasks:safe.filter(t=>String(t.fields.status??'unknown')===status&&String(t.fields.priority??'unset')===priority)})))};
}

export function mapPreference(value:any){return {enabled:value?.enabled===true,angle:Number.isInteger(value?.angle)&&value.angle>=0&&value.angle<=3?value.angle:0,view:value?.view==='top'?'top':'perspective'};}
