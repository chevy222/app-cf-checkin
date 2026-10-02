import { escapeHtml } from "../core/text.js";
import { VERSION } from "../version.js";

const CSS = `
:root{color-scheme:light dark;
  --bg:#f6f7f9;--panel:#fff;--panel2:#fafbfc;--panel3:#f1f3f6;
  --line:#e8eaee;--line2:#dfe2e7;--text:#1a1e24;--muted:#67707b;--faint:#98a1ab;
  --accent:#c9551d;--accent-weak:#fbeee6;
  --ok:#1c7f47;--ok-bg:#e7f5ed;--info:#2b62d9;--info-bg:#e9f0fd;
  --warn:#96590a;--warn-bg:#fbf1df;--bad:#ad232c;--bad-bg:#fbe9ea;
  --neu:#5a636e;--neu-bg:#edeff1;--teal:#0f6f72;--teal-bg:#e4f2f2;
  --radius:13px;--radius-sm:8px;--shadow:0 1px 2px rgba(22,24,32,.06),0 10px 26px -14px rgba(22,24,32,.16)}
@media (prefers-color-scheme:dark){:root{color-scheme:light dark;
  --bg:#111418;--panel:#191d22;--panel2:#1d2228;--panel3:#23282f;
  --line:#2a3138;--line2:#39424c;--text:#e5e9ee;--muted:#97a1ad;--faint:#6d7783;
  --accent:#f08a4b;--accent-weak:#2b1d15;
  --ok:#4ec389;--ok-bg:#152a1f;--info:#6ea3ff;--info-bg:#152033;
  --warn:#dfa254;--warn-bg:#2b2014;--bad:#f1787f;--bad-bg:#311719;
  --neu:#96a0ac;--neu-bg:#232930;--teal:#4fb2b6;--teal-bg:#12272a;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 12px 28px -18px rgba(0,0,0,.7)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);line-height:1.55;font-size:14px;
  font-family:ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:20px 18px 72px}
a{color:var(--accent)}
code,.mono,.num{font-family:ui-monospace,"Cascadia Mono",Consolas,"Sarasa Mono SC",monospace}
code{font-size:12px;background:var(--panel3);padding:1px 5px;border-radius:4px}
.num{font-size:12.5px;white-space:nowrap}
.dim{color:var(--faint)}
.top{display:flex;align-items:center;gap:16px;background:var(--panel);border:1px solid var(--line);
  border-radius:var(--radius);padding:11px 15px;box-shadow:var(--shadow);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:15px;text-decoration:none;color:var(--text)}
.brand .mark{width:22px;height:22px;border-radius:6px;background:var(--accent);color:#fff;display:grid;
  place-items:center;font-size:12px;font-weight:700}
.nav{display:flex;gap:2px}
.nav a{color:var(--muted);text-decoration:none;padding:6px 12px;border-radius:var(--radius-sm);font-size:13.5px}
.nav a:hover{background:var(--panel3);color:var(--text)}
.nav a.on{background:var(--accent-weak);color:var(--accent);font-weight:600}
.top .right{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--faint);font-size:12.5px}
.h{display:flex;align-items:center;gap:10px;margin:22px 0 10px;flex-wrap:wrap}
h2{margin:0;font-size:17px;font-weight:650;letter-spacing:-.2px}
.sub{color:var(--muted);font-size:12.5px}
.spacer{margin-left:auto}
.grid{display:grid;gap:12px}
.grid.cols3{grid-template-columns:repeat(auto-fit,minmax(290px,1fr))}
.split{display:grid;grid-template-columns:minmax(0,340px) minmax(0,1fr);gap:14px;align-items:start}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);overflow:hidden;transition:border-color .15s}
/* 悬停微反馈：边框亮一档就够，不加位移和阴影变化 —— 卡片是信息容器，不是按钮 */
.card:hover{border-color:var(--line2)}
.card .hd{display:flex;align-items:center;gap:10px;padding:16px 16px 0}
.card .hd .id{display:flex;align-items:center;gap:9px;min-width:0}
.card .hd .t{font-weight:650;font-size:14.5px}
/* 描述不截断的话，长一点就会把「管理 ›」挤出卡片（.hd 不换行）。
   包名字和描述的那层 div 也要 min-width:0，否则 flex 子项不肯缩 */
.card .hd .id > div{min-width:0}
.card .hd .d{color:var(--faint);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 只作用于文字链接（如「管理 ›」）：这条规则的优先级高于 .btn.pri，
   不收窄会把卡片头里主按钮的白字覆盖成橙色 —— 橙底橙字，文字隐形 */
.card .hd a:not(.btn){margin-left:auto;color:var(--accent);text-decoration:none;font-size:12.5px}
.card .hd a:not(.btn):hover{text-decoration:underline}
/* 图标是内联 data URI（见 icons.js 的理由：必须在口令闸后）。64×64 缩到 22px，
   交给浏览器双线性插值；只做圆角与去白边，不加滤镜 —— 图标是配角。 */
.ico{width:22px;height:22px;border-radius:5px;flex:none;display:block}
.card .bd{padding:14px 16px 18px}
.pane{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:16px 18px;box-shadow:var(--shadow)}
.alert{display:flex;gap:8px;align-items:flex-start;padding:11px 16px;font-size:12.5px;line-height:1.45}
.alert.bad{background:var(--bad-bg);color:var(--bad)}
.alert.warn{background:var(--warn-bg);color:var(--warn)}
.alert.info{background:var(--info-bg);color:var(--info)}
.alert svg{flex:none;margin-top:1px}
.alert a{color:inherit;text-decoration:underline}
.badge{display:inline-flex;align-items:center;gap:5px;padding:2.5px 8px 2.5px 6px;border-radius:7px;
  font-size:12px;font-weight:600;white-space:nowrap;line-height:1.5}
.badge svg{width:12px;height:12px;flex:none}
.b-claimed,.b-ok{background:var(--ok-bg);color:var(--ok)}
.b-already{background:var(--teal-bg);color:var(--teal)}
.b-inactive,.b-skipped{background:var(--neu-bg);color:var(--neu)}
.b-pending,.b-partial,.b-rate{background:var(--warn-bg);color:var(--warn)}
.b-defer,.b-wait{background:var(--info-bg);color:var(--info)}
.b-login,.b-error{background:var(--bad-bg);color:var(--bad)}
.btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;padding:6px 13px;
  border-radius:var(--radius-sm);border:1px solid var(--line2);background:var(--panel);color:var(--text);
  cursor:pointer;white-space:nowrap;text-decoration:none}
.btn:hover{background:var(--panel3)}
.btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.ghost{border-color:transparent;color:var(--accent);background:transparent;padding:6px 8px}
.btn.ghost:hover{background:var(--accent-weak)}
.btn.danger{color:var(--bad);background:transparent}
.btn.danger:hover{background:var(--bad-bg);border-color:var(--bad)}
.btn.sm{font-size:11.5px;padding:3px 9px}
.acts{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap}
.tw{overflow-x:auto;border-radius:var(--radius)}
table.t{width:100%;min-width:640px;border-collapse:collapse;background:var(--panel);font-size:13px}
table.t th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;letter-spacing:.3px;
  padding:11px 13px;background:var(--panel2);border-bottom:1px solid var(--line);white-space:nowrap}
table.t td{padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:middle}
table.t tr:last-child td{border-bottom:0}
.kv{display:flex;justify-content:space-between;gap:12px;padding:7px 0;font-size:13px;border-top:1px dashed var(--line)}
.kv:first-of-type{border-top:0}
/* 首页卡片的 .bd 以进度条开头 —— 它和 .kv 同为 div，:first-of-type 命中的是
   .prog 而不是第一条 .kv，上面的规则在首页从来没生效过。用相邻选择器直接表达：
   进度条自带下边距，紧跟的行不需要再来一道虚线。 */
.prog + .kv{border-top:0}
.kv .k{color:var(--muted)}
.kv .v{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12.5px;text-align:right;overflow-wrap:anywhere}
/* .kv .k 里带图标时必须显式 flex：.ico 是 display:block（为了不占基线下的空隙），
   不套 flex 它就会竖在文字上方，而不是像设计稿那样排在名字左边。 */
.kv .k:has(.ico){display:flex;align-items:center;gap:9px}
.field{margin:0 0 15px}
.field label{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;margin-bottom:5px;flex-wrap:wrap}
.field .help{color:var(--muted);font-weight:400;font-size:12px;margin-top:4px;line-height:1.45}
.field input,.field textarea,.field select{width:100%;font:inherit;font-size:13px;padding:7px 10px;
  border:1px solid var(--line2);border-radius:var(--radius-sm);background:var(--panel);color:var(--text)}
.field textarea{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px;min-height:88px;
  resize:vertical;line-height:1.5}
.field input:focus,.field textarea:focus,.field select:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-weak)}
.field.bad input,.field.bad textarea,.field.bad select{border-color:var(--bad)}
.err{color:var(--bad);font-size:12px;margin-top:4px}
.req{color:var(--bad)}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1.5px 7px;border-radius:99px;
  background:var(--accent-weak);color:var(--accent);font-weight:600}
.chip.off{background:var(--warn-bg);color:var(--warn)}
/* 工具开关（拨动式）。拨杆是一个提交按钮：checkbox 点了只会打勾、不会提交表单，
   零 JS 下它永远发不出请求。状态由服务端渲染成 .on —— 运行中亮绿、滑块靠右；
   停用变灰、滑块靠左。点一下 = 提交 = 翻转，aria-pressed 交给读屏软件。
   滑块 top:50% + margin-top:-7.5px 垂直居中（15px 的一半，写 -9 会偏上）；
   水平行程 17px：轨道总宽 38（含两边边框），滑块 15，两端各留 2px。 */
.sw{display:inline-flex;align-items:center;margin:0}
.sw-b{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;gap:8px;
  position:relative;background:none;border:0;padding:0;cursor:pointer;
  font-size:12.5px;color:var(--muted);user-select:none}
.sw-b::before{content:"";width:38px;height:21px;border-radius:99px;flex:none;
  background:var(--panel3);border:1px solid var(--line2);transition:background .15s}
.sw-b::after{content:"";position:absolute;left:3px;top:50%;margin-top:-7.5px;
  width:15px;height:15px;border-radius:99px;background:var(--panel);
  box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .15s}
.sw-b.on::before{background:var(--ok);border-color:var(--ok)}
.sw-b.on::after{transform:translateX(17px)}
.sw-b.on .sw-t{color:var(--ok);font-weight:600}
.sw-b:focus-visible::before{box-shadow:0 0 0 3px var(--accent-weak)}
.sw-t{white-space:nowrap}
/* 首页卡片里这些行的值都短（徽章、时间、数字、拨杆），窄屏也不许跟着 .kv 竖排：
   标签在左、值靠右，跟宽屏一个样。长值的行（日志详情的键名、说明页清单）仍走竖排。 */
.kv.kv-row{flex-direction:row;justify-content:space-between;align-items:center}
.kv.kv-row .v{text-align:right}
/* 工具卡片的账号进度条。一格一个账号：done 已结、bad 待处理、wait 顺延/限频。
   <i> 是空元素，没有显式宽高就是 0×0 —— 整条进度条会什么都不剩。 */
.prog{display:flex;gap:3px;align-items:center;margin:2px 0 9px;flex-wrap:wrap}
.prog i{width:16px;height:5px;border-radius:99px;background:var(--panel3);flex:none}
.prog i.done{background:var(--ok)}
.prog i.bad{background:var(--bad)}
.prog i.wait{background:var(--warn)}
.prog .n{font-size:12px;color:var(--muted);margin-left:6px}
/* 工具管理页「步骤」列的色块。这套类一直在 pages/tool.js 里被渲染，却从没进过本文件 ——
   <i> 是空元素，没有显式宽高就是 0×0，整列什么都看不见，而且挂在 0×0 元素上的
   title 也没有悬停面积，等于"悬停看每一步处置"这句话是假的。
   与 .prog 同一个形状，只是多两种状态（skip=未开始、bad=失败）。 */
.steps{display:flex;gap:3px;align-items:center;flex-wrap:wrap}
.steps i{width:14px;height:5px;border-radius:99px;background:var(--panel3);flex:none;cursor:help}
.steps i.ok{background:var(--ok)}
.steps i.wait{background:var(--warn)}
.steps i.skip{background:var(--neu)}
.steps i.bad{background:var(--bad)}
.note{font-size:11.5px;color:var(--muted);margin-top:4px}
/* 账号列：名字与备注名左右排布；min-width:0 是 flex 子项能省略号收窄的前提 */
.acc{display:flex;align-items:center;gap:6px;min-width:0}
.acc .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
/* 最近运行流。显式 flex 不是为了好看：<a> 默认是行内元素，不写这一条
   N 条记录会首尾相连成一段文字。who 固定宽 + 省略号，m 吃掉剩余空间，
   时间戳因此在每一行的同一列对齐。 */
.flowitem{display:flex;gap:9px;align-items:center;padding:8px 0;text-decoration:none;color:inherit;
  border-top:1px solid var(--line);font-size:13px}
.flowitem:first-child{border-top:0}
.flowitem:hover{background:var(--panel2)}
.flowitem .who{flex:none;width:96px;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:12px;color:var(--muted)}
.flowitem .m{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12.5px;color:var(--muted)}
.flowitem .when{flex:none;font-size:11.5px;color:var(--faint);white-space:nowrap}
/* 参数获取教程。内容来自 tools 侧的数据，排版只这一份（见 tutorials.js 的说明）。 */
.tutbox{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel2);
  padding:14px 16px;margin-bottom:16px}
.tut-intro{font-size:12.5px;line-height:1.6;color:var(--muted);margin-bottom:12px}
.tut{margin-bottom:12px}
.tut:last-child{margin-bottom:0}
.tut-h{display:flex;align-items:flex-start;gap:8px;font-size:13px;font-weight:650;line-height:1.5}
.tut-n{flex:none;width:18px;height:18px;border-radius:50%;background:var(--accent-weak);
  color:var(--accent);font-size:11px;display:grid;place-items:center;margin-top:1px}
.tut-b{font-size:12.5px;line-height:1.6;color:var(--muted);margin:6px 0 0 26px}
/* user-select:all = **点一下整段全选**。这是零 JS 下能做到的最接近"一键复制"的形态：
   script 被 CSP 的 default-src 'none' 挡死，复制按钮做不出来，而这几个脚本都是
   整段粘进 PowerShell 用的，本来也不需要只选其中几行。 */
.tut-c{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.5px;line-height:1.5;
  background:var(--panel3);border:1px solid var(--line);border-radius:var(--radius-sm);
  padding:10px 12px;margin:8px 0 0 26px;overflow-x:auto;white-space:pre;
  color:var(--text);max-height:340px;overflow-y:auto;
  user-select:all;-webkit-user-select:all;cursor:text}
.tut-c code{background:none;padding:0;font-size:inherit}
.tutbox .alert{margin:8px 0 0 26px;font-size:12px}
.tutbox .tw{margin:8px 0 0 26px}
.cmdbox{display:flex;gap:8px;align-items:center;background:var(--panel3);border:1px solid var(--line);
  border-radius:var(--radius-sm);padding:8px 10px;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:11.5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.tiny{color:var(--faint);font-size:11.5px}
/* 一组小工具类：各页面反复内联的那几行样式收进来（CSP 已放行内联，纯为一致性）。
   边距口径归一：上边距一律 .mt=12px，下边距用 .mb（10px）。
   恢复正常换行叫 .flow 而不是 .wrap —— .wrap 已是页面容器（max-width 那条），同名会互相误伤。 */
.m0{margin:0}
.mt{margin-top:12px}
.mb{margin:0 0 10px}
.flush{padding-top:0}
th.r,td.r{text-align:right}
.cap{font-size:14.5px;font-weight:650}
.over{color:var(--bad)}
.card .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pre{white-space:pre-wrap;word-break:break-all}
.center{justify-content:center}
.tc{text-align:center}
.flow{white-space:normal}
/* 管理页卡片头右侧的按钮组：margin-left:auto 顶到右边 */
.card .hd .acts{margin-left:auto;gap:8px}
.login{max-width:330px;margin:48px auto;text-align:center}
.login .lock{width:44px;height:44px;border-radius:12px;background:var(--panel3);color:var(--muted);
  display:grid;place-items:center;margin:0 auto 14px}
.login h1{font-size:16px;margin:0 0 4px}
.login p{color:var(--muted);font-size:12.5px;margin:0 0 16px}
.login .row{display:flex;gap:8px}
.login input{flex:1;font-family:ui-monospace,monospace;text-align:center;font-size:14px;padding:9px 11px;
  border:1px solid var(--line2);border-radius:var(--radius-sm);background:var(--panel);color:var(--text)}
.empty{text-align:center;padding:30px 20px}
.empty .mark{width:44px;height:44px;border-radius:12px;background:var(--panel3);color:var(--muted);
  display:grid;place-items:center;margin:0 auto 12px}
.ft{margin-top:28px;text-align:center;color:var(--faint);font-size:11.5px}
.ft a{color:var(--faint);text-decoration:none}
.ft a:hover{color:var(--accent)}
.ft .sep{margin:0 7px}
/* 窄屏适配。移动端的问题不是"缩小"，而是"换结构"：
   · 导航横排 5 项在 360px 一定放不下 —— 折行会把「总览」拆成两字，
     所以改成整条横向滚动，位置永远在第一项。
   · 表格 min-width 640px 在窄屏必然横向溢出，滑动能看全但看不出"这是列表"，
     所以窄屏下改成卡片式堆叠：每行一张卡，字段名靠 data-label 显示。
   · 筛选按钮组与操作按钮组在窄屏占满整行，避免挤成两半。 */
@media (max-width:720px){
  .wrap{padding:14px 12px 56px}
  .top{padding:10px 12px;gap:10px}
  .brand{font-size:14.5px}
  /* 整条可横向滚，且不换行 —— nav 自身不能 wrap，否则「总览」会被折断 */
  .nav{flex:1 1 100%;overflow-x:auto;flex-wrap:nowrap;-webkit-overflow-scrolling:touch;
    scrollbar-width:none;padding-bottom:1px}
  .nav::-webkit-scrollbar{display:none}
  .nav a{flex:none;padding:6px 10px;font-size:13px}
  .top .right{flex:1 1 100%;margin-left:0;justify-content:flex-end}
  .h{margin:18px 0 8px}
  h2{font-size:16px}
  .sub{font-size:12px}
  /* 筛选栏在窄屏独占一行，.spacer 的 margin-left:auto 会把它推偏 */
  .h .acts{width:100%;justify-content:flex-start}
  .grid.cols3{grid-template-columns:1fr}
  .tutbox{padding:12px 12px}
  .tut-b,.tut-c,.tutbox .alert,.tutbox .tw{margin-left:0}
  .field textarea{min-height:120px}
  .card .hd,.card .bd,.pane{padding-left:13px;padding-right:13px}
  /* 管理页卡片头在窄屏换行：标题一行、按钮组一行，标题不再被两个按钮挤没 */
  .card .hd{flex-wrap:wrap}
  .card .hd .acts{flex:1 1 100%}
  /* 运行流在窄屏太挤：who 缩窄、时间戳降一档，把宽度让给摘要 */
  .flowitem .who{width:72px}
  .flowitem .when{font-size:10.5px}
  .kv{flex-direction:column;gap:2px}
  .kv .v{text-align:left}
  .login{max-width:none;margin:36px 16px}
}

/* 窄屏表格 → 卡片。给每格加 data-label（见各页面的 <td>），
   由 CSS 生成字段名，所以表格在宽屏上仍然是真表格（有语义、能横向滚）。 */
@media (max-width:720px){
  .tw{overflow-x:visible;border-radius:0}
  table.t{min-width:0;display:block}
  table.t thead{display:none}
  table.t tbody{display:block}
  table.t tr{display:block;background:var(--panel);border:1px solid var(--line);
    border-radius:var(--radius);margin:0 0 8px;padding:2px 0}
  table.t td{display:flex;align-items:baseline;gap:10px;border:0;padding:5px 12px;text-align:left}
  table.t td::before{content:attr(data-label);flex:none;width:4.5em;color:var(--muted);
    font-size:11.5px;font-weight:600}
  table.t td:empty{display:none}
  /* 操作列（详情/执行/删除）没有字段名，data-label 是空串。
     宽度给 0 + 不显示 ::before，否则会留一块 4.5em 的空白，
     而这一格里的按钮本来就是靠右对齐的独立操作区。 */
  table.t td[data-label=""]{padding-left:12px;padding-right:12px}
  table.t td[data-label=""]::before{content:none;width:0}
  /* 窄屏下操作按钮独占一行靠右：挤在字段名后面会显得像某个字段的值 */
  table.t td[data-label=""] .acts{width:100%;justify-content:flex-end}
  /* 结果徽章与积分这类「值」跟在字段名后面，不再独占一行 */
  table.t td .badge{font-size:11.5px}
  .num{white-space:normal}
}
@media (max-width:860px){.split{grid-template-columns:1fr}}
`;

const SPRITE = `
<svg style="display:none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<symbol id="g-check" viewBox="0 0 16 16"><path d="M3 8.4l3.2 3.2L13 4.6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-loop" viewBox="0 0 16 16"><path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.85" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M13.4 2.3v2.7h-2.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-dot" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.1" fill="currentColor"/></symbol>
<symbol id="g-ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="2.9 2.4"/></symbol>
<symbol id="g-clock" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.1" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4.9v3.3l2.3 1.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="g-half" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 3a5 5 0 0 1 0 10z" fill="currentColor"/></symbol>
<symbol id="g-skip" viewBox="0 0 16 16"><path d="M3.6 3.8l5 4.2-5 4.2M11.8 3.8v8.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-tri" viewBox="0 0 16 16"><path d="M8 2.3l6.1 11.2H1.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 6.2v3.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.5" r=".95" fill="currentColor"/></symbol>
<symbol id="g-lock" viewBox="0 0 16 16"><rect x="3.2" y="6.9" width="9.6" height="6.9" rx="1.7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.6 6.9V5.1a2.4 2.4 0 0 1 4.8 0v1.8" fill="none" stroke="currentColor" stroke-width="1.8"/></symbol>
<symbol id="g-down" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.1" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 5v4.4M5.7 7.2L8 9.5l2.3-2.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-oct" viewBox="0 0 16 16"><path d="M5.5 1.9h5L14.1 5.5v5L10.5 14.1h-5L1.9 10.5v-5z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4.8v3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="10.8" r=".95" fill="currentColor"/></symbol>
<symbol id="g-key" viewBox="0 0 16 16"><circle cx="5.4" cy="5.4" r="3.1" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M7.6 7.6l5.1 5.1M10.4 9.6l1.6 1.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
<symbol id="g-hour" viewBox="0 0 16 16"><path d="M4.6 2.2h6.8M4.6 13.8h6.8M5.4 2.2c0 2.5 2.6 3.4 2.6 5.8s-2.6 3.3-2.6 5.8M10.6 2.2c0 2.5-2.6 3.4-2.6 5.8s2.6 3.3 2.6 5.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</svg>`;

// 全站唯一的状态词汇。形状 + 颜色 + 中文三重冗余，去掉颜色也读得懂。
export const STATUS = {
  claimed: { label: "成功领取", glyph: "g-check" },
  already: { label: "今日已领", glyph: "g-loop" },
  ok: { label: "正常", glyph: "g-dot" },
  inactive: { label: "活动未开", glyph: "g-ring" },
  pending: { label: "待下发", glyph: "g-clock" },
  waiting: { label: "等待中", glyph: "g-hour" },
  partial: { label: "部分完成", glyph: "g-half" },
  skipped: { label: "未开始", glyph: "g-skip" },
  rate_limited: { label: "限频", glyph: "g-tri" },
  login_required: { label: "需重新登录", glyph: "g-lock" },
  deferred: { label: "顺延", glyph: "g-down" },
  error: { label: "失败", glyph: "g-oct" },
};

export function statusInfo(status) {
  return STATUS[status] || { label: status || "未知", glyph: "g-oct" };
}

// 界面内部用的链接：自动带上访问口令，这样点链接不需要手敲 pwd。
// 口令本身永远不出现在任何可见文本里，只在 href 中。
export function link(path, pwd, extra) {
  const url = new URL(path, "https://app.invalid");
  if (pwd) url.searchParams.set("pwd", pwd);
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  return url.pathname + url.search;
}

export function pageShell({ title, pwd, nav = "", body }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${SPRITE}
<div class="wrap">
  <div class="top">
    <a class="brand" href="${link("/", pwd)}"><span class="mark">签</span>签到台</a>
    <nav class="nav">${nav}</nav>
    <div class="right"><span class="tiny">口令已随链接携带</span></div>
  </div>
  ${body}
  <footer class="ft">${VERSION}<span class="sep">·</span><a href="https://github.com/chevy222/app-cf-checkin" target="_blank" rel="noopener">Powered by GitHub</a></footer>
</div></body></html>`;
}

export function navHtml(pwd, active, tools) {
  const item = (href, text, key) => `<a class="${key === active ? "on" : ""}" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  const links = tools.map((tool) => item(link(`/tool/${tool.id}`, pwd), tool.name, `tool:${tool.id}`));
  return item(link("/", pwd), "总览", "home") + links.join("") + item(link("/help", pwd), "说明", "help");
}