'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ownsReadingKey}=require('../app/renderer/auto-page.js');
for(const key of ['PageDown','PageUp']){
 test(key+' routes body focus without relying on pointer position',()=>assert.equal(ownsReadingKey({key,bodyFocused:true}),true));
 test(key+' keeps controls in other panes untouched',()=>assert.equal(ownsReadingKey({key,hoveringReading:true}),false));
}
for(const key of ['ArrowDown','ArrowUp']){
 test(key+' still requires pointer for body fallback',()=>{assert.equal(ownsReadingKey({key,bodyFocused:true}),false);assert.equal(ownsReadingKey({key,bodyFocused:true,hoveringReading:true}),true);});
}
test('Focused reading pane supports all four navigation keys',()=>{for(const key of ['PageDown','PageUp','ArrowDown','ArrowUp'])assert.equal(ownsReadingKey({key,listFocused:true}),true);});
test('Other keys never gain reading ownership',()=>{for(const key of ['End','Home','Enter',' ',undefined])assert.equal(ownsReadingKey({key,listFocused:true,bodyFocused:true,hoveringReading:true}),false);});
