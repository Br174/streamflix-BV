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
    laneKey:t.laneKey ? String(t.laneKey) : kind,
    adaptiveLane:Boolean(t.adaptiveLane ?? kind==='external'),
    hedgeSafe:Boolean(t.hedgeSafe),
    hedgeExternalAllowed:Boolean(t.hedgeExternalAllowed),
    hedgeAfterMs:Math.max(0,Number(t.hedgeAfterMs)||0),
    hedgeWidth:Math.max(1,Math.min(3,Number(t.hedgeWidth)||3)),
    hedgeMaxWaves:Math.max(1,Math.min(2,Number(t.hedgeMaxWaves)||2)),
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


export function createAdaptiveRuntimeGovernor(config={}) {
  const minLanes=Math.max(1,Number(config.minLanes)||1);
  const maxLanes=Math.max(minLanes,Number(config.maxLanes)||DEFAULT_MAX);
  const initialLanes=Math.max(minLanes,Math.min(maxLanes,Number(config.initialLanes)||Math.min(3,maxLanes)));
  const successesToIncrease=Math.max(1,Number(config.successesToIncrease)||4);
  const hedgeTriggerMs=Math.max(1,Number(config.hedgeTriggerMs)||10000);
  const ewmaAlpha=Math.min(.95,Math.max(.05,Number(config.ewmaAlpha)||.25));
  const restored=config.state?.lanes||{};
  const lanes=new Map();
  const lane=key=>{
    const k=String(key||'default');
    if(!lanes.has(k)){
      const seed=restored[k]||{};
      lanes.set(k,{
        key:k,
        limit:Math.max(minLanes,Math.min(maxLanes,Number(seed.limit)||initialLanes)),
        samples:Number(seed.samples)||0,
        successes:Number(seed.successes)||0,
        failures:Number(seed.failures)||0,
        throttles:Number(seed.throttles)||0,
        saturations:Number(seed.saturations)||0,
        successStreak:Number(seed.successStreak)||0,
        ewmaMs:Number(seed.ewmaMs)||0,
        lastMs:Number(seed.lastMs)||0,
        adjustments:Number(seed.adjustments)||0
      });
    }
    return lanes.get(k);
  };
  const isThrottle=value=>{
    if(value?.runtime?.throttled===true||value?.throttled===true)return true;
    const s=String(value?.message||value?.error||value||'').toLowerCase();
    return /(^|\D)429(\D|$)|rate.?limit|secondary.?rate|throttl|too many requests/.test(s);
  };
  const isSaturated=value=>Boolean(value?.runtime?.saturated===true||value?.saturated===true);
  const observe=({laneKey='default',durationMs=0,ok=true,value,error}={})=>{
    const s=lane(laneKey),ms=Math.max(0,Number(durationMs)||0),throttled=isThrottle(value)||isThrottle(error),saturated=isSaturated(value);
    const before=s.limit;
    s.samples++;s.lastMs=ms;
    if(ms)s.ewmaMs=s.ewmaMs?s.ewmaMs*(1-ewmaAlpha)+ms*ewmaAlpha:ms;
    if(throttled){
      s.throttles++;s.successStreak=0;s.limit=Math.max(minLanes,Math.floor(s.limit/2));
    }else if(saturated){
      s.saturations++;s.successStreak=0;s.limit=Math.max(minLanes,s.limit-1);
    }else if(ok){
      s.successes++;s.successStreak++;
      if(s.successStreak>=successesToIncrease&&s.limit<maxLanes){s.limit++;s.successStreak=0;}
    }else{
      s.failures++;s.successStreak=0;
    }
    if(s.limit!==before)s.adjustments++;
    return {before,after:s.limit,throttled,saturated,state:{...s}};
  };
  return {
    laneLimit:key=>lane(key).limit,
    hedgeTriggerMs:task=>Math.max(1,Number(task?.hedgeAfterMs)||hedgeTriggerMs),
    hedgeWidth:task=>Math.max(1,Math.min(3,Number(task?.hedgeWidth)||3,lane(task?.laneKey).limit)),
    observe,
    isThrottle,
    snapshot:()=>({minLanes,maxLanes,initialLanes,successesToIncrease,hedgeTriggerMs,lanes:Object.fromEntries([...lanes].map(([k,v])=>[k,{...v}]))})
  };
}

export async function executeGraph(input=[],worker,{maxConcurrency=DEFAULT_MAX,now=()=>Date.now(),onEvent,cacheLookup,cacheStore,adaptiveGovernor,adaptiveGovernorConfig={},adaptiveStateLoad,adaptiveStateStore,resultValidator}={}) {
  if(typeof worker!=='function')throw new Error('worker callback required');
  const initial=validateGraph(input),max=Math.max(1,Number(maxConcurrency)||1);
  let adaptiveStateLoaded=false,adaptiveStateStored=false,restoredAdaptiveState=null;
  if(!adaptiveGovernor&&typeof adaptiveStateLoad==='function'){
    try{restoredAdaptiveState=await adaptiveStateLoad();adaptiveStateLoaded=Boolean(restoredAdaptiveState);}catch{}
  }
  const governor=adaptiveGovernor||createAdaptiveRuntimeGovernor({minLanes:1,maxLanes:max,initialLanes:Math.min(3,max),...adaptiveGovernorConfig,state:restoredAdaptiveState||adaptiveGovernorConfig.state});
  const tasks=new Map(initial.map(t=>[t.id,t])),pending=new Set(tasks.keys()),done=new Set(),pruned=new Set(),running=new Map(),results=new Map(),records=[],eventHistory=[],cacheChecked=new Set();
  let peak=0,intNow=0,intPeak=0,correctionRelays=0,dynamicTasks=0,cacheHits=0,cacheAvoidedEstimatedMs=0,latencyBranches=0,latencyBranchTasks=0,latencyExpectedGainMs=0,latencyBranchFailures=0;
  let freshHedges=0,hedgeWaves=0,hedgeWins=0,hedgePrimaryWins=0,hedgeAbortRequests=0,hedgeSuppressedUnsafe=0,hedgeExhausted=0,materialProgressSignals=0,earlyStallSignals=0,laneAdjustments=0,laneThrottleSignals=0,laneSaturationSignals=0;
  let graphVersion=0,cachedGraphVersion=-1,cachedGraph=null,cachedScores=null,schedulerGraphRecomputes=0,eventFastPathCount=0,wakeGeneration=0;
  const laneInflight=new Map();
  const laneCount=key=>laneInflight.get(key)||0;
  const holdLane=(t,a)=>{if(!t.adaptiveLane||a.budgetHeld)return;a.budgetHeld=true;laneInflight.set(t.laneKey,laneCount(t.laneKey)+1);};
  const releaseLane=(t,a)=>{if(!a?.budgetHeld)return;a.budgetHeld=false;laneInflight.set(t.laneKey,Math.max(0,laneCount(t.laneKey)-1));};
  const wakeWaiters=new Set();
  const wakeScheduler=()=>{wakeGeneration++;for(const token of [...wakeWaiters]){wakeWaiters.delete(token);token.resolve();}};
  const makeWakeWaiter=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});const token={resolve};wakeWaiters.add(token);return{promise,cancel:()=>wakeWaiters.delete(token)};};
  const emit=event=>{const entry={sequence:eventHistory.length+1,at:now(),...event};eventHistory.push(entry);if(!onEvent){eventFastPathCount++;return null;}return Promise.resolve(onEvent(entry));};
  const emitWait=async event=>{const ack=emit(event);if(ack)await ack;};
  const schedulerView=()=>{if(cachedGraphVersion!==graphVersion){cachedGraph=validateGraph([...tasks.values()]);cachedScores=tailScores(cachedGraph);cachedGraphVersion=graphVersion;schedulerGraphRecomputes++;}return{graph:cachedGraph,scores:cachedScores};};
  const canStart=t=>running.size<max&&(!t.adaptiveLane||laneCount(t.laneKey)<Math.min(max,governor.laneLimit(t.laneKey)))&&![...running.values()].some(x=>conflicts(t,x.task));
  const latencyUseful=t=>t.latencyBranchAfterMs>0&&t.latencySpawn.length>0&&t.latencyBranchExpectedGainMs>t.latencyBranchOverheadMs;
  const hedgeEligible=t=>t.hedgeSafe&&(t.kind==='read'||(t.kind==='external'&&t.hedgeExternalAllowed));

  const addTasks=async(parent,list=[],reason='BRANCH')=>{
    for(const raw of list){
      const child=task({...raw,workgroup:raw.workgroup??parent.workgroup,workgroupLabel:raw.workgroupLabel??parent.workgroupLabel,laneKey:raw.laneKey??parent.laneKey,deps:[...new Set([...(raw.deps||[]),...(raw.detached?[]:[parent.id])])]});
      if(tasks.has(child.id))throw new Error('duplicate dynamic task '+child.id);
      for(const dep of child.deps)if(!tasks.has(dep))throw new Error(child.id+' missing dep '+dep);
      tasks.set(child.id,child);pending.add(child.id);dynamicTasks++;graphVersion++;wakeScheduler();
      await emitWait({type:'TASK_SPAWNED',taskId:child.id,parentTaskId:parent.id,reason,laneKey:child.laneKey});
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
      records.push({id:t.id,kind:t.kind,workgroup:t.workgroup,workgroupLabel:t.workgroupLabel,laneKey:t.laneKey,startedAt:now(),finishedAt:now(),status:'CACHE_HIT',cacheKey:t.cacheKey});
      await emitWait({type:'CACHE_HIT',taskId:t.id,cacheKey:t.cacheKey,avoidedEstimatedMs:t.estimatedMs});
      if(value?.spawn)await addTasks(t,value.spawn,'CACHE_RESTORED_BRANCH');
      if(value?.prune)await pruneTasks(t,value.prune);
    }
    return hit;
  };

  const launch=async t=>{
    pending.delete(t.id);
    const rec={id:t.id,kind:t.kind,workgroup:t.workgroup,workgroupLabel:t.workgroupLabel,laneKey:t.laneKey,startedAt:now(),finishedAt:null,status:'RUNNING'};
    records.push(rec);
    if(t.kind==='integration'){intNow++;intPeak=Math.max(intPeak,intNow);}
    peak=Math.max(peak,running.size+1);
    const startAck=emit({type:'RUNNER_STARTED',taskId:t.id,workgroupId:t.workgroup||null,workgroupLabel:t.workgroupLabel||null,laneKey:t.laneKey,laneLimit:governor.laneLimit(t.laneKey),running:running.size+1});
    if(startAck)await startAck;

    const eligible=hedgeEligible(t);
    if(t.hedgeSafe&&!eligible)hedgeSuppressedUnsafe++;

    if(!eligible&&!latencyUseful(t)&&!t.adaptiveLane&&typeof resultValidator!=='function'){
      const promise=Promise.resolve().then(()=>worker(t,{
        completed:new Set(done),pruned:new Set(pruned),runningCount:running.size+1,maxConcurrency:max,makeContentKey,
        attempt:1,wave:1,laneKey:t.laneKey,laneLimit:max,
        progress:detail=>{materialProgressSignals++;const ack=emit({type:'RUNNER_PROGRESS',taskId:t.id,attempt:1,wave:1,laneKey:t.laneKey,detail:detail??null});if(ack)ack.catch(()=>{});},
        stall:reason=>{earlyStallSignals++;const ack=emit({type:'RUNNER_STALL_SIGNAL',taskId:t.id,attempt:1,wave:1,laneKey:t.laneKey,reason:String(reason||'STALL')});if(ack)ack.catch(()=>{});}
      })).then(async value=>{
        rec.finishedAt=now();rec.status='COMPLETED';rec.winnerAttempt=1;rec.attempts=1;if(t.kind==='integration')intNow--;
        results.set(t.id,value);done.add(t.id);running.delete(t.id);
        if(value?.spawn)await addTasks(t,value.spawn,'DISCOVERY_BRANCH');
        if(value?.prune)await pruneTasks(t,value.prune);
        if(value?.corrections)await addCorrections(t,value.corrections);
        if(t.cacheable&&t.cacheKey&&typeof cacheStore==='function'&&value?.cacheable!==false){await cacheStore(t.cacheKey,value,t);await emitWait({type:'CACHE_STORED',taskId:t.id,cacheKey:t.cacheKey});}
        await emitWait({type:'RUNNER_COMPLETED',taskId:t.id,workgroupId:t.workgroup||null,workgroupLabel:t.workgroupLabel||null,laneKey:t.laneKey,winnerAttempt:1,attempts:1,running:running.size});
        return value;
      }).catch(async e=>{
        rec.finishedAt=now();rec.status='FAILED';rec.error=String(e?.message||e);rec.attempts=1;if(t.kind==='integration')intNow--;
        running.delete(t.id);await emitWait({type:'RUNNER_FAILED',taskId:t.id,workgroupId:t.workgroup||null,workgroupLabel:t.workgroupLabel||null,laneKey:t.laneKey,attempts:1,error:rec.error});throw e;
      });
      running.set(t.id,{task:t,promise,latencyWake:null});
      return;
    }

    const hardMs=governor.hedgeTriggerMs(t),maxWaves=t.hedgeMaxWaves,width=()=>t.adaptiveLane?Math.max(1,Math.min(governor.hedgeWidth(t),1+Math.max(0,governor.laneLimit(t.laneKey)-laneCount(t.laneKey)))):Math.max(1,Math.min(3,t.hedgeWidth));
    let recoveryTimer=null,latencyWakeResolve=null,latencyBranchTriggered=false,settled=false,currentWave=1,waveExpanded=false,attemptSeq=0,winnerAttempt=0;
    const controllers=new Map(),attempts=new Map(),stalled=new Set(),failures=[];
    let resolveTask,rejectTask;
    const completion=new Promise((resolve,reject)=>{resolveTask=resolve;rejectTask=reject;});

    const scheduleTimer=ms=>{
      if(recoveryTimer)clearTimeout(recoveryTimer);
      recoveryTimer=setTimeout(()=>{void onRecoveryDeadline();},Math.max(1,ms));
    };
    const abortAttempts=reason=>{
      for(const [id,controller] of controllers)if(!controller.signal.aborted){controller.abort(reason);hedgeAbortRequests++;releaseLane(t,attempts.get(id));}
    };
    const taskAttemptsForWave=wave=>[...attempts.values()].filter(a=>a.wave===wave);
    const activeForWave=wave=>taskAttemptsForWave(wave).filter(a=>a.active);
    const validResult=async(value,attempt)=>{
      if(typeof resultValidator==='function')return Boolean(await resultValidator(value,t,{attempt:attempt.id,wave:attempt.wave}));
      return value?.valid!==false&&value?.stalled!==true;
    };
    const observeLane=async({ok,value,error,durationMs})=>{
      if(!t.adaptiveLane)return;
      const obs=governor.observe({laneKey:t.laneKey,ok,value,error,durationMs});
      if(obs.before!==obs.after){laneAdjustments++;await emitWait({type:'LANE_LIMIT_ADJUSTED',taskId:t.id,laneKey:t.laneKey,before:obs.before,after:obs.after,throttled:obs.throttled,saturated:obs.saturated});}
      if(obs.throttled)laneThrottleSignals++;
      if(obs.saturated)laneSaturationSignals++;
    };
    const finishFailureIfExhausted=()=>{
      if(settled)return;
      if(activeForWave(currentWave).length)return;
      if(currentWave<maxWaves){startNextWave('WAVE_FAILED');return;}
      settled=true;hedgeExhausted++;abortAttempts('HEDGE_EXHAUSTED');rejectTask(failures.at(-1)||new Error('fresh hedge waves exhausted'));
    };
    const startAttempt=wave=>{
      const id=++attemptSeq,controller=new AbortController(),startedAt=now(),a={id,wave,active:true,startedAt,budgetHeld:false};
      attempts.set(id,a);controllers.set(id,controller);holdLane(t,a);
      const ctx={completed:new Set(done),pruned:new Set(pruned),runningCount:running.size+1,maxConcurrency:max,makeContentKey,attempt:id,wave,signal:controller.signal,laneKey:t.laneKey,laneLimit:governor.laneLimit(t.laneKey),progress:detail=>{if(settled)return;materialProgressSignals++;const ack=emit({type:'RUNNER_PROGRESS',taskId:t.id,attempt:id,wave,laneKey:t.laneKey,detail:detail??null});if(ack)ack.catch(()=>{});},stall:reason=>{if(settled)return;earlyStallSignals++;stalled.add(id);const ack=emit({type:'RUNNER_STALL_SIGNAL',taskId:t.id,attempt:id,wave,laneKey:t.laneKey,reason:String(reason||'STALL')});if(ack)ack.catch(()=>{});if(wave===1&&!waveExpanded)expandWave('EARLY_STALL');else if(activeForWave(wave).length&&activeForWave(wave).every(x=>stalled.has(x.id)))startNextWave('ALL_ATTEMPTS_STALLED');}};
      Promise.resolve().then(()=>worker(t,ctx)).then(async value=>{
        a.active=false;releaseLane(t,a);
        await observeLane({ok:true,value,durationMs:Math.max(0,now()-startedAt)});
        if(settled)return;
        if(!(await validResult(value,a))){
          failures.push(new Error(value?.stalled?'stalled result':'invalid result'));
          stalled.add(id);
          if(wave===1&&!waveExpanded)expandWave('INVALID_OR_STALLED_RESULT');
          finishFailureIfExhausted();return;
        }
        settled=true;winnerAttempt=id;if(id===1)hedgePrimaryWins++;else hedgeWins++;
        abortAttempts('HEDGE_WINNER');
        resolveTask(value);
      }).catch(async error=>{
        a.active=false;releaseLane(t,a);
        await observeLane({ok:false,error,durationMs:Math.max(0,now()-startedAt)});
        if(settled)return;
        failures.push(error);
        if(wave===1&&!waveExpanded)expandWave('PRIMARY_FAILED');
        finishFailureIfExhausted();
      });
      return id;
    };
    const expandWave=reason=>{
      if(settled||!eligible||waveExpanded)return false;
      waveExpanded=true;freshHedges++;hedgeWaves++;
      const target=width();
      while(taskAttemptsForWave(1).length<target)startAttempt(1);
      const ack=emit({type:'FRESH_HEDGE_WAVE_STARTED',taskId:t.id,wave:1,width:target,reason,triggerMs:hardMs,laneKey:t.laneKey});
      if(ack)ack.catch(()=>{});
      scheduleTimer(hardMs);
      return true;
    };
    const startNextWave=reason=>{
      if(settled||!eligible||currentWave>=maxWaves)return false;
      currentWave++;waveExpanded=true;freshHedges++;hedgeWaves++;
      for(const [id,controller] of controllers){const a=attempts.get(id);if(a?.wave<currentWave&&!controller.signal.aborted){controller.abort('NEXT_HEDGE_WAVE');hedgeAbortRequests++;releaseLane(t,a);}}
      const target=width();
      for(let i=0;i<target;i++)startAttempt(currentWave);
      const ack=emit({type:'FRESH_HEDGE_WAVE_STARTED',taskId:t.id,wave:currentWave,width:target,reason,triggerMs:hardMs,laneKey:t.laneKey});
      if(ack)ack.catch(()=>{});
      scheduleTimer(hardMs);
      return true;
    };
    const onRecoveryDeadline=async()=>{
      if(settled)return;
      if(eligible){
        if(currentWave===1&&!waveExpanded){expandWave('HARD_10S_TRIGGER');return;}
        if(currentWave<maxWaves){startNextWave('WAVE_TIMEOUT');return;}
        settled=true;hedgeExhausted++;abortAttempts('HEDGE_TIMEOUT_EXHAUSTED');rejectTask(new Error('fresh hedge hard timeout exhausted'));return;
      }
      if(latencyUseful(t)&&!latencyBranchTriggered){
        latencyBranchTriggered=true;
        try{
          const spawned=t.latencySpawn.map(raw=>({...raw,detached:true}));
          await addTasks(t,spawned,'LATENCY_BRANCH');latencyBranches++;latencyBranchTasks+=spawned.length;latencyExpectedGainMs+=t.latencyBranchExpectedGainMs;
          await emitWait({type:'LATENCY_BRANCH_TRIGGERED',taskId:t.id,afterMs:t.latencyBranchAfterMs,spawnedTasks:spawned.map(x=>String(x.id)),expectedGainMs:t.latencyBranchExpectedGainMs,overheadMs:t.latencyBranchOverheadMs});
        }catch(e){latencyBranchFailures++;await emitWait({type:'LATENCY_BRANCH_FAILED',taskId:t.id,error:String(e?.message||e)});}
      }
    };

    startAttempt(1);
    if(eligible)scheduleTimer(hardMs);
    else if(latencyUseful(t))scheduleTimer(t.latencyBranchAfterMs);

    const promise=completion.then(async value=>{
      if(recoveryTimer)clearTimeout(recoveryTimer);
      rec.finishedAt=now();rec.status='COMPLETED';rec.winnerAttempt=winnerAttempt;rec.attempts=attemptSeq;if(t.kind==='integration')intNow--;
      results.set(t.id,value);done.add(t.id);running.delete(t.id);
      if(value?.spawn)await addTasks(t,value.spawn,'DISCOVERY_BRANCH');
      if(value?.prune)await pruneTasks(t,value.prune);
      if(value?.corrections)await addCorrections(t,value.corrections);
      if(t.cacheable&&t.cacheKey&&typeof cacheStore==='function'&&value?.cacheable!==false){await cacheStore(t.cacheKey,value,t);await emitWait({type:'CACHE_STORED',taskId:t.id,cacheKey:t.cacheKey});}
      await emitWait({type:'RUNNER_COMPLETED',taskId:t.id,workgroupId:t.workgroup||null,workgroupLabel:t.workgroupLabel||null,laneKey:t.laneKey,winnerAttempt,attempts:attemptSeq,running:running.size});
      return value;
    }).catch(async e=>{
      if(recoveryTimer)clearTimeout(recoveryTimer);
      rec.finishedAt=now();rec.status='FAILED';rec.error=String(e?.message||e);rec.attempts=attemptSeq;if(t.kind==='integration')intNow--;
      running.delete(t.id);await emitWait({type:'RUNNER_FAILED',taskId:t.id,workgroupId:t.workgroup||null,workgroupLabel:t.workgroupLabel||null,laneKey:t.laneKey,attempts:attemptSeq,error:rec.error});throw e;
    });
    const entry={task:t,promise,latencyWake:null};running.set(t.id,entry);
  };

  const executionStartAck=emit({type:'EXECUTION_STARTED',initialTasks:initial.length,maxConcurrency:max,adaptive:true});if(executionStartAck)await executionStartAck;
  while(pending.size||running.size){
    const cycleWakeGeneration=wakeGeneration;
    let launched=false;
    let {graph,scores}=schedulerView();
    let ready=[...pending].map(id=>tasks.get(id)).filter(t=>t&&!pruned.has(t.id)&&t.deps.every(d=>done.has(d)||pruned.has(d))).sort((a,b)=>(scores.get(b.id)||b.estimatedMs)-(scores.get(a.id)||a.estimatedMs));
    if(await resolveCacheFor(ready)){
      ({graph,scores}=schedulerView());
      ready=[...pending].map(id=>tasks.get(id)).filter(t=>t&&!pruned.has(t.id)&&t.deps.every(d=>done.has(d)||pruned.has(d))).sort((a,b)=>(scores.get(b.id)||b.estimatedMs)-(scores.get(a.id)||a.estimatedMs));
    }
    for(const t of ready){if(!canStart(t))continue;await launch(t);launched=true;if(running.size>=max)break;}
    if(running.size){
      if(wakeGeneration!==cycleWakeGeneration)continue;
      if(!launched||running.size>=max||!ready.length){
        const waiter=makeWakeWaiter();
        try{await Promise.race([...running.values()].map(x=>x.promise).concat(waiter.promise));}finally{waiter.cancel();}
      }
      continue;
    }
    if(pending.size)throw new Error('execution deadlock');
  }

  const overlaps=[],workRecords=records.filter(r=>r.status!=='CACHE_HIT');
  for(let i=0;i<workRecords.length;i++)for(let j=i+1;j<workRecords.length;j++)if(workRecords[i].startedAt<workRecords[j].finishedAt&&workRecords[j].startedAt<workRecords[i].finishedAt)overlaps.push([workRecords[i].id,workRecords[j].id]);
  const finalGraph=schedulerView().graph,effectiveRunnerCount=workRecords.length;
  const executionMode=effectiveRunnerCount<=1&&cacheHits===0?'DIRECT_FAST':max===1&&effectiveRunnerCount>1?'SERIAL_HOST_LIMITED':peak>1?'PARALLEL_OBSERVED':'SERIAL_REQUIRED';
  const governorSnapshot=governor.snapshot();
  if(typeof adaptiveStateStore==='function'){try{await adaptiveStateStore(governorSnapshot);adaptiveStateStored=true;}catch{}}
  const executionDoneAck=emit({type:'EXECUTION_COMPLETED',cacheHits,dynamicTasks,prunedTasks:pruned.size,latencyBranches,freshHedges,laneAdjustments,adaptiveStateLoaded,adaptiveStateStored});if(executionDoneAck)await executionDoneAck;
  return {results:Object.fromEntries(results),eventHistory,proof:{executionMode,runnerCount:effectiveRunnerCount,observedPeakConcurrency:peak,observedPeakIntegrationConcurrency:intPeak,singleIntegrationLaneVerified:intPeak<=1,overlapPairs:overlaps,criticalPath:criticalPath(finalGraph),correctionRelays,dynamicTasks,prunedTasks:[...pruned],cacheHits,cacheAvoidedEstimatedMs,latencyBranches,latencyBranchTasks,latencyExpectedGainMs,latencyBranchFailures,freshHedges,hedgeWaves,hedgeWins,hedgePrimaryWins,hedgeAbortRequests,hedgeSuppressedUnsafe,hedgeExhausted,materialProgressSignals,earlyStallSignals,laneAdjustments,laneThrottleSignals,laneSaturationSignals,adaptiveStateLoaded,adaptiveStateStored,adaptiveGovernor:governorSnapshot,schedulerGraphRecomputes,eventFastPathCount,eventsRecorded:eventHistory.length,records}};
}

export function formatProof(p={}){
  const path=(p.criticalPath?.path||[]).join(' -> ')||'n/a';
  const reuse=p.cacheHits?` — cache hit ${p.cacheHits}, lavoro evitato ~${p.cacheAvoidedEstimatedMs||0}ms`:'';
  const dynamic=p.dynamicTasks?` — rami dinamici ${p.dynamicTasks}, potati ${(p.prunedTasks||[]).length}`:'';
  const latency=p.latencyBranches?` — latency branch ${p.latencyBranches}, task ${p.latencyBranchTasks||0}, guadagno atteso ~${p.latencyExpectedGainMs||0}ms`:'';
  const wg=p.semanticWorkgroups?.mode==='SEMANTIC_PARALLEL'?` — workgroup semantici ${p.semanticWorkgroups.activeGroups?.length||0}, lavoro eliminato ${(p.semanticWorkgroups.eliminatedGroups||[]).length}, guadagno stimato ~${p.semanticWorkgroups.estimatedGainMs||0}ms`:p.semanticWorkgroups?.eliminatedGroups?.length?` — lavoro eliminato ${p.semanticWorkgroups.eliminatedGroups.length}`:'';
  const adaptive=p.freshHedges||p.laneAdjustments?` — hedge ${p.freshHedges||0} / wave ${p.hedgeWaves||0}, lane adjust ${p.laneAdjustments||0}`:'';
  if(p.executionMode==='PARALLEL_OBSERVED')return `Modalita: PARALLELA — picco ${p.observedPeakConcurrency||0} corridori reali — critical path: ${path}${reuse}${dynamic}${latency}${wg}${adaptive}`;
  if(p.executionMode==='SERIAL_HOST_LIMITED')return `Modalita: SERIALE LIMITATA DALL'HOST — 1 corridore — critical path: ${path}${reuse}${dynamic}${latency}${wg}${adaptive}`;
  if(p.executionMode==='DIRECT_FAST')return `Modalita: DIRECT FAST — nessun fan-out necessario — critical path: ${path}${reuse}${dynamic}${latency}${wg}${adaptive}`;
  return `Modalita: SERIALE NECESSARIA — dipendenze/conflitti impediscono fan-out utile — critical path: ${path}${reuse}${dynamic}${latency}${wg}${adaptive}`;
}
