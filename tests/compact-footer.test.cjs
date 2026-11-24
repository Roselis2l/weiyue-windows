'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),js=fs.readFileSync(path.join(root,'app/renderer/app.js'),'utf8'),css=fs.readFileSync(path.join(root,'app/renderer/style.css'),'utf8');
test('compact footer keeps unread and forward action adjacent and separates load-latest',()=>{
 assert.match(js,/const nextPage=node\('div',\{class:'next-page-group'\},unread,button\('更多消息/);
 assert.match(js,/const navigation=node\('div',\{class:'reading-navigation'\},button\('加载到最新',jumpToLatest/);
 assert.match(js,/id:'new-messages-notice',class:'new-messages-notice','aria-live':'polite'/);
 assert.match(js,/textContent=\x60\$\{unread\} 条未读\x60/);
});
test('footer spacing is compact and unread stays in the same nonwrapping group',()=>{
 assert.match(css,/\.reading-footer\{display:block;padding-top:3px;padding-bottom:3px;container-type:inline-size\}/);
 assert.match(css,/\.reading-navigation \.next-page-group\{[^}]*display:flex[^}]*white-space:nowrap/);
 assert.match(css,/@container \(max-width:480px\)/);
});
