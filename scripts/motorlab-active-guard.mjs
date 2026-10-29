#!/usr/bin/env node
// MotorLab r39: existing Project Continuity is the sole family authority. Read-only fail-closed CI gate.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const c=JSON.parse(fs.readFileSync('.motorlab/active-family.json','utf8'));
const sha=/^[0-9a-f]{40}$/i;
function validate(){
 assert.equal(c.schema,1,'schema');
 assert.match(c.repo,/^Br174\/[A-Za-z0-9.-]+$/);
 assert.match(c.active_ref,/^motorlab\/active-[a-z0-9-]+$/);
 assert.ok(sha.test(c.original_verified_sha),'pinned verified source SHA');
 for(const k of ['scudo_manifest','scudo_runner','native_workflow'])assert.ok(fs.existsSync(c[k]),'Missing '+k);
 assert.ok(fs.readFileSync(c.native_workflow,'utf8').includes(c.scudo_command),'Actual native workflow lacks mandatory Scudo runner');
 if(c.mode==='android-signed'){
   assert.match(c.application_id,/^[a-z][a-z0-9_.]+$/);
   assert.match(c.cert_sha256,/^[a-f0-9]{64}$/i);
 }else assert.equal(c.mode,'control-only','unrecognized signing mode');
}
function getJson(path){return JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']}));}
try{
 validate();
 if(process.argv.includes('--self-test'))console.log('ACTIVE_FAMILY_SELF_TEST_PASS '+c.repo);
 else {
   assert.equal(process.env.GITHUB_REPOSITORY,c.repo,'Wrong project/repository');
   const ref=getJson('repos/'+c.repo+'/git/ref/heads/'+c.active_ref);
   assert.ok(sha.test(ref.object?.sha||''),'Missing authoritative active ref');
   const current=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
   const comparison=getJson('repos/'+c.repo+'/compare/'+ref.object.sha+'...'+current);
   assert.ok(['ahead','identical'].includes(comparison.status),'WRONG_FAMILY: source does not descend from currently verified active ref');
   console.log('ACTIVE_FAMILY_PASS repo='+c.repo+' ref='+c.active_ref+' base='+ref.object.sha+' current='+current+' Scudo=REQUIRED');
 }
}catch(e){console.error('ACTIVE_FAMILY_BLOCKED '+(e.stderr?.toString()||e.message));process.exitCode=71;}
