import { describe, it } from "vitest";

describe("RouterAvatar", () => {
  it.todo("画的是嫩芽铃；按 size 换成 rem，透明底，aria-hidden，不设 --fruit、--jelly");
  it.todo("working 时带左右摇的动画标记，空闲时没有；减弱动态效果时样式表不播");
  it.todo("左栏宽栏、窄栏、手机列表、Router 顶栏、时间流、空状态都用它，页面里不再出现 KnifeAvatar");
});

describe("GateMark", () => {
  it.todo("等你拍板的那一步在果皮轨和放大全览里显示小铃 GateMark，aria-hidden");
  it.todo("拍板通过后标记收起，这一步变回普通的果皮轨单行");
});

describe("任务进度图标", () => {
  it.todo("taskProgressPaths：做完、在干、等你拍板、等项目经理、没轮到各用对应的颜色，跳过和没轮到只留轮廓");
  it.todo("taskProgressPaths：同一连通子图同层并行的步骤并排分一块，不同子图不相连");
  it.todo("taskProgressPaths：1 步到 40 步都画在 10×10 格内，坐标没有 NaN");
  it.todo("TaskProgressIcon 按 color 取色，size 换成 rem，aria-hidden；右栏、放大全览、Completed 都用它，不再出现 SliceWheelIcon");
});

describe("Avatar 按形象画", () => {
  it.todo("look 换颜色后头像、Piece 分身、会话强调色、气泡底、果冻底一起换");
  it.todo("主形象按 opticalLiftOf 上移，耳朵伸出框外不被裁；Piece 分身上下居中");
  it.todo("Piece 分身（neutral）用的是 slimePaths(look, \"piece\")：换造型不变，换颜色才变");
  it.todo("同一个 look 重渲染时 memo 的头像不重画");
});

describe("SlimePicker", () => {
  it.todo("Fruit 一组 20 个造型都按当前颜色画，Color 一组列出全部颜色");
  it.todo("点一个造型只换造型、点一个颜色只换颜色，马上调 onChange，浮层不关");
  it.todo("选中的造型是果冻底，选中的颜色外面一圈中性细环，读屏用 aria-checked 读出选中");
  it.todo("方向键在格子里走、Enter 选中，Esc 关浮层");
  it.todo("保存失败时先显示的新形象退回原来的，浮层最下面一行写原因");
  it.todo("资料页头部的头像和新建项目经理弹窗里的头像都能点开它");
});

describe("左栏项目经理行", () => {
  it.todo("每行一样高：有没有预览、圆点、时间、设备名、归档天数都不改行高");
  it.todo("名字 text-title、600，没有预览的行名字仍在第一行的位置");
  it.todo("头像 48px，按 opticalLiftOf 上移；窄栏的果冻方块里同样上移");
  it.todo("总助行和项目经理行同一套尺寸");
});

describe("聊天里的头像跟跳", () => {
  it.todo("项目经理在干活时，消息流里正在进行的那一轮开头的头像带在干活的动画标记");
  it.todo("已经结束的轮、更早的历史轮的头像都不动");
  it.todo("Piece 的对话里正在进行的那一轮，Piece 分身头像同样跟跳；收工后不动");
  it.todo("总助在执行时，时间流里执行中那一条的总助头像跟跳");
});

describe("任务图的果冻管道", () => {
  it.todo("果皮轨的轨道、分叉汇合由 tubePaths 画，状态点由 stepBeadPaths 画；轨道槽 <svg> 是 crispEdges，没有 <circle> 和曲线");
  it.todo("走通的管子用项目经理的描边、身体、浅色三层，没走通的是浅灰空管子");
  it.todo("放大全览的连线是正交的果冻管道加像素箭头，上游做完是灌满的管子，其余是空管子");
  it.todo("放大全览的节点卡左上角有步骤号角标：做完是项目经理的 blob、等你拍板是强调色、其余是灰");
});

describe("输入框", () => {
  it.todo("外框是 rounded-xl 的方框，聚焦时照旧只多一团光晕");
  it.todo("左边是 ComposerAdd，右边发送键是圆角方块里的 ComposerSend；输入框里没有像素图标");
  it.todo("单行、多行两种布局切换时文字区是同一个节点，焦点和光标不丢");
});
