# 官网版本时间线预览

## 原始需求与范围

用户希望官网安装区下方提供版本更新说明时间线，确认按新到旧展示版本号、发布日期、新增和修复摘要，近期版本展示、旧版本折叠，每项附 Release 链接。用户要求先做一版看效果。

## 验收条件

- 只制作一版可交互预览，放在 work/sketches/release-timeline/，不修改正式官网、不提交或发布。
- 保留官网品牌、已确认的安装区布局；时间线位于安装区下方。
- 使用实际 GitHub Releases 的日期和内容，按版本新到旧排序，1.2.0 为最新；历史补发日期不能误当作版本顺序。
- 最新几个版本可读，旧版本可展开/收起，Release 链接有效。
- 桌面和移动端截图目视检查，无溢出；展示效果给用户选择。

## 状态

已正式接入并发布官网，线上独立验收通过。历史预览过程与最终发布证据见下文。

## 预览实现

- `work/sketches/release-timeline/index.html`：复制现有官网上下文，在安装区后加入一版纵向时间线；最新版本蓝色标记，默认展示 1.2.0、1.1.3、1.1.2，其余五版原生 details 折叠。
- 真实 Release 摘要与链接，按数值版本排序；日期由实际 `published_at` 转为 Asia/Shanghai 显示，保留原始时间戳。
- 本地 assets 和官方 apps.json 快照保证独立预览的图片及原有下载交互；README 记录设计选择、来源、交互与预览方式。
- 基本检查：8 个版本的 Release 链接和原始时间戳全部存在，图片路径全部有效，格式检查通过。待独立浏览器验收与截图复核。

## 交付与验证

- 预览：`work/sketches/release-timeline/index.html#updates`；包含原官网上下文、实际发布摘要和独立本地资源。正式 `docs/index.html` 未改动。
- 交互：默认展示3版，展开后8版；可用键盘收起。8项日期时间戳及Release链接均与源数据一致。
- 独立检查：320/375/810/1440px 无横向溢出；桌面与移动截图目视通过，主代理复核通过。
- 截图：`/tmp/onedrop-timeline-acceptance/timeline-desktop-context.png`、`/tmp/onedrop-timeline-acceptance/timeline-mobile.png`。
- 本地预览：`http://127.0.0.1:8766/index.html#updates`。尚未提交或发布，等待用户反馈。

## 点线与折叠位置返工

用户反馈：线没有从圆点正中穿过；展开后的 Hide 应位于所有历史记录最下方；首点上方和末点下方不能有多余连线。

改动：统一每条记录的圆点与连线坐标；每条连线从本节点下边缘连接到下一个节点上边缘，最后可见节点不生成连线。桌面和移动端共用此几何规则。折叠控件改为所有记录之后的同一个按钮，展开后位于第八条之后，收起后回到第三条之后并保持焦点与可见位置。正式官网未改动。

复验要求：四种视口下，折叠三条/展开八条均检查点线中心与首尾边缘；Hide 只在最底部；键盘收起后焦点保留、按钮可见。等待独立验收。

独立复验首次发现伪元素未继承全局 `box-sizing`，节点边框导致中心偏移 2px；已显式设为 `border-box` 后复验。最终 4 种视口 × 2 种展开状态全部通过：点线横向中心误差 0px，连线从节点下缘到下一节点上缘，接缝误差不超过 0.0005px；末节点无下方连线。唯一底部控件位置、键盘收起后的焦点与视口均通过。截图位于 `/tmp/onedrop-timeline-acceptance/fixed-{375,1440}-{top,collapsed-end,expanded-end}.png`，独立验收员全部目视通过。

## 间距、滚动、动画与节点交互返工

用户提出七项要求：缩小版本间距；展开不得跟随底部按钮滚动；删除无用 Get started；减少 Releases 底部空档；加入合适展开/收起动画；恢复蓝点柔和外环；节点随选中与 hover 改变。

实现与待复验条件：

1. 缩小条目上下 padding、摘要间距及标题间距。
2. 分离 Show 与底部 Hide，展开前聚焦固定位置的第三版选择按钮并禁用滚动锚定；展开前、中、后 scrollY 必须一致。
3. 删除 Get started，引用旧下载锚点的入口改为安装区。
4. Releases 底部 padding 为 36px，直接接页脚。
5. 旧版区使用 300ms 高度与轻淡入动画；减少动态效果偏好下不执行动画；短动画期间忽略重复操作，避免状态竞争。
6. 选中节点恢复蓝实心与 5px 柔和外环；最新标记与选中状态独立。
7. 正文点击或版本按钮键盘激活可选中对应版本，hover/focus 显示蓝边淡环；Release 链接保持独立。继续复验点线中心、首尾边缘及无溢出。

已交独立浏览器验收，待记录最终结果。

滚动复验修正：首轮展开因移除 Show 后动画从 0 高度起步，使页面总高度瞬间减少约 46px，浏览器在页尾收紧滚动范围。改为从 Show 原占用高度开始展开，且用 `getBoundingClientRect().height` 保留小数（避免 `offsetHeight` 取整残留 1px 偏移）；展开全程保持页面高度不减，无脚本强制滚动补偿。

最终独立验收七项全部通过：320/375/810/1440px 展开前、中、后 scrollY 变化均为 0px；四宽度 × 展开/收起共八组点线中心差 0px、接缝误差不超过 0.0005px；首尾终止正确。hover、focus、选择态、快速连点与减少动态效果均通过。收起中间帧有实际高度/透明度变化，完成后隐藏旧版区、焦点回 Show。桌面与移动最终、展开末端及动画中间帧截图均已目视通过，位于 `/tmp/onedrop-timeline-acceptance/v3-{final,expanded-end,midpoint}-{1440,375}.png`。目标文件格式检查与 `git diff --check` 通过。

## 展开残留高亮与标题返工

用户反馈：展开后 v1.1.2 节点一直保持悬浮态；标题不要三段式，直接 Release notes。

修复：展开/收起临时焦点转移到稳定时间线容器，不再聚焦第三个版本；节点焦点样式仅由 `:focus-visible` 触发。展开不改变选中版本，真实 hover 与键盘选择保留。标题改为唯一 `h2`“Release notes”，删除 eyebrow、副文案及其专属 CSS，预览 Draft 标记保留。

复验要求：真实鼠标点击展开后静置超过 500ms，v1.1.2 未hover且未选中时保持普通节点；真实 hover 与键盘焦点仍有效；四宽度展开 scrollY 保持 0 变化。等待独立复验。

最终独立复验通过：四宽度真实点击 Show 后静置 650ms，不移动鼠标或键盘，第三条节点为普通白/灰点、无外环、无焦点且未选中；焦点位于 timeline，默认选中 1.2.0 不变。展开前、逐帧、结束后的 scrollY 变化均为 0px。Tab 进入版本按钮、Enter 选择及真实 hover 均正常。标题唯一 Release notes。桌面/移动截图 `/tmp/onedrop-timeline-acceptance/v4-final-{1440,375}.png` 已目视通过。

## 正式接入与发布授权

用户明确授权：“可以了，把这个 Release notes 时间线正式加到官网并发布吧”。当前阶段由执行者接入源码、主代理负责后续提交和发布。

最终范围：`docs/index.html` 接入用户确认的八版静态时间线、节点选择/hover、无跳动展开及收起动画，移除 Get started；保留正式首页标题、描述、资源路径和实时 apps.json，删除 Draft 标记。未增加自动化版本数据系统。已读 Taste 技能并按“已选方向的单节接入”保留现有蓝色品牌与已确认点线/柔环/字号，不重新设计。临时预览完整迁移至 `/tmp/onedrop-release-timeline-preview-final/`，不纳入提交。

新增 `tests/unit/website-release-notes.test.ts` 的三项有意义回归：真实版本顺序/初始折叠；展开的稳定容器焦点、小数占位高度、重复激活、底部 Hide 与收起；版本选择/独立 Release 链接/减少动态效果。原安装区测试与脚本顺序保持不变。两文件共 10 项通过；全仓 lint、format 检查通过。compile 首次发现新测试的严格数组索引检查，补充已知存在断言后通过。

正在对正式 docs 页面独立验收，发布结果待主代理补充。

Taste 诊断已运行（报告 `/tmp/onedrop-release-taste/report.json`），1440/768/390px 页面截图已目视。通用规则报出既有品牌的 hairline、shadow、eyebrow、emoji、gradient、glass、outlined-box，以及 micro-label、button-fx、icon-cards、body-size、still-page、headline-lines；警告 size-count、grey-body、no-footage、small-text。按用户已确认设计与单节接入范围保留：细线节点和柔环是明确需求，14px 摘要与紧凑分类是已确认效果；其余属原官网视觉或全站装饰/动画配额，不为满足通用风格计数改动既有首页。此次没有宣称 Taste 无条件通过。正式时间线可读、无可见错位；实际交互与响应式由独立验收覆盖。

正式接入独立验收通过：移除 Draft 后 section 内容与最终预览一致，时间线末段 JS 逐字一致；10 项针对测试通过。实际 docs 首页在四宽度真实展开并静置 650ms，scrollY 全程变化 0px，第三节点无残留高亮；八组点线中心误差 0px、接缝误差不超过 0.0005px。减少动态效果、原安装区复制、正式 IPA 链接和指南按钮回归通过。生产桌面/手机截图 `/tmp/onedrop-timeline-acceptance/production-{1440,375}.png` 已由独立验收员目视通过。源码已具备提交与发布条件，等待主代理执行发布并补充线上结果。

## 发布结果

2026-11-24，PR [#47](https://github.com/zixu0779/OneDrop/pull/47) 的 CI 与 Android 检查通过后合并，官网部署提交为 `c71746469c66925e2b5a678519704569e4449452`，GitHub Pages 构建成功。正式入口：https://onedrop.sycamore.top/#updates。

线上独立验收使用真实官网与源数据：桌面/移动展开逐帧滚动变化为 0px，静置 650ms 后第三节点无残留高亮；展开动画、底部 Hide、收起焦点、选择与 hover 正常。源链接真实剪贴板正确，正式 IPA 直链 HTTP 200。Draft 和 Get started 均不存在。截图 `/tmp/onedrop-timeline-acceptance/published-{1440,375}.png` 已目视复核。

确认全部代码已合入且工作区无待保留变更后，已删除本地与远程 `feat/website-release-notes` 分支。临时验收浏览器及 8766/8767 服务已关闭。本次仅发布官网，未发布安装包或提交 Edge 商店审核。
