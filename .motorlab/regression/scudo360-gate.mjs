#!/usr/bin/env node
/**
 * MotorLab Scudo 360 - portable, evidence-first regression gate.
 * LAB implementation; extends existing Behavior Memory and Compatibility Guard.
 * No writer, scheduler, release promoter, remote service or AI verdict.
 * CLI: node scudo360-gate.mjs <manifest.json> [lab|promotion] [report.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SAFE_ID=/^[a-z][a-z0-9-]*$/;
const SAFE_FILE=/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_./-]+$/;
const LEVELS=new Set(['lab','promotion']);
function issue(code,detail=''){return {code,detail};}
function cleanFile(p){return typeof p==='string' && SAFE_FILE.test(p) && !p.includes('//');}
function existingFile(root,p){return cleanFile(p)&&fs.existsSync(path.resolve(root,p))&&fs.statSync(path.resolve(root,p)).isFile();}
function javaReports(dir){
  if(!fs.existsSync(dir)) return {tests:0,failures:0,errors:0,skipped:0,files:0,failedFiles:[],classes:[]};
  const files=fs.readdirSync(dir).filter(x=>/^TEST-.+\.xml$/.test(x));
  const total={tests:0,failures:0,errors:0,skipped:0,files:files.length,failedFiles:[],classes:[]};
  for(const file of files){
    const xml=fs.readFileSync(path.join(dir,file),'utf8');
    const root=xml.match(/<testsuite\b[^>]*>/);
    if(!root) continue;
    if (/\b(?:failures|errors)="[1-9][0-9]*"/.test(root[0])) total.failedFiles.push(file);
    const className=file.slice(5,-4);
    const classEvidence={name:className,tests:0,failures:0,errors:0,skipped:0};
    total.classes.push(classEvidence);
    for(const key of ['tests','failures','errors','skipped']){
      const m=root[0].match(new RegExp('\\b'+key+'="(\\d+)"'));
      const value=m?Number(m[1]):0;
      total[key]+=value;
      classEvidence[key]+=value;
    }
  }
  return total;
}
export function preflight(manifest,{root=process.cwd(),level='lab'}={}){
  const errors=[];
  if(!LEVELS.has(level))errors.push(issue('INVALID_LEVEL',level));
  if(manifest?.schemaVersion!==1)errors.push(issue('INVALID_SCHEMA'));
  if(typeof manifest?.project!=='string'||!SAFE_ID.test(manifest.project))errors.push(issue('INVALID_PROJECT'));
  if(!Array.isArray(manifest?.suites)||!manifest.suites.length)errors.push(issue('MISSING_SUITES'));
  if(!Array.isArray(manifest?.contracts)||!manifest.contracts.length)errors.push(issue('MISSING_CONTRACTS'));
  const suites=new Map();
  for(const s of manifest?.suites||[]){
    if(!s||typeof s.id!=='string'||!SAFE_ID.test(s.id)){errors.push(issue('INVALID_SUITE_ID'));continue;}
    if(suites.has(s.id))errors.push(issue('DUPLICATE_SUITE',s.id));
    suites.set(s.id,s);
    if(!Array.isArray(s.command)||s.command.length<2||!['node','python3','bash','./gradlew'].includes(s.command[0])||
      s.command.some(a=>typeof a!=='string'||!a.trim()||a.includes('\n')||a.includes('\r')))
      errors.push(issue('INVALID_COMMAND',s.id));
    if(!Array.isArray(s.paths)||!s.paths.length||s.paths.some(p=>!existingFile(root,p)))
      errors.push(issue('SUITE_TEST_PATH_MISSING',s.id));
    if(!cleanFile(s.junitDir||''))errors.push(issue('INVALID_JUNIT_DIR',s.id));
    if(!Number.isSafeInteger(s.timeoutMs)||s.timeoutMs<1000||s.timeoutMs>1800000)
      errors.push(issue('INVALID_TIMEOUT',s.id));
  }
  const contractIds=new Set();
  const CLASS_ID=/^[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)+$/;
  for(const c of manifest?.contracts||[]){
    if(!c||typeof c.id!=='string'||!c.id.trim()){errors.push(issue('INVALID_CONTRACT'));continue;}
    if(contractIds.has(c.id))errors.push(issue('DUPLICATE_CONTRACT',c.id));
    contractIds.add(c.id);
    if(!['P0','P1','P2'].includes(c.priority))errors.push(issue('INVALID_PRIORITY',c.id));
    if(!Array.isArray(c.suites)||!c.suites.length)errors.push(issue('UNCOVERED_CONTRACT',c.id));
    for(const id of c.suites||[])if(!suites.has(id))errors.push(issue('UNKNOWN_SUITE',c.id+':'+id));
    if(!Array.isArray(c.junitClasses)||!c.junitClasses.length||
      c.junitClasses.some(name=>typeof name!=='string'||!CLASS_ID.test(name)))
      errors.push(issue('MISSING_CONTRACT_JUNIT_CLASSES',c.id));
    for(const cls of c.junitClasses||[]){
      const basename=cls.split('.').pop();
      const hasDeclaredFile=(c.suites||[]).some(id=>
        (suites.get(id)?.paths||[]).some(p=>p.endsWith('/'+basename+'.kt')||p.endsWith('/'+basename+'.java')||p.endsWith('/'+basename+'.mjs')));
      if(!hasDeclaredFile)errors.push(issue('CONTRACT_CLASS_NOT_MAPPED_TO_SOURCE',c.id+':'+cls));
    }
    if(!Array.isArray(c.requiredAt)||c.requiredAt.some(x=>!LEVELS.has(x))||
      (['P0','P1'].includes(c.priority)&&!c.requiredAt?.includes('promotion')))
      errors.push(issue('INVALID_REQUIRED_AT',c.id));
  }
  return {valid:errors.length===0,errors,project:manifest?.project||null,
    suiteCount:suites.size,contractCount:contractIds.size,level};
}
export function evaluate(manifest,results,level='lab'){
  const errors=[], performed=new Map(results.map(r=>[r.id,r]));
  const contracts=[];
  for(const c of manifest.contracts){
    const required=c.requiredAt.includes(level);
    const suiteResults=c.suites.map(id=>performed.get(id));
    const suitePass=suiteResults.every(r=>r&&r.status==='passed'&&r.tests>0&&r.failures===0&&r.errors===0&&r.skipped===0);
    const classes=(c.junitClasses||[]).map(name=>{
      const candidates=suiteResults.flatMap(r=>r?.classes||[]).filter(x=>x.name===name);
      return {name,passed:candidates.length===1&&candidates[0].tests>0&&
        candidates[0].failures===0&&candidates[0].errors===0&&candidates[0].skipped===0};
    });
    const passed=suitePass&&classes.length>0&&classes.every(x=>x.passed);
    if(required&&!passed)errors.push(issue('REQUIRED_CONTRACT_FAILED',c.id));
    contracts.push({id:c.id,priority:c.priority,required,status:passed?'passed':required?'failed':'unverified',classEvidence:classes});
  }
  const requiredCount=contracts.filter(c=>c.required).length;
  if(!requiredCount)errors.push(issue('NO_REQUIRED_CONTRACTS'));
  return {passed:errors.length===0,errors,contracts,
    requiredCount,verifiedCount:contracts.filter(c=>c.required&&c.status==='passed').length};
}
export function run(manifest,{root=process.cwd(),level='lab',reportFile=null,spawn=spawnSync}={}){
  const validity=preflight(manifest,{root,level});
  const report={schemaVersion:1,gate:'MotorLab-Scudo360',authority:'MOTORLAB_CHANGE_COMPATIBILITY_GUARD_V1',
    project:manifest?.project||null,level,preflight:validity,suites:[],contracts:[],passed:false,
    timestamp:new Date().toISOString(),commit:process.env.GITHUB_SHA||null};
  if(validity.valid){
    const required=new Set(manifest.contracts.filter(c=>c.requiredAt.includes(level)).flatMap(c=>c.suites));
    for(const s of manifest.suites.filter(s=>required.has(s.id))){
      const junit=path.resolve(root,s.junitDir);
      // Reject stale success evidence. Report directories must live beneath project root.
      if(!junit.startsWith(path.resolve(root)+path.sep))throw new Error('JUNIT_OUTSIDE_ROOT');
      fs.rmSync(junit,{recursive:true,force:true});
      const start=Date.now();
      const child=spawn(s.command[0],s.command.slice(1),{cwd:root,encoding:'utf8',
        timeout:s.timeoutMs,env:process.env,maxBuffer:1024*1024*8});
      const measured=javaReports(junit);
      const status=child.status===0&&!child.error&&measured.tests>0&&
        measured.failures===0&&measured.errors===0&&measured.skipped===0?'passed':'failed';
      report.suites.push({id:s.id,status,exitCode:child.status,elapsedMs:Date.now()-start,
        ...measured,error:child.error?String(child.error):null,
        logTail:((child.stdout||'')+'\n'+(child.stderr||'')).slice(-4000)});
    }
    const verdict=evaluate(manifest,report.suites,level);
    report.contracts=verdict.contracts;report.errors=verdict.errors;
    report.passed=verdict.passed;
    report.requiredCount=verdict.requiredCount;
    report.verifiedCount=verdict.verifiedCount;
  }else report.errors=validity.errors;
  if(reportFile){
    const target=path.resolve(root,reportFile);
    if(!target.startsWith(path.resolve(root)+path.sep))throw new Error('REPORT_OUTSIDE_ROOT');
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');
  }
  return report;
}
const direct=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    const file=process.argv[2], level=process.argv[3]||'lab', dest=process.argv[4]||'.motorlab/scudo360-report.json';
    if(!file||!cleanFile(file))throw new Error('Usage: node scudo360-gate.mjs manifest.json [lab|promotion] [report.json]');
    const registry=JSON.parse(fs.readFileSync(file,'utf8'));
    const result=run(registry,{level,reportFile:dest});
    console.log(JSON.stringify({passed:result.passed,project:result.project,level:result.level,
      suites:result.suites.map(x=>({id:x.id,status:x.status,exitCode:x.exitCode,tests:x.tests,failures:x.failures,errors:x.errors,skipped:x.skipped,failedFiles:x.failedFiles,verifiedClasses:(x.classes||[]).filter(c=>c.tests>0).length,elapsedMs:x.elapsedMs})),
      contracts:result.contracts,errors:result.errors},null,2));
    if(!result.passed)process.exitCode=1;
  }catch(error){console.error('SCUDO360_GATE_ERROR '+String(error?.message||error));process.exitCode=1;}
}
