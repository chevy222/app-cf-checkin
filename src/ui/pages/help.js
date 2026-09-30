import { escapeHtml } from "../../core/text.js";
import { link, navHtml, pageShell, STATUS } from "../layout.js";
import { glyph, sectionHead } from "../components.js";

const STAGES = [
  { n: 1, name: "骨架", done: true, text: "密码闸 · 路由 · 安全头 · KV 读写 · 注册表 · schema 驱动的表单与账号增删改查" },
  { n: 2, name: "会跑", done: true, text: "到期队列 · (账号×步骤) 预算 · 断点续跑 · 逻辑日界 · 退避阶梯" },
  { n: 3, name: "会管", done: true, text: "运行日志列表与详情 · 「测试」「立即执行」按钮 · 空状态与红条细化" },
  { n: 4, name: "接三家", done: true, text: "三家模块已接入；用真实凭据各跑通一轮待验" },
  { n: 5, name: "收尾", done: false, text: "每工具停用开关（已完成）· 图标 · 中文 README · 停用旧 Worker" },
];

export function renderHelp({ pwd, tools }) {
  const stages = STAGES.map((stage) => `<div class="kv">
      <span class="k">阶段 ${stage.n} · ${escapeHtml(stage.name)}</span>
      <span class="v">${stage.done ? "已完成" : "待做"} — ${escapeHtml(stage.text)}</span>
    </div>`).join("");

  const statuses = Object.entries(STATUS).map(([key, info]) => `<div class="kv">
      <span class="k"><span class="badge b-${key === "rate_limited" ? "rate" : key === "login_required" ? "login" : key === "deferred" ? "defer" : key === "already" ? "already" : key === "inactive" || key === "skipped" ? "skipped" : key === "partial" || key === "pending" ? "partial" : key === "error" ? "error" : "ok"}">${glyph(info.glyph)}${escapeHtml(info.label)}</span></span>
      <span class="v dim">${escapeHtml(key)}</span>
    </div>`).join("");

  const toolsList = tools.map((tool) => `<div class="kv">
      <span class="k">${escapeHtml(tool.name)}</span>
      <span class="v">${escapeHtml(tool.id)} · ${tool.steps.length} 步 · 约 ${tool.steps.reduce((s, x) => s + x.cost, 0)} 子请求</span>
    </div>`).join("");

  return pageShell({
    title: "说明",
    nav: navHtml(pwd, "help", tools),
    body: sectionHead("这是什么")
      + `<div class="pane"><p class="sub" style="margin:0">一个可扩展的签到平台：内核不认识任何具体站点，
        每个工具是一个自包含模块，只声明字段、步骤与调度策略。加第 N 个工具不需要改内核、不需要写界面代码。</p></div>
      ${sectionHead("阶段进度")}
      <div class="pane">${stages}</div>
      ${sectionHead("已注册的工具")}
      <div class="pane">${toolsList}</div>
      ${sectionHead("停用某个工具")}
      <div class="pane"><p class="sub" style="margin:0 0 10px">总览页每张工具卡片上有一个独立开关，只停一家，不影响其它。</p>
        <p class="tiny" style="margin:0">停用后：cron 与「立即执行」都跳过它，别的工具照常；卡片变暗并显示停用时间，
        但「今日完成 / 最后结果 / 步骤色块」照常显示，方便你看出它停在哪一步。
        <b>账号、凭据与当天进度一条都不删</b> —— 重新打开就从停下的那一步接着做，已完成的那步不会重做
        （重做会真的再打一次上游，WorkBuddy 的开盲盒每调一次就扣 10 点能量）。
        停用中「执行」按钮隐藏，只保留「测试」「编辑」「删除」；直接敲 URL 也会被服务端拒绝。
        跨过当天的额度重置时刻（各家不同）再打开，则按新的那一天从头算，这是本来的行为。
        这里<b>没有</b>「全部停用」总开关。</p>
      </div>
      ${sectionHead("状态词汇表")}
      <div class="pane">${statuses}
        <p class="tiny" style="margin-top:12px">形状、颜色、中文三重冗余：去掉颜色只看形状也读得懂。只有挂锁与八边形需要你动手，其余都会自己好。</p>
      </div>
      ${sectionHead("几条硬规则")}
      <div class="pane"><p class="sub" style="margin:0">
        一、每个工具一个请求层，绝不共用 header 构造器 —— 三家的鉴权方案与 UA 互不相同，串味即事故。<br>
        二、出口域名白名单，请求只能打到自己家。<br>
        三、工具不许自己算「今天」，一律用内核注入的逻辑日（各家日界不同）。<br>
        四、每个步骤必须可安全重入，否则不许声明多步骤 —— 断点续跑靠的是服务端幂等。<br>
        五、敏感值只存 KV、只显示打码形式、永不进日志；访问口令只出现在链接里，不出现在任何可见文本。
      </p></div>`,
  });
}
