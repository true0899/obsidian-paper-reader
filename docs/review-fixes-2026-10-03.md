# 审查建议处理记录

依据桌面的 `Paper-Reader-审查报告.md`，逐项核对当前源码。原有 PDF、标注和 AI 服务配置不做数据迁移；版本仍为 0.1.10，未创建 Git 提交或发布。

| 报告项 | 处理与证据 |
|---|---|
| 1. 主视图职责过多 | 画笔与矩形手势提取为 `DrawingController`；搜索扫描、定位和临时高亮提取为 `SearchController`；位置几何计算提取为 `ReadingPositionManager`；流式传输和 SSE 解析独立模块。主视图仍负责组件装配、页面队列及标注持久化。避免引入 mixin。 |
| 2. 缺少真实流式传输 | 请求 `stream:true`，按 SSE 事件逐段显示。支持分段 UTF-8、CRLF、结束标志、服务商错误和不完整响应检查。服务商返回 JSON 时兼容一次性响应。 |
| 3. 位置记录无上限 | 最新 200 份文件；加载与保存都裁剪；文件/文件夹删除清理；延迟保存不恢复已删除记录。保留重命名迁移。 |
| 4. 缩放手势 | Ctrl/Cmd+滚轮、Chromium 的 pinch wheel 事件；合并连续事件、串行刷新，保留指针对应 PDF 坐标；普通滚动保持原行为。 |
| 5. 页面渲染失败 | 单页显示“重试此页”，清除该页失败状态并重启渲染；其余页可继续使用。 |
| 6. 未使用 ESLint | 删除未使用依赖。不增加与项目现有 TypeScript 检查重复的 lint 流程。 |
| 7. 请求无法取消 | 每个翻译弹窗和回答面板持有 AbortController；关闭、替换选区、切换文件时取消；连接测试关闭设置时取消；请求总时限 120 秒。 |
| 8. 中英界面 | `i18n.ts`，优先 Obsidian 语言；英文界面已通过真实浏览器检查。译文目标语言、提示词及既有笔记数据保持原值。 |
| 9. 键盘操作 | 搜索关闭还原焦点；P 切换画笔，输入框内不触发；颜色支持方向键/Home/End；缩略图支持键盘导航和激活。 |
| 10. 构建产物被追踪 | 当前 `.gitignore` 已排除 main.js/styles.css，`git ls-files` 确认未追踪。报告这一项不适用于当前代码。 |
| 11. 版本同步 | 构建从 package.json 同步 manifest.json 和 versions.json；未升级版本号。 |
| 12. 宿主内部 API | `obsidian-internals.ts` 集中检查扩展映射、文件视图、标题刷新。缺失或不兼容 API 安全降级。 |
| 13. 字段与异步命名 | 将画笔按钮、当前标注 ID 字段归到状态声明区；保留事件回调 void 与需要结果时 await 的语义，避免机械改名。 |
| 14. 内存与监听 | 选区缓存 LRU：100 条/500000 字符，关闭清空。document 监听原本由 Obsidian Component 注册和销毁；每个视图监听自己的选区不是已证实泄漏。 |
| 15. 开发依赖 | Node 类型与 Node 24 对齐；tslib 被 importHelpers 使用，保留。未无依据升级其他包。 |
| 16. 更新记录 | 新增 CHANGELOG，只记录已核实的本次维护。 |

移动端、跨 PDF 搜索、Zotero 标注导入、书签等属新功能建议，本次不新增。

## 网络行为

桌面端使用 Node HTTP(S) 读取响应流，避免浏览器 CORS 限制；保留 HTTPS/本机 HTTP 白名单，拒绝跟随重定向。不会通过开发者服务器。此传输不继承 Chromium 的代理设置。浏览器测试使用 fetch 和模拟 SSE，本地 Node 接口检查了真实分段传输及取消后断开连接。未向真实 AI 服务发送测试 PDF。

网络 API 依据：[Node HTTP 的 AbortSignal 行为](https://nodejs.org/api/http.html#httprequesturl-options-callback)；[Electron net 仅在 main/utility 进程可用](https://www.electronjs.org/docs/latest/api/net/)。

## 验证

`npm run check` 包含单元测试、TypeScript/生产构建、Playwright 实际行为检查。最终分别通过单元测试/构建和浏览器检查，共 95 项单元测试、100 项浏览器检查。新增测试覆盖 SSE 的首段到达、请求中止/超时、页面失败重试、指针缩放锚点、焦点恢复、键盘导航、缓存容量、位置裁剪、英文界面及取消后不创建翻译标注。

实际重载时另发现隐藏视图可能把第一页错误保存成末页。已改为保留最近一次有效布局的位置；浏览器回归检查覆盖隐藏视图保存。在 Obsidian 中关闭并重新打开 WEFT，已确认恢复第一页，原有高亮仍显示。最新构建已安装到现有 Vault，覆盖前的插件文件已备份。
