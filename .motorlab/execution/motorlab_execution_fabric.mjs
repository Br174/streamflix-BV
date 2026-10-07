import { createHash } from 'node:crypto';

const DEFAULT_MAX = 4;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function makeContentKey(value = {}) {
  const raw = JSON.stringify(stable(value));
  return `mlc:${createHash('sha256').update(raw).digest('hex')}`;
}

function task(t) {
  if (!t || !t.id) throw new Error('task id required');
  const kind = String(t.kind || 'read').toLowerCase();
  if (!['read','write','integration','external'].includes(kind)) throw new Error('unsupported kind '+kind);
  return {
    ...t,
    id:String(t.id),
    kind,
    deps:[...new Set((t.deps||[]).map(String))],
    scopes:[...new Set((t.scopes||[]).map(String))],
    estimatedMs:Math.max(1,Number(t.estimatedMs)||1),
    cacheKey:t.cacheKey ? String(t.cacheKey) : '',
    cacheable:Boolean(t.cacheable ?? t.cacheKey),
    critical:Boolean(t.critical),
    latencyBranchAfterMs:Math.max(0,Number(t.latencyBranchAfterMs)||0),
    latencyBranchExpectedGainMs:Math.max(0,Number(t.latencyBranchExpectedGainMs)||0),
    latencyBranchOverheadMs:Math.max(0,Number(t.latencyBranchOverheadMs)||0),
    latencySpawn:Array.isArray(t.latencySpawn)?t.latencySpawn:[],
  };
}

export function validateGraph(input=[]) {
  const tasks=input.map(task), by=new Map();
  for (const t of tasks) { if(by.has(t.id)) throw new Error('duplicate '+t.id); by.set(t.id,t); }
  for (const t of tasks) for (const d of t.deps) if(!by.has(d)) throw new Error(t.id+' missing dep '+d);
  const visiting=new Set(), done=new Set();
  const visit=(id)=>{ if(visiting.has(id)) throw new Error('cycle at '+id); if(done.has(id)) return; visiting.add(id); for(const d of by.get(id).deps) visit(d); visiting.delete(id); done.add(id); };
  for(const t of tasks) visit(t.id);
  return tasks;
}

function writes(t){ return t.kind==='write'||t.kind==='integration'; }
function conflicts(a,b){
  if(!writes(a)&&!writes(b)) return false;
  if(a.kind==='integration'&&writes(b) || b.kind==='integration'&&writes(a)) return true;
  if(!a.scopes.length||!b.scopes.length) return writes(a)&&writes(b);
  const s=new Set(b.scopes); return a.scopes.some(x=>s.has(x));
}

export function criticalPath(input=[]){
  const ts=validateGraph(input), by=new Map(ts.map(t=>[t.id,t])), memo=new Map();
  const best=(id)=>{ if(memo.has(id)) return memo.get(id); const t=by.get(id); let p={ms:0,path:[]}; for(const d of t.deps){const q=best(d); if(q.ms>p.ms)p=q;} const r={ms:p.ms+t.estimatedMs,path:[...p.path,id]}; memo.set(id,r); return r; };
  let out={ms:0,path:[]}; for(const t of ts){const q=best(t.id); if(q.ms>out.ms)out=q;} return out;
}

function tailScores(ts){
  const children=new Map(ts.map(t=>[t.id,[]])), by=new Map(ts.map(t=>[t.id,t])), memo=new Map();
  for(const t of ts) for(const d of t.deps) children.get(d).push(t.id);
  const score=(id)=>{ if(memo.has(id))return memo.get(id); const t=by.get(id); const v=t.estimatedMs+children.get(id).reduce((m,c)=>Math.max(m,score(c)),0)+(t.critical?1_000_000:0); memo.set(id,v); return v; };
  for(const t of ts)score(t.id); return memo;
}

export function planGraph(input=[],maxConcurrency=DEFAULT_MAX){
  const ts=validateGraph(input), max=Math.max(1,Number(maxConcurrency)||1), scores=tailScores(ts);
  const pending=new Map(ts.map(t=>[t.id,t])), done=new Set(), waves=[];
  while(pending.size){
    const ready=[...pending.values()].filter(t=>t.deps.every(d=>done.has(d))).sort((a,b)=>(scores.get(b.id)-scores.get(a.id)));
    if(!ready.length)throw new Error('deadlock');
    const wave=[]; for(const t of ready){if(wave.length>=max)break;if(!wave.some(r=>conflicts(t,r)))wave.push(t);}
    if(!wave.length)wave.push(ready[0]); waves.push(wave.map(t=>t.id)); for(const t of wave){pending.delete(t.id);done.add(t.id);}
  }
  const peak=Math.max(0,...waves.map(w=>w.length));
  return {waves,plannedPeakConcurrency:peak,criticalPath:criticalPath(ts),executionMode:ts.length<=1?'DIRECT_FAST':max===1?'SERIAL_HOST_LIMITED':peak>1?'PARALLEL_PLANNED':'SERIAL_REQUIRED'};
}

export async function executeGraph(input=[],worker,{maxConcurrency=DEFAULT_MAX,now=()=>Date.now(),onEvent,cacheLookup,cacheStore}={}){
  if(typeof worker!=='function')throw new Error('worker callback required');
  const initial=validateGraph(input), max=Math.max(1,Number(maxConcurrency)||1);
  const tasks=new Map(initial.map(t=>[t.id,t])), pending=new Set(tasks.keys()), done=new Set(), pruned=new Set(), running=new Map(), results=new Map(), records=[], eventHistory=[], cacheChecked=new Set();
  let peak=0,intNow=0,intPeak=0,correctionRelays=0,dynamicTasks=0,cacheHits=0,cacheAvoidedEstimatedMs=0,latencyBranches=0,latencyBranchTasks=0,latencyExpectedGainMs=0,latencyBranchFailures=0;
  const emit=async event=>{const entry={sequence:eventHistory.length+1,at:now(),...event};eventHistory.push(entry);if(onEvent)await onEvent(entry);};
  const graphSnapshot=()=>validateGraph([...tasks.values()]);
  const canStart=t=>running.size<max && ![...running.values()].some(x=>conflicts(t,x.task));
  const latencyUseful=t=>t.latencyBranchAfterMs>0&&t.latencySpawn.length>0&&t.latencyBranchExpectedGainMs>t.latencyBranchOverheadMs;

  const addTasks=async(parent,list=[],reason='BRANCH')=>{
    for(const raw of list){
      const child=task({...raw,deps:[...new Set([...(raw.deps||[]),...(raw.detached?[]:[parent.id])])]});
      if(tasks.has(child.id))throw new Error('duplicate dynamic task '+child.id);
      for(const dep of child.deps)if(!tasks.has(dep))throw new Error(child.id+' missing dep '+dep);
      tasks.set(child.id,child);pending.add(child.id);dynamicTasks++;
      await emit({type:'TASK_SPAWNED',taskId:child.id,parentTaskId:parent.id,reason});
    }
  };
  const pruneTasks=async(parent,ids=[])=>{
    for(const rawId of ids){
      const id=String(rawId);
      if(!tasks.has(id)||done.has(id)||pruned.has(id))continue;
      if(running.has(id)){await emit({type:'PRUNE_DEFERRED_RUNNING',taskId:id,parentTaskId:parent.id});continue;}
      pending.delete(id);pruned.add(id);await emit({type:'TASK_PRUNED',taskId:id,parentTaskId:parent.id});
    }
  };
  const addCorrections=async(parent,list=[])=>{if(!list.length)return;correctionRelays+=list.length;await addTasks(parent,list,'CORRECTION_RELAY');};

  const resolveCacheFor=async ready=>{
    if(typeof cacheLookup!=='function')return false;
    const candidates=ready.filter(t=>t.cacheable&&t.cacheKey&&!cacheChecked.has(t.id));
    if(!candidates.length)return false;
    const lookups=await Promise.all(candidates.map(async t=>{cacheChecked.add(t.id);try{return{t,value:await cacheLookup(t.cacheKey,t)};}catch{return{t,value:null};}}));
    let hit=false;
    for(const {t,value} of lookups){
      if(value==null||value===false){await emit({type:'CACHE_MISS',taskId:t.id,cacheKey:t.cacheKey});continue;}
      hit=true;pending.delete(t.id);done.add(t.id);results.set(t.id,value?.value??value);cacheHits++;cacheAvoidedEstimatedMs+=t.estimatedMs;
      records.push({id:t.id,kind:t.kind,startedAt:now(),finishedAt:now(),status:'CACHE_HIT',cacheKey:t.cacheKey});
      await emit({type:'CACHE_HIT',taskId:t.id,cacheKey:t.cacheKey,avoidedEstimatedMs:t.estimatedMs});
      if(value?.spawn)await addTasks(t,value.spawn,'CACHE_RESTORED_BRANCH');
      if(value?.prune)await pruneTasks(t,value.prune);
    }
    return hit;
  };

  const launch=async t=>{
    pending.delete(t.id);const rec={id:t.id,kind:t.kind,startedAt:now(),finishedAt:null,status:'RUNNING'};records.push(rec);
    if(t.kind==='integration'){intNow++;intPeak=Math.max(intPeak,intNow);}peak=Math.max(peak,running.size+1);await emit({type:'RUNNER_STARTED',taskId:t.id,running:running.size+1});
    let latencyTimer=null,latencyWakeResolve=null;
    const promise=Promise.resolve().then(()=>worker(t,{completed:new Set(done),pruned:new Set(pruned),runningCount:running.size+1,maxConcurrency:max,makeContentKey})).then(async value=>{
      if(latencyTimer)clearTimeout(latencyTimer);
      rec.finishedAt=now();rec.status='COMPLETED';if(t.kind==='integration')intNow--;results.set(t.id,value);done.add(t.id);running.delete(t.id);
      if(value?.spawn)await addTasks(t,value.spawn,'DISCOVERY_BRANCH');
      if(value?.prune)await pruneTasks(t,value.prune);
      if(value?.corrections)await addCorrections(t,value.corrections);
      if(t.cacheable&&t.cacheKey&&typeof cacheStore==='function'&&value?.cacheable!==false){await cacheStore(t.cacheKey,value,t);await emit({type:'CACHE_STORED',taskId:t.id,cacheKey:t.cacheKey});}
      await emit({type:'RUNNER_COMPLETED',taskId:t.id,running:running.size});return value;
    }).catch(async e=>{
      if(latencyTimer)clearTimeout(latencyTimer);
      rec.finishedAt=now();rec.status='FAILED';rec.error=String(e?.message||e);if(t.kind==='integration')intNow--;running.delete(t.id);await emit({type:'RUNNER_FAILED',taskId:t.id,error:rec.error});throw e;
    });
    const entry={task:t,promise,latencyWake:null};running.set(t.id,entry);
    if(latencyUseful(t)){
      entry.latencyWake=new Promise(resolve=>{latencyWakeResolve=resolve;});
      latencyTimer=setTimeout(async()=>{
        const live=running.get(t.id);
        if(!live){latencyWakeResolve?.();return;}
        live.latencyWake=null;
        try{
          const spawned=t.latencySpawn.map(raw=>({...raw,detached:true}));
          await addTasks(t,spawned,'LATENCY_BRANCH');
          latencyBranches++;latencyBranchTasks+=spawned.length;latencyExpectedGainMs+=t.latencyBranchExpectedGainMs;
          await emit({type:'LATENCY_BRANCH_TRIGGERED',taskId:t.id,afterMs:t.latencyBranchAfterMs,spawnedTasks:spawned.map(x=>String(x.id)),expectedGainMs:t.latencyBranchExpectedGainMs,overheadMs:t.latencyBranchOverheadMs});
        }catch(e){
          latencyBranchFailures++;
          await emit({type:'LATENCY_BRANCH_FAILED',taskId:t.id,error:String(e?.message||e)});
        }finally{latencyWakeResolve?.();}
      },t.latencyBranchAfterMs);
    }
  };
  await emit({type:'EXECUTION_STARTED',initialTasks:initial.length,maxConcurrency:max});
  while(pending.size||running.size){
    let launched=false;
    let graph=graphSnapshot(),scores=tailScores(graph);
    let ready=[...pending].map(id=>tasks.get(id)).filter(t=>t&&!pruned.has(t.id)&&t.deps.every(d=>done.has(d)||pruned.has(d))).sort((a,b)=>(scores.get(b.id)||b.estimatedMs)-(scores.get(a.id)||a.estimatedMs));
    if(await resolveCacheFor(ready)){
      graph=graphSnapshot();scores=tailScores(graph);
      ready=[...pending].map(id=>tasks.get(id)).filter(t=>t&&!pruned.has(t.id)&&t.deps.every(d=>done.has(d)||pruned.has(d))).sort((a,b)=>(scores.get(b.id)||b.estimatedMs)-(scores.get(a.id)||a.estimatedMs));
    }
    for(const t of ready){if(!canStart(t))continue;await launch(t);launched=true;if(running.size>=max)break;}
    if(running.size){if(!launched||running.size>=max||!ready.length){const waits=[...running.values()].flatMap(x=>x.latencyWake?[x.promise,x.latencyWake]:[x.promise]);await Promise.race(waits);}continue;}
    if(pending.size)throw new Error('execution deadlock');
  }

  const overlaps=[],workRecords=records.filter(r=>r.status!=='CACHE_HIT');
  for(let i=0;i<workRecords.length;i++)for(let j=i+1;j<workRecords.length;j++)if(workRecords[i].startedAt<workRecords[j].finishedAt&&workRecords[j].startedAt<workRecords[i].finishedAt)overlaps.push([workRecords[i].id,workRecords[j].id]);
  const finalGraph=graphSnapshot(),effectiveRunnerCount=workRecords.length;
  const executionMode=effectiveRunnerCount<=1&&cacheHits===0?'DIRECT_FAST':max===1&&effectiveRunnerCount>1?'SERIAL_HOST_LIMITED':peak>1?'PARALLEL_OBSERVED':'SERIAL_REQUIRED';
  await emit({type:'EXECUTION_COMPLETED',cacheHits,dynamicTasks,prunedTasks:pruned.size,latencyBranches});
  return {results:Object.fromEntries(results),eventHistory,proof:{executionMode,runnerCount:effectiveRunnerCount,observedPeakConcurrency:peak,observedPeakIntegrationConcurrency:intPeak,singleIntegrationLaneVerified:intPeak<=1,overlapPairs:overlaps,criticalPath:criticalPath(finalGraph),correctionRelays,dynamicTasks,prunedTasks:[...pruned],cacheHits,cacheAvoidedEstimatedMs,latencyBranches,latencyBranchTasks,latencyExpectedGainMs,latencyBranchFailures,eventsRecorded:eventHistory.length,records}};
}

export function formatProof(p={}){
  const path=(p.criticalPath?.path||[]).join(' -> ')||'n/a';
  const reuse=p.cacheHits?` — cache hit ${p.cacheHits}, lavoro evitato ~${p.cacheAvoidedEstimatedMs||0}ms`:'';
  const dynamic=p.dynamicTasks?` — rami dinamici ${p.dynamicTasks}, potati ${(p.prunedTasks||[]).length}`:'';
  const latency=p.latencyBranches?` — latency branch ${p.latencyBranches}, task ${p.latencyBranchTasks||0}, guadagno atteso ~${p.latencyExpectedGainMs||0}ms`:'';
  if(p.executionMode==='PARALLEL_OBSERVED')return `Modalita: PARALLELA — picco ${p.observedPeakConcurrency||0} corridori reali — critical path: ${path}${reuse}${dynamic}${latency}`;
  if(p.executionMode==='SERIAL_HOST_LIMITED')return `Modalita: SERIALE LIMITATA DALL'HOST — 1 corridore — critical path: ${path}${reuse}${dynamic}${latency}`;
  if(p.executionMode==='DIRECT_FAST')return `Modalita: DIRECT FAST — nessun fan-out necessario — critical path: ${path}${reuse}${dynamic}${latency}`;
  return `Modalita: SERIALE NECESSARIA — dipendenze/conflitti impediscono fan-out utile — critical path: ${path}${reuse}${dynamic}${latency}`;
}
