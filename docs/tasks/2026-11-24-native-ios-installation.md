# Native iOS 官网安装区

## 原始需求

1. 修复 Native iOS 两个按钮挤在一起。
2. 源按钮命名为 `LiveContainer source link`；点击显示完整链接并自动复制，链接旁保留复制按钮。
3. 添加直接下载 IPA 文件的按钮。
4. 针对 Native iOS 比其他卡片复杂的内容，整理布局与操作层级。

## 约束与验收

- 保留现有官网视觉与其他四个平台入口。桌面 Native iOS 占两列，移动端回到单列，按钮有明确间距且无横向溢出。
- 源地址完整显示为 https://onedrop.sycamore.top/apps.json；支持自动复制、手动重试和复制失败反馈，键盘可操作。
- IPA 入口直接指向正式版 IPA 附件，跟随现有发布数据更新，不能误选 Beta 或仅打开 Releases 列表。
- 保留安装指南，说明 IPA 供 LiveContainer 导入。
- 使用现有工具验证正常流程、复制失败、下载数据及响应式布局。独立验收最终 diff。
- 本任务修改本地官网源文件；不包含发布新版安装包或 Edge 商店送审。

## 状态

实现完成，独立验收通过；用户已确认效果并授权发布官网，进入发布流程。

## 实际改动和验证证据

- `docs/index.html`：Native iOS 桌面跨两列、移动单列；订阅源为主操作，下载与指南分层；链接展开后自动复制，保留完整链接、复制按钮及失败反馈。
- 下载复用现有 `apps.json` 已排序正式版本数据，选择稳定应用身份的首个 IPA；加载失败提供重试，不回退到历史包或伪装成直接下载的 Releases 页面。
- `tests/unit/website-installation.test.ts`：6 项通过，覆盖复制成功/重试/拒绝/不可用、正式 IPA 选择、源失败/空数据/非法地址与重试恢复。
- `npx eslint tests/unit/website-installation.test.ts` 与目标 HTML、测试文件的 Prettier 检查通过。
- 独立浏览器验收：320/375/810/1440px 均无横向溢出；按钮间距 12px，桌面跨两列、移动单列。实际剪贴板内容为完整源地址；键盘复制、复制失败反馈、HTTP 503 后键盘重试恢复正式 IPA 均通过。
- 主代理目视复核桌面与 320px 截图通过：`/tmp/onedrop-ios-acceptance/ios-1440.png`、`/tmp/onedrop-ios-acceptance/ios-320.png`。
- 官网源实时核实：稳定应用 `com.sycamore.onedrop` 当前首版本为 1.2.0，IPA 指向对应 GitHub Release 附件。未执行 iPhone 真机安装；本任务不涉及安装包变更。
- `git diff --check` 通过。

## 用户反馈与返工（2026-11-24）

用户反馈：“No，这不是我要的，那个弹出来的链接不能占那么多内容”。

补充验收条件：链接使用不参与文档流的紧凑浮层，开关不改变卡片高度；浮层正常状态只显示完整链接和复制按钮；点击源按钮自动复制，再次点击、外部点击或 Escape 关闭；Escape 恢复焦点，移动端保持视口内；复制失败保留简短手动复制提示。

返工实现：改为按钮下方绝对定位浮层，移除说明段落和成功提示块；复制成功直接显示 `Copied`，失败显示短句；视口边缘自动调整浮层位置。新增关闭方式与焦点测试。7 项针对性测试、ESLint 通过；最终独立浏览器复验通过。

最终微调：复制按钮固定 44 × 44px，使用复制图标，成功显示小勾；无障碍名称保留复制与成功状态，避免反馈文字改变链接换行。

返工独立复验：320/375/810/1440px 开关前后卡片高度完全一致；浮层高 62px 且无横向溢出。真实剪贴板、手动复制、失败恢复、重复点击/外部点击/Escape 关闭、键盘与焦点恢复及正式 IPA 回归均通过。独立运行 7 项测试与 diff 检查通过。主代理复核最终截图 `/tmp/onedrop-ios-acceptance/final-popover-1440.png`、`/tmp/onedrop-ios-acceptance/final-popover-320.png`。尚未提交或部署，未测真实 iOS Safari。

## 安装指南按钮统一（2026-11-24）

用户反馈：“统一installation guide的按钮样式啊”。Native iOS 安装指南改用与 Android Edge、iOS Edge 相同的 `platform-action` 按钮和 `platform-action-icon` 图标结构；移除原下划线文本链接样式，并取消该按钮独有的最小高度，确保背景、字体、圆角、内边距、图标与实际高度一致。保留操作组间距、紧凑源链接浮层与 IPA 下载行为。验收重点为三个 Installation guide 按钮的实际视觉尺寸一致。

目标文件 Prettier 检查与 `git diff --check` 通过，等待独立复验。

指南按钮最终独立复验通过：三个 Installation guide 的背景、字体、圆角、padding、箭头图标一致，实际高度均为 38.39px。320/375/810/1440px 无横向溢出，浮层开关不改变卡片高度；7 项回归测试与 git diff --check 通过。截图：`/tmp/onedrop-ios-acceptance/guide-final-1440.png`、`/tmp/onedrop-ios-acceptance/guide-final-320.png`。尚未提交或部署。

## 官网发布（2026-11-24）

用户确认效果并要求“可以，发布到官网吧”。发布范围为本任务官网页面、回归测试及任务记录，通过 main 的 /docs GitHub Pages 发布。发布前已确认本地 main 与 origin/main 一致，工作区只含本任务改动，最终格式检查通过。发布后核实 Pages 构建结果和线上交互。
