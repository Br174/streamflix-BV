import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * MotorLab Scudo 360 Qualita r40: read-only companion of the EXISTING r39
 * executable gate. It never runs tests, schedules work, signs APKs or promotes.
 * Only exact-source native JUnit evidence may establish a CI finding.
 */
const SHA=/^[0-9a-f]{40}$/i;
const KEY=/^[a-z0-9][a-z0-9._-]{1,127}$/i;
const problem=(code,detail='')=>({code,detail});
const list=v=>Array.isArray(v)?v:[];
const byId=rows=>new Map(list(rows).map(r=>[r.id,r]));

export function assessQualityR40({
  manifest, after, before=null, requestTrace, expectedCommit,
  baselineCommit=null, surface='ci', artifactReceipt=null
}={}) {
  const errors=[];
  const rows=[];
  if(!SHA.test(expectedCommit||''))errors.push(problem('TARGET_SHA_INVALID'));
  if(after?.commit!==expectedCommit||after?.passed!==true)
    errors.push(problem('TARGET_REPORT_UNVERIFIED_OR_WRONG_COMMIT'));
  if(!['ci','android-device','web-runtime'].includes(surface))
    errors.push(problem('SURFACE_UNKNOWN',String(surface)));
  const contracts=byId(manifest?.contracts);
  const verified=byId(after?.contracts);
  const requested=list(requestTrace), seen=new Set();
  if(requested.length===0)errors.push(problem('NO_REQUEST_TRACE'));
  for(const req of requested){
    if(!req||typeof req.id!=='string'||!KEY.test(req.id)||seen.has(req.id)){
      errors.push(problem('REQUEST_ID_INVALID_OR_DUPLICATE',String(req?.id)));continue;
    }
    seen.add(req.id);
    if(!list(req.contractIds).length)errors.push(problem('REQUEST_WITHOUT_CONTRACT',req.id));
    const evidence=[];
    for(const cid of list(req.contractIds)){
      const canonical=contracts.get(cid), executed=verified.get(cid);
      const mandatory=canonical&&['P0','P1'].includes(canonical.priority);
      const expectedClasses=list(canonical?.junitClasses);
      const actualClasses=list(executed?.classEvidence);
      const classes=expectedClasses.map(name=>({
        name,passed:actualClasses.filter(c=>c.name===name&&c.passed===true).length===1
      }));
      const passed=Boolean(mandatory&&expectedClasses.length&&executed?.status==='passed'&&classes.every(c=>c.passed));
      evidence.push({contractId:cid,passed,classes});
      if(!passed)errors.push(problem('REQUEST_CONTRACT_NOT_EXECUTED',req.id+':'+cid));
    }
    rows.push({requestId:req.id,sourceCommit:after?.commit||null,contracts:evidence,
      status:evidence.length&&evidence.every(e=>e.passed)?'CI_CONTRACTS_PASSED':'BLOCKED'});
  }
  let comparison='PENDING_BASELINE';
  if(before!==null||baselineCommit!==null){
    if(!SHA.test(baselineCommit||'')||before?.commit!==baselineCommit||before?.passed!==true||
       baselineCommit===expectedCommit){
      errors.push(problem('BASELINE_UNVERIFIED_OR_WRONG_COMMIT'));
    }else{
      const prior=byId(before.contracts);
      for(const row of rows)for(const item of row.contracts){
        const old=prior.get(item.contractId), current=verified.get(item.contractId);
        if(old?.status==='passed'&&current?.status!=='passed')
          errors.push(problem('BEFORE_AFTER_REGRESSION',row.requestId+':'+item.contractId));
      }
      comparison='EXACT_COMMIT_COMPARISON_VERIFIED';
    }
  }
  // Provenance values must match the native signed-APK receipt; syntactic
  // fields alone are not an independent installation or signature test.
  const artifactLinked=Boolean(artifactReceipt &&
    artifactReceipt.sourceCommit===expectedCommit &&
    /^[a-f0-9]{64}$/i.test(artifactReceipt.apkSha256||'') &&
    /^[a-f0-9]{64}$/i.test(artifactReceipt.certSha256||'') &&
    Number.isSafeInteger(artifactReceipt.versionCode) && artifactReceipt.versionCode>0 &&
    typeof artifactReceipt.applicationId==='string' &&
    /^[a-z][a-z0-9_.]+$/.test(artifactReceipt.applicationId) &&
    Number.isSafeInteger(artifactReceipt.runId) && artifactReceipt.runId>0);
  if(artifactReceipt!==null&&!artifactLinked)
    errors.push(problem('ARTIFACT_RECEIPT_UNVERIFIED_OR_WRONG_COMMIT'));
  const blocked=errors.length>0;
  const deviceAcceptance=surface==='ci'?'NOT_REQUIRED_FOR_CI':
    'PENDING_REAL_DEVICE_OR_RUNTIME_EVIDENCE';
  const status=blocked?'BLOCKED':
    comparison==='PENDING_BASELINE'?'PENDING_BASELINE':
    deviceAcceptance!=='NOT_REQUIRED_FOR_CI'&&!artifactLinked?'PENDING_ARTIFACT':
    deviceAcceptance!=='NOT_REQUIRED_FOR_CI'?'PENDING_DEVICE':'CI_BEFORE_AFTER_VERIFIED';
  return {
    schemaVersion:1,feature:'motorlab-scudo360-quality-r40',authority:'existing-Change-Compatibility-Guard',
    status,passed:status==='CI_BEFORE_AFTER_VERIFIED',targetCommit:expectedCommit||null,
    baselineCommit:baselineCommit||null,comparison,deviceAcceptance,
    artifactReceiptStatus:artifactLinked?'NATIVE_CI_FIELDS_LINKED_NOT_DEVICE_PROOF':'PENDING',
    requests:rows,errors,
    certifiedScope:status==='CI_BEFORE_AFTER_VERIFIED'?'CI_AND_MAPPED_JUNIT_ONLY':'NONE'
  };
}

/** Native CI adapter: consume existing Scudo360 report; NEVER execute tests twice. */
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [manifestPath,reportPath,planPath,outPath]=process.argv.slice(2);
    if(!manifestPath||!reportPath||!planPath||!outPath)
      throw new Error('Usage: node scudo360-quality-r40.mjs contracts.json scudo360-report.json r40-plan.json r40-report.json');
    const load=p=>JSON.parse(fs.readFileSync(p,'utf8'));
    const manifest=load(manifestPath),after=load(reportPath),plan=load(planPath);
    const baseline=plan.baselineReportPath?load(plan.baselineReportPath):null;
    const artifact=plan.artifactReceiptPath?load(plan.artifactReceiptPath):null;
    const result=assessQualityR40({manifest,after,before:baseline,
      requestTrace:plan.requestTrace,expectedCommit:process.env.GITHUB_SHA||null,
      baselineCommit:plan.baselineCommit||null,surface:plan.surface||'ci',
      artifactReceipt:artifact});
    const abs=path.resolve(outPath),cwd=path.resolve('.');
    if(!abs.startsWith(cwd+path.sep))throw new Error('OUTPUT_OUTSIDE_REPOSITORY');
    fs.mkdirSync(path.dirname(abs),{recursive:true});
    fs.writeFileSync(abs,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({status:result.status,targetCommit:result.targetCommit,
      requests:result.requests.map(x=>({id:x.requestId,status:x.status})),
      errors:result.errors},null,2));
    if(result.status==='BLOCKED'||(process.env.SCUDO360_R40_PROMOTION==='1'&&!result.passed))
      process.exitCode=1;
  }catch(e){console.error('SCUDO360_R40_ERROR '+(e?.message||String(e)));process.exitCode=1;}
}
