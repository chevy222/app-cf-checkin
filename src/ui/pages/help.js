import { escapeHtml } from "../../core/text.js";
import { link, navHtml, pageShell, STATUS } from "../layout.js";
import { glyph, infoClass, sectionHead } from "../components.js";
import { iconImg } from "../icons.js";

// 这页只写"怎么用"，不写开发进度 —— 进度信息会过期，而使用者要的是操作信息。
export function renderHelp({ pwd, tools }) {
  // 词汇表的配色与全站徽章同一份映射（components.js 的 infoClass）：
  // 这里曾自己写一段 if/else，把 waiting 配成了绿色（别处是蓝色）。
  const statuses = Object.entries(STATUS).map(([key, info]) => `<div class="kv">
      <span class="k"><span class="badge b-${infoClass(key)}">${glyph(info.glyph)}${escapeHtml(info.label)}</span></span>
      <span class="v dim">${escapeHtml(key)}</span>
    </div>`).join("");

  const toolsList = tools.map((tool) => `<div class="kv">
      <span class="k">${iconImg(tool, 18)}${escapeHtml(tool.name)}</span>
      <span class="v">${escapeHtml(tool.id)} · ${tool.steps.length} 步 · 约 ${tool.steps.reduce((s, x) => s + x.cost, 0)} 子请求</span>
    </div>`).join("");

  return pageShell({
    title: "说明",
    nav: navHtml(pwd, "help", tools),
    body: sectionHead("这是什么")
      + `<div class="pane"><p class="sub m0">一个可扩展的签到平台：内核不认识任何具体站点，
        每个工具是一个自包含模块，只声明字段、步骤与调度策略。加第 N 个工具不需要改内核、不需要写界面代码。</p></div>
      ${sectionHead("已注册的工具")}
      <div class="pane">${toolsList}</div>
      ${sectionHead("停用某个工具")}
      <div class="pane"><p class="sub mb">总览页每张工具卡片上有一个独立开关，只停一家，不影响其它。</p>
        <p class="tiny m0">停用后：cron 与「立即执行」都跳过它，别的工具照常；卡片变暗并显示停用时间，
        但「今日完成 / 最后结果 / 步骤色块」照常显示，方便你看出它停在哪一步。
        <b>账号、凭据与当天进度一条都不删</b> —— 重新打开就从停下的那一步接着做，已完成的那步不会重做
        （重做会真的再打一次上游，WorkBuddy 的开盲盒每调一次就扣 10 点能量）。
        停用中「执行」按钮隐藏，只保留「测试」「编辑」「删除」；直接敲 URL 也会被服务端拒绝。
        跨过当天的额度重置时刻（各家不同）再打开，则按新的那一天从头算，这是本来的行为。
        这里<b>没有</b>「全部停用」总开关。</p>
      </div>
      ${sectionHead("状态词汇表")}
      <div class="pane">${statuses}
        <p class="tiny mt">形状、颜色、中文三重冗余：去掉颜色只看形状也读得懂。只有挂锁与八边形需要你动手，其余都会自己好。</p>
      </div>
      ${sectionHead("几条硬规则")}
      <div class="pane"><p class="sub m0">
        一、每个工具一个请求层，绝不共用 header 构造器 —— 三家的鉴权方案与 UA 互不相同，串味即事故。<br>
        二、出口域名白名单，请求只能打到自己家。<br>
        三、工具不许自己算「今天」，一律用内核注入的逻辑日（各家日界不同）。<br>
        四、每个步骤必须可安全重入，否则不许声明多步骤 —— 断点续跑靠的是服务端幂等。<br>
        五、敏感值只存 KV、只显示打码形式、永不进日志；访问口令只出现在链接里，不出现在任何可见文本。
      </p></div>`,
  });
}
