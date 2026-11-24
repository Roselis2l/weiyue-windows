'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateBuildIdentity}=require('../app/core/build-identity.cjs');
test('fixed edition metadata rejects unlock flags and mismatched labels',()=>{
  assert.deepEqual(validateBuildIdentity({id:'github',label:'GitHub 版'},'1.1.27'),{id:'github',label:'GitHub 版',version:'1.1.27'});
  for(const value of [{id:'github',label:'防撤回版'},{id:'other',label:'GitHub 版'},{id:'github',label:'GitHub 版',enable:true}])assert.throws(()=>validateBuildIdentity(value,'1.1.27'));
  assert.throws(()=>validateBuildIdentity({id:'github',label:'GitHub 版'},'1.1.27<script>'));
});
