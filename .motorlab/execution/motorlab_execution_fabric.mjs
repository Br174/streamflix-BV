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
    workgroup:t.workgroup ? String(t.workgroup) : '',
    workgroupLabel:t.workgroupLabel ? String(t.workgroupLabel) : '',
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

export function planSemanticWorkgroups(input=[], {maxConcurrency=DEFAULT_MAX,orchestrationOverheadMs=0,integrationTask=null}={}) {
  const groups=Array.isArray(input)?input:[], seen=new Set(), eliminatedGroups=[], active=[];
  for(let i=0;i<groups.length;i++){
    const raw=groups[i]||{}, id=String(raw.id||`workgroup-${i+1}`);
    if(seen.has(id))throw new Error('duplicate workgroup '+id); seen.add(id);
    const label=String(raw.label||raw.workgroupLabel||id);
    if(raw.needed===false){
      eliminatedGroups.push({id,label,reason:String(raw.eliminationReason||'NOT_NEEDED')});
      continue;
    }
    active.push(task({...raw,id,workgroup:id,workgroupLabel:label}));
  }
  if(!active.length){
    return {tasks:[],activeGroups:[],eliminatedGroups,mode:'NO_WORK_REQUIRED',recommendedConcurrency:0,estimatedSerialMs:0,estimatedParallelMs:0,estimatedGainMs:0,plannedPeakConcurrency:0};
  }
  const max=Math.max(1,Number(maxConcurrency)||1), overhead=Math.max(0,Number(orchestrationOverheadMs)||0);
  const p=planGraph(active,max), by=new Map(active.map(t=>[t.id,t]));
  const serialCore=active.reduce((sum,t)=>sum+t.estimatedMs,0);
  const parallelCore=p.waves.reduce((sum,w)=>sum+Math.max(...w.map(id=>by.get(id)?.estimatedMs||0)),0);
  const gain=serialCore-(parallelCore+overhead);
  const semanticParallel=active.length>1&&max>1&&p.plannedPeakConcurrency>1&&gain>0;
  const selectedConcurrency=semanticParallel?max:1;
  const tasks=[...active];
  let integrationMs=0;
  if(integrationTask){
    const raw=integrationTask||{}, deps=[...new Set([...(raw.deps||[]),...active.map(t=>t.id)])];
    const join=task({...raw,id:String(raw.id||'semantic-integration'),kind:raw.kind||'integration',deps,workgroup:raw.workgroup||'integration',workgroupLabel:raw.workgroupLabel||raw.label||'Integration'});
    integrationMs=join.estimatedMs; tasks.push(join);
  }
  return {
    tasks,
    activeGroups:active.map(t=>({id:t.id,label:t.workgroupLabel,estimatedMs:t.estimatedMs,kind:t.kind,scopes:t.scopes})),
    eliminatedGroups,
    mode:active.length===1?'DIRECT_FAST':semanticParallel?'SEMANTIC_PARALLEL':'SEMANTIC_SERIAL',
    recommendedConcurrency:selectedConcurrency,
    estimatedSerialMs:serialCore+integrationMs,
    estimatedParallelMs:(semanticParallel?parallelCore+overhead:serialCore)+integrationMs,
    estimatedGainMs:semanticParallel?gain:0,
    plannedPeakConcurrency:p.plannedPeakConcurrency,
    orchestrationOverheadMs:overhead
  };
}

export async function executeSemanticWorkgroups(input=[],worker,options={}) {
  const {maxConcurrency=DEFAULT_MAX,orchestrationOverheadMs=0,integrationTask=null,...executionOptions}=options||{};
  const plan=planSemanticWorkgroups(input,{maxConcurrency,orchestrationOverheadMs,integrationTask});
  if(!plan.tasks.length){
    return {results:{},eventHistory:[],proof:{executionMode:'DIRECT_FAST',runnerCount:0,observedPeakConcurrency:0,observedPeakIntegrationConcurrency:0,singleIntegrationLaneVerified:true,overlapPairs:[],criticalPath:{ms:0,path:[]},correctionRelays:0,dynamicTasks:0,prunedTasks:[],cacheHits:0,cacheAvoidedEstimatedMs:0,latencyBranches:0,latencyBranchTasks:0,latencyExpectedGainMs:0,latencyBranchFailures:0,eventsRecorded:0,records:[],semanticWorkgroups:plan}};
  }
  const out=await executeGraph(plan.tasks,worker,{...executionOptions,maxConcurrency:plan.recommendedConcurrency});
  out.proof.semanticWorkgroups=plan;
  return out;
}

export async function executeGraph(input=[],worker,{maxConcurrency=DEFAULT_MAX,now=()=>Date.now(),onEvent,cacheLookup,cacheStore}={}){
  if(typeof worker!=='function')throw new Error('worker callback required');
  const initial=validateGraph(input), max=Math.max(1,Number(maxConcurrency)||1);
  const tasks=new Map(initial.map(t=>[t.id,t])), pending=new Set(tasks.keys()), done=new Set(), pruned=new Set(), running=new Map(), results=new Map(), records=[], eventHistory=[], cacheChecked=new Set();
  let peak=0,intNow=0,intPeak=0,correctionRelays=0,dynamicTasks=0,cacheHits=0,cacheAvoidedEstimatedMs=0,latencyBranches=0,latencyBranchTasks=0,latencyExpectedGainMs=0,latencyBranchFailures=0;
  let graphVersion=0,cachedGraphVersion=-1,cachedGraph=null,cachedScores=null,schedulerGraphRecomputes=0,eventFastPathCount=0;
  const emit=event=>{const entry={sequence:eventHistory.length+1,at:now(),...event};eventHistory.push(entry);if(!onEvent){eventFastPathCount++;return null;}return Promise.resolve(onEvent(entry));};
  const emitWait=async event=>{const ack=emit(event);if(ack)await ack;};
  const schedulerView=()=>{if(cachedGraphVersion!==graphVersion){cachedGraph=validateGraph([...tasks.values()]);cachedScores=tailScores(cachedGraph);cachedGraphVersion=graphVersion;schedulerGraphRecomputes++;}return{graph:cachedGraph,scores:cachedScores};};
  const canStart=t=>running.size<max && ![...running.values()].some(x=>conflicts(t,x.task));
  const latencyUseful=t=>t.latencyBranchAfterMs>0&&t.latencySpawn.length>0&&t.latencyBranchExpectedGainMs>t.latencyBranchOverheadMs;

  const addTasks=async(parent,list=[],reason='BRANCH')=>{
    for(const raw of list){
      const child=task({...raw,workgroup:raw.workgroup??parent.workgroup,workgroupLabel:raw.workgroupLabel??parent.workgroupLabel,deps:[...new Set([...(raw.deps||[]),...(raw.detached?[]:[parent.id])])]});
      if(tasks.has(child.id))throw new Error('duplicate dynamic task '+child.id);
      for(const dep of child.deps)if(!tasks.has(dep))throw new Error(child.id+' missing dep '+dep);
      tasks.set(child.id,child);pending.add(child.id);dynamicTasks++;graphVersion++;
      await emitWait({type:'TASK_SPAWNED',taskId:child.id,parentTaskId:parent.id,reason});
    }
  };
  const pruneTasks=async(parent,ids=[])=>{
    for(const rawId of ids){
      const id=String(rawId);
      if(!tasks.has(id)||done.has(id)||pruned.has(id))continue;
      if(running.has(id)){await emitWait({type:'PRUNE_DEFERRED_RUNNING',taskId:id,parentTaskId:parent.id});continue;}
      pending.delete(id);pruned.add(id);await emitWait({type:'TASK_PRUNED',taskId:id,parentTaskId:parent.id});
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
      if(value==null||value===false){await emitWait({type:'CACHE_MISS',taskId:t.id,cacheKey:t.cacheKey});continue;}
      hit=true;pending.delete(t.id);done.add(t.id);results.set(t.id,value?.value??value);cacheHits++;cacheAvoidedEstimatedMs+=t.estimatedMs;
      records.push({id:t.id,kind:t.kind,workgroup:t.workgroup,workgroupLabel:t.workgroupLabel,startedAt:now(),finishedAt:now(),status:'CACHE_HIT',cacheKey:t.cacheKey});
      await emitWait({type:'CACHE_HIT',taskId:t.id,cacheKey:t.cacheKey,avoidedEstimatedMs:t.estimatedMs});
      if(value?.spawn)await addTasks(t,value.spawn,'CACHE_RESTORED_BRANCH');
      if(value?.prune)await pruneTasks(t,value.prune);
    }
    return hit;
  };

  const launch=async t=>{
    pending.delete(t.id);const rec={id:t.id,kind:t.kind,workgroup:t.workgroup,workgroupLabel:t.workgroupLabel,startedAt:now(),finishedAt:null,status:'RUNNING'};records.push(rec);
    if(t.kind==='integration'){intNow++;intPeak=Math.max(intPeak,intNow);}peak=Math.max(peak,running.size+1);const startAck=emit({type:'RUNNER_STARTED',taskId:t.id,workgroupId:t.workgroup||null,workgroupLabel:t.workgroupLabel||null,running:running.size+1});if(startAck)await startAck;
    let latencyTimer=null,latencyWakeResolve=null;
    const promise=Promise.resolve().then(()=>worker(t,{completed:new Set(done),pruned:new Set(pruned),runningCount:running.size+1,maxConcurrency:max,makeContentKey})).then(async value=>{
      if(latencyTimer)clearTimeout(latencyTimer);
      rec.finishedAt=now();rec.status='COMPLETED';if(t.kind==='integration')intNow--;results.set(t.id,value);done.add(t.id);running.delete(t.id);
      if(value?.spawn)await addTasks(t,value.spawn,'DISCOVERY_BRANCH');
      if(value?.prune)await pruneTasks(t,value.prune);
      if(value?.corrections)await addCorrections(t,value.corrections);
      if(t.cacheable&&t.cacheKey&&typeof cacheStore==='function'&&value?.cacheable!==false){await cacheStore(t.cacheKey,value,t);await emitWait({type:'CACHE_STORED',taskId:t.id,cacheKey:t.cacheKey});}
      await emitWait({type:'RUNNER_COMPLETED',taskId:t.id,workgroupId:t.workgroup||null,workgroupLabel:t.workgroupLabel||null,running:running.size});return value;
    }).catch(async e=>{
      if(latencyTimer)clearTimeout(latencyTimer);
      rec.finishedAt=now();rec.status='FAILED';rec.error=String(e?.message||e);if(t.kind==='integration')intNow--;running.delete(t.id);await emitWait({type:'RUNNER_FAILED',taskId:t.id,workgroupId:t.workgroup||null,workgroupLabel:t.workgroupLabel||null,error:rec.error});throw e;
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
          await emitWait({type:'LATENCY_BRANCH_TRIGGERED',taskId:t.id,afterMs:t.latencyBranchAfterMs,spawnedTasks:spawned.map(x=>String(x.id)),expectedGainMs:t.latencyBranchExpectedGainMs,overheadMs:t.latencyBranchOverheadMs});
        }catch(e){
          latencyBranchFailures++;
          await emitWait({type:'LATENCY_BRANCH_FAILED',taskId:t.id,error:String(e?.message||e)});
        }finally{latencyWakeResolve?.();}
      },t.latencyBranchAfterMs);
    }
  };
  const executionStartAck=emit({type:'EXECUTION_STARTED',initialTasks:initial.length,maxConcurrency:max});if(executionStartAck)await executionStartAck;
  while(pending.size||running.size){
    let launched=false;
    let {graph,scores}=schedulerView();
    let ready=[...pending].map(id=>tasks.get(id)).filter(t=>t&&!pruned.has(t.id)&&t.deps.every(d=>done.has(d)||pruned.has(d))).sort((a,b)=>(scores.get(b.id)||b.estimatedMs)-(scores.get(a.id)||a.estimatedMs));
    if(await resolveCacheFor(ready)){
      ({graph,scores}=schedulerView());
      ready=[...pending].map(id=>tasks.get(id)).filter(t=>t&&!pruned.has(t.id)&&t.deps.every(d=>done.has(d)||pruned.has(d))).sort((a,b)=>(scores.get(b.id)||b.estimatedMs)-(scores.get(a.id)||a.estimatedMs));
    }
    for(const t of ready){if(!canStart(t))continue;await launch(t);launched=true;if(running.size>=max)break;}
    if(running.size){if(!launched||running.size>=max||!ready.length){const waits=[...running.values()].flatMap(x=>x.latencyWake?[x.promise,x.latencyWake]:[x.promise]);await Promise.race(waits);}continue;}
    if(pending.size)throw new Error('execution deadlock');
  }

  const overlaps=[],workRecords=records.filter(r=>r.status!=='CACHE_HIT');
  for(let i=0;i<workRecords.length;i++)for(let j=i+1;j<workRecords.length;j++)if(workRecords[i].startedAt<workRecords[j].finishedAt&&workRecords[j].startedAt<workRecords[i].finishedAt)overlaps.push([workRecords[i].id,workRecords[j].id]);
  const finalGraph=schedulerView().graph,effectiveRunnerCount=workRecords.length;
  const executionMode=effectiveRunnerCount<=1&&cacheHits===0?'DIRECT_FAST':max===1&&effectiveRunnerCount>1?'SERIAL_HOST_LIMITED':peak>1?'PARALLEL_OBSERVED':'SERIAL_REQUIRED';
  const executionDoneAck=emit({type:'EXECUTION_COMPLETED',cacheHits,dynamicTasks,prunedTasks:pruned.size,latencyBranches});if(executionDoneAck)await executionDoneAck;
  return {results:Object.fromEntries(results),eventHistory,proof:{executionMode,runnerCount:effectiveRunnerCount,observedPeakConcurrency:peak,observedPeakIntegrationConcurrency:intPeak,singleIntegrationLaneVerified:intPeak<=1,overlapPairs:overlaps,criticalPath:criticalPath(finalGraph),correctionRelays,dynamicTasks,prunedTasks:[...pruned],cacheHits,cacheAvoidedEstimatedMs,latencyBranches,latencyBranchTasks,latencyExpectedGainMs,latencyBranchFailures,schedulerGraphRecomputes,eventFastPathCount,eventsRecorded:eventHistory.length,records}};
}

export function formatProof(p={}){
  const path=(p.criticalPath?.path||[]).join(' -> ')||'n/a';
  const reuse=p.cacheHits?` — cache hit ${p.cacheHits}, lavoro evitato ~${p.cacheAvoidedEstimatedMs||0}ms`:'';
  const dynamic=p.dynamicTasks?` — rami dinamici ${p.dynamicTasks}, potati ${(p.prunedTasks||[]).length}`:'';
  const latency=p.latencyBranches?` — latency branch ${p.latencyBranches}, task ${p.latencyBranchTasks||0}, guadagno atteso ~${p.latencyExpectedGainMs||0}ms`:'';
  const wg=p.semanticWorkgroups?.mode==='SEMANTIC_PARALLEL'?` — workgroup semantici ${p.semanticWorkgroups.activeGroups?.length||0}, lavoro eliminato ${(p.semanticWorkgroups.eliminatedGroups||[]).length}, guadagno stimato ~${p.semanticWorkgroups.estimatedGainMs||0}ms`:p.semanticWorkgroups?.eliminatedGroups?.length?` — lavoro eliminato ${p.semanticWorkgroups.eliminatedGroups.length}`:'';
  if(p.executionMode==='PARALLEL_OBSERVED')return `Modalita: PARALLELA — picco ${p.observedPeakConcurrency||0} corridori reali — critical path: ${path}${reuse}${dynamic}${latency}${wg}`;
  if(p.executionMode==='SERIAL_HOST_LIMITED')return `Modalita: SERIALE LIMITATA DALL'HOST — 1 corridore — critical path: ${path}${reuse}${dynamic}${latency}${wg}`;
  if(p.executionMode==='DIRECT_FAST')return `Modalita: DIRECT FAST — nessun fan-out necessario — critical path: ${path}${reuse}${dynamic}${latency}${wg}`;
  return `Modalita: SERIALE NECESSARIA — dipendenze/conflitti impediscono fan-out utile — critical path: ${path}${reuse}${dynamic}${latency}${wg}`;
}
