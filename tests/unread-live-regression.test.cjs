const {test}=require('node:test'),assert=require('node:assert/strict');
const {captureViewport,createReadIntentGate,unreadLabel}=require('../app/renderer/reading-state.js');
const view=items=>captureViewport({items,viewportTop:100,viewportHeight:500});
test('restored viewport advances beyond an older unread lazy image',()=>assert.equal(view([{id:'old',top:-600,bottom:-100,ready:false},{id:'visible',top:110,bottom:250,ready:true}]).readThroughId,'visible'));
test('partially visible pending image still blocks later text',()=>assert.equal(view([{id:'pending',top:80,bottom:120,ready:false},{id:'visible',top:130,bottom:250,ready:true}]).readThroughId,null));
test('pending image below viewport does not revoke preceding complete text',()=>assert.equal(view([{id:'visible',top:110,bottom:250,ready:true},{id:'pending',top:700,bottom:800,ready:false}]).readThroughId,'visible'));
test('oversize pending media spanning entire viewport cannot become read',()=>assert.equal(view([{id:'pending',top:-800,bottom:900,ready:false}]).readThroughId,null));
test('badge changes for every read above prior 999 cap',()=>{assert.equal(unreadLabel(1347),'1347');assert.equal(unreadLabel(1346),'1346');assert.equal(unreadLabel(1000),'1000');assert.equal(unreadLabel(999),'999');});
test('offscreen exemption does not grant passive input permission',()=>{const gate=createReadIntentGate();assert.equal(gate.scroll('group-a',100,20,'visible'),null);gate.arm('group-a',90,30,true);assert.equal(gate.scroll('group-b',100,40,'visible'),null);});
