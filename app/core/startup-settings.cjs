'use strict';
const path=require('node:path');
function createStartupSettings({app,platform=process.platform,execPath=process.execPath,dataRoot}) {
  const supported=platform==='win32'&&app.isPackaged===true;
  const options={path:execPath,args:['--data-dir='+path.resolve(dataRoot)]};
  function get(){
    if(!supported)return {supported:false,enabled:false,blocked:false};
    const state=app.getLoginItemSettings(options);
    return {supported:true,enabled:state.openAtLogin===true,blocked:state.openAtLogin===true&&state.executableWillLaunchAtLogin===false};
  }
  function save(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='enabled')||typeof value.enabled!=='boolean')throw new Error('请选择有效的开机启动设置。');
    if(!supported)throw new Error('开机启动仅支持 Windows 安装版。');
    app.setLoginItemSettings({...options,openAtLogin:value.enabled});
    const state=get();
    if(state.enabled!==value.enabled)throw new Error('开机启动设置未生效，请重试。');
    return state;
  }
  return {get,save};
}
module.exports={createStartupSettings};
