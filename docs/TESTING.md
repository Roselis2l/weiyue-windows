# 测试与构建

## 核心测试

使用 Node.js 22+，在源码目录运行：

```powershell
.\scripts\test.ps1
```

1.1.38重点复验：

- 前缀删除推进群起点，中段删除不推进；续扫、导入、模式切换及并发响应尊重删除范围。
- 未读选择、阅读位置重定位、关联保护、预览取消与失效确认、格式5重启和重新获取时段。
- MOV/MP4真实容器识别、HEVC 100 MiB／60秒边界、取消与重试。
- 开机启动默认关闭、保存与取消、系统禁用状态和路径变更。
- 工具栏、左右栏、键盘与鼠标分页、主题、收藏摘要、附件及账号隔离。

删除和重新获取使用隔离合成数据。实际EXE测试需核对版本、GitHub版标识、源码哈希及sandbox、contextIsolation、webSecurity，并分别记录核心测试、窗口验收和外部服务测试结果。

## 构建

将核验过的Electron 44.9.0 Windows x64归档及其SHASUMS256.txt放入干净副本的vendor目录：

```powershell
.\scripts\package.ps1 -ElectronVersion 44.9.0 -OutputDirectory dist-1.1.38-github
```

产物核验包括源码与便携文件哈希、公开版撤回显示行为、第三方许可及对应源码。账号数据、凭据、真实媒体、私有诊断和备份不得进入发行材料。
