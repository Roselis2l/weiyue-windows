# 登录主进程集成复验

本页保留公开复验方法，不分发历史运行报告、账号统计或内部证据。环境准备、运行时和隔离资料要求见 [TESTING.md](TESTING.md)。

```powershell
node .\scripts\login-integration.cjs .\dist-public-1.1.16\WeiYue-Windows-x64\WeiYue.exe
```

检查身份→群列表→身份复核、超大 ID、取消、超时、持久化和账号切换。拦截官方窗口导航并替换传输，不验证真实认证或平台风控。必须显式传入本次 portable EXE，避免历史默认位置。

使用虚构消息和模拟服务，不向 AI 或 Notion 发送真实资料。测试产生的 artifacts 与 profile 不随发行包分发。实际结果注明源码/包版本和执行范围，当前状态见 [1.1.16 更新说明](1.1.16更新说明.md)。真实平台拒绝时停止，不轮换身份或削弱安全设置。
