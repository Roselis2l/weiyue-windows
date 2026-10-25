# 文档预览组件

XLSX、CSV 和 Markdown 的本地预览由应用内有界读取器处理。XLSX 只读取 ZIP 中的表格 XML 数据，不执行公式、宏、HTML、外部关系或工作簿脚本；CSV 和 Markdown 作为文本数据读取。支持范围和限制见[使用说明](使用说明.md)。

XML 解析使用固定版本 **sax 1.6.1**，按 **BlueOak-1.0.0** 许可分发。完整源码 `sax.cjs`、上游 README、package.json、完整 `LICENSE.md` 和含来源/hash的 `SOURCE.json` 一起位于源码树 `app/third-party/sax/`；便携版对应 `resources/app/app/third-party/sax/`。本项目 MIT 许可不取代该组件自身许可。

解析器文件随应用提供，不在启动时联网安装依赖，不从文档加载代码。读取器关闭 XML DTD/实体声明，并限制 ZIP 展开量、XML 深度/节点数、显示行列和解析任务耗时；这些边界不代表会解密、运行或完整还原任何 Office 文件。
